import {spawn, Worker} from "threads";
// `threads` library creates self global variable which breaks `timeout-abort-controller` https://github.com/jacobheun/timeout-abort-controller/issues/9
// Don't add an eslint disable here as a reminder that this has to be fixed eventually
// eslint-disable-next-line
// @ts-ignore
// eslint-disable-next-line
self = undefined;
import {AbortSignal} from "@chainsafe/abort-controller";
import {bls, Implementation, PointFormat} from "@chainsafe/bls";
import {ILogger} from "@chainsafe/lodestar-utils";
import {QueueError, QueueErrorCode} from "../../../util/queue";
import {IMetrics} from "../../../metrics";
import {IBlsVerifier, VerifySignatureOpts} from "../interface";
import {BlsWorkReq, BlsWorkResult, WorkerData, WorkResultCode} from "./types";
import {chunkifyMaximizeChunkSize, getDefaultPoolSize} from "./utils";
import {ISignatureSet} from "@chainsafe/lodestar-beacon-state-transition/src";
import {getAggregatedPubkey} from "../utils";

export type BlsMultiThreadWorkerPoolModules = {
  logger: ILogger;
  metrics: IMetrics | null;
  signal: AbortSignal;
};

/**
 * Split big signature sets into smaller sets so they can be sent to multiple workers.
 *
 * The biggest sets happen during sync, on mainnet batches of 64 blocks have around ~8000 signatures.
 * The latency cost of sending the job to and from the worker is aprox a single sig verification.
 * If you split a big signature into 2, the extra time cost is `(2+2N)/(1+2N)`.
 * For 128, the extra time cost is about 0.3%. No specific reasoning for `128`, it's just good enough.
 */
const MAX_SIGNATURE_SETS_PER_JOB = 128;

/**
 * If there are more than `MAX_BUFFERED_SIGS` buffered sigs, verify them immediatelly without waiting `MAX_BUFFER_WAIT_MS`.
 *
 * The efficency improvement of batching sets asymptotically reaches x2. However, for batching large sets
 * has more risk in case a signature is invalid, requiring to revalidate all sets in the batch. 32 is sweet
 * point for this tradeoff.
 */
const MAX_BUFFERED_SIGS = 32;
/**
 * Gossip objects usually come in bursts. Buffering them for a short period of time allows to increase batching
 * efficieny, at the cost of delaying validation. Unless running in production shows otherwise, it's not critical
 * to hold attestations and aggregates for 100ms. Lodestar existing queues may hold those objects for much more anyway.
 *
 * There's no exact reasoning for the `100` miliseconds number. The metric `batchSigsSuccess` should indicate if this
 * value needs revision
 */
const MAX_BUFFER_WAIT_MS = 100;

type WorkerApi = {
  verifyManySignatureSets(workReqArr: BlsWorkReq[]): Promise<BlsWorkResult>;
};

type JobQueueItem<R = boolean> = {
  resolve: (result: R | PromiseLike<R>) => void;
  reject: (error?: Error) => void;
  addedTimeMs: number;
  workReq: BlsWorkReq;
};

enum WorkerStatusCode {
  notInitialized,
  initializing,
  initializationError,
  idle,
  running,
}

type WorkerStatus =
  | {code: WorkerStatusCode.notInitialized}
  | {code: WorkerStatusCode.initializing; initPromise: Promise<WorkerApi>}
  | {code: WorkerStatusCode.initializationError; error: Error}
  | {code: WorkerStatusCode.idle; workerApi: WorkerApi}
  | {code: WorkerStatusCode.running; workerApi: WorkerApi};

type WorkerDescriptor = {
  worker: Worker;
  status: WorkerStatus;
};

/**
 * Wraps "threads" library thread pool queue system with the goals:
 * - Complete total outstanding jobs in total minimum time possible.
 *   Will split large signature sets into smaller sets and send to different workers
 * - Reduce the latency cost for small signature sets. In NodeJS 12,14 worker <-> main thread
 *   communiction has very high latency, of around ~5 ms. So package multiple small signature
 *   sets into packages of work and send at once to a worker to distribute the latency cost
 */
export class BlsMultiThreadWorkerPool implements IBlsVerifier {
  private readonly logger: ILogger;
  private readonly metrics: IMetrics | null;
  private readonly signal: AbortSignal;

  private readonly format: PointFormat;
  private readonly workers: WorkerDescriptor[];
  private readonly jobs: JobQueueItem[] = [];
  private bufferedJobs: {
    jobs: JobQueueItem[];
    sigCount: number;
    firstPush: number;
    timeout: NodeJS.Timeout;
  } | null = null;

  constructor(modules: BlsMultiThreadWorkerPoolModules) {
    const {logger, metrics, signal} = modules;
    this.logger = logger;
    this.metrics = metrics;
    this.signal = signal;

    // TODO: Allow to customize implementation
    const implementation = bls.implementation;

    // Use compressed for herumi for now.
    // THe worker is not able to deserialize from uncompressed
    // `Error: err _wrapDeserialize`
    this.format = implementation === "blst-native" ? PointFormat.uncompressed : PointFormat.compressed;
    this.workers = this.createWorkers(implementation, getDefaultPoolSize());

    this.signal.addEventListener(
      "abort",
      () => {
        this.abortAllJobs();
        this.terminateAllWorkers();
        if (this.bufferedJobs) clearTimeout(this.bufferedJobs.timeout);
      },
      {once: true}
    );

    if (metrics) {
      metrics.blsThreadPool.queueLength.addCollect(() => metrics.blsThreadPool.queueLength.set(this.jobs.length));
    }
  }

  async verifySignatureSets(sets: ISignatureSet[], opts: VerifySignatureOpts = {}): Promise<boolean> {
    // Split large array of sets into smaller.
    // Very helpful when syncing finalized, sync may submit +1000 sets so chunkify allows to distribute to many workers
    const results = await Promise.all(
      chunkifyMaximizeChunkSize(sets, MAX_SIGNATURE_SETS_PER_JOB).map((setsWorker) =>
        this.queueBlsWork({
          opts,
          sets: setsWorker.map((s) => ({
            publicKey: getAggregatedPubkey(s).toBytes(this.format),
            message: s.signingRoot.valueOf() as Uint8Array,
            signature: s.signature,
          })),
        })
      )
    );

    // .every on an empty array returns true
    if (results.length === 0) {
      throw Error("Empty results array");
    }

    return results.every((isValid) => isValid === true);
  }

  private createWorkers(implementation: Implementation, poolSize: number): WorkerDescriptor[] {
    const workers: WorkerDescriptor[] = [];

    for (let i = 0; i < poolSize; i++) {
      const workerData: WorkerData = {implementation, workerId: i};
      const worker = new Worker("./worker", {workerData} as ConstructorParameters<typeof Worker>[1]);

      const workerDescriptor: WorkerDescriptor = {
        worker,
        status: {code: WorkerStatusCode.notInitialized},
      };
      workers.push(workerDescriptor);

      // TODO: Consider initializing only when necessary
      const initPromise = spawn<WorkerApi>(worker, {
        // A Lodestar Node may do very expensive task at start blocking the event loop and causing
        // the initialization to timeout. The number below is big enough to almost disable the timeout
        timeout: 5 * 60 * 1000,
      });

      workerDescriptor.status = {code: WorkerStatusCode.initializing, initPromise};

      initPromise
        .then((workerApi) => {
          workerDescriptor.status = {code: WorkerStatusCode.idle, workerApi};
          // Potentially run jobs that were queued before initialization of the first worker
          setTimeout(this.runJob, 0);
        })
        .catch((error: Error) => {
          workerDescriptor.status = {code: WorkerStatusCode.initializationError, error};
        });
    }

    return workers;
  }

  /**
   * Register BLS work to be done eventually in a worker
   */
  private async queueBlsWork(workReq: BlsWorkReq): Promise<boolean> {
    if (this.signal.aborted) {
      throw new QueueError({code: QueueErrorCode.QUEUE_ABORTED});
    }

    // TODO: Consider if limiting queue size is necessary here.
    // It would be bad to reject signatures because the node is slow.
    // However, if the worker communication broke jobs won't ever finish

    if (
      this.workers.length > 0 &&
      this.workers[0].status.code === WorkerStatusCode.initializationError &&
      this.workers.every((worker) => worker.status.code === WorkerStatusCode.initializationError)
    ) {
      throw this.workers[0].status.error;
    }

    return await new Promise<boolean>((resolve, reject) => {
      const job = {resolve, reject, addedTimeMs: Date.now(), workReq};

      // Append batchable sets to `bufferedJobs`, starting a timeout to push them into `jobs`.
      // Do not call `runJob()`, it is called from `runBufferedJobs()`
      if (workReq.opts.batchable) {
        if (!this.bufferedJobs) {
          this.bufferedJobs = {
            jobs: [],
            sigCount: 0,
            firstPush: Date.now(),
            timeout: setTimeout(this.runBufferedJobs, MAX_BUFFER_WAIT_MS),
          };
        }
        this.bufferedJobs.jobs.push(job);
        this.bufferedJobs.sigCount += job.workReq.sets.length;
        if (this.bufferedJobs.sigCount > MAX_BUFFERED_SIGS) {
          clearTimeout(this.bufferedJobs.timeout);
          this.runBufferedJobs();
        }
      }

      // Push job and schedule to call `runJob` in the next macro event loop cycle.
      // This is usefull to allow batching job submited from a syncronous for loop,
      // and to prevent large stacks since runJob may be called recursively.
      else {
        this.jobs.push(job);
        setTimeout(this.runJob, 0);
      }
    });
  }

  /**
   * Potentially submit jobs to an idle worker, only if there's a worker and jobs
   */
  private runJob = async (): Promise<void> => {
    if (this.signal.aborted) {
      return;
    }

    // Find iddle worker
    const worker = this.workers.find((worker) => worker.status.code === WorkerStatusCode.idle);
    if (!worker || worker.status.code !== WorkerStatusCode.idle) {
      return;
    }

    // Prepare work package
    const jobs = this.prepareWork();
    if (jobs.length === 0) {
      return;
    }

    // TODO: After sending the work to the worker the main thread can drop the job arguments
    // and free-up memory, only needs to keep the job's Promise handlers.
    // Maybe it's not useful since all data referenced in jobs is likely referenced by others

    const workerApi = worker.status.workerApi;
    worker.status = {code: WorkerStatusCode.running, workerApi};

    try {
      let startedSigSets = 0;
      for (const job of jobs) {
        this.metrics?.blsThreadPool.jobWaitTime.observe((Date.now() - job.addedTimeMs) / 1000);
        startedSigSets += job.workReq.sets.length;
      }

      this.metrics?.blsThreadPool.totalJobsGroupsStarted.inc(1);
      if (jobs.length > 0) this.metrics?.blsThreadPool.totalJobsStarted.inc(jobs.length);
      if (startedSigSets > 0) this.metrics?.blsThreadPool.totalSigSetsStarted.inc(startedSigSets);

      // Send work package to the worker
      // If the job, metrics or any code below throws: the job will reject never going stale.
      // Only downside is the the job promise may be resolved twice, but that's not an issue

      const jobStartNs = process.hrtime.bigint();
      const workResult = await workerApi.verifyManySignatureSets(jobs.map((job) => job.workReq));
      const jobEndNs = process.hrtime.bigint();
      const {workerId, batchRetries, batchSigsSuccess, workerStartNs, workerEndNs, results} = workResult;

      let successCount = 0;
      let errorCount = 0;

      // Un-wrap work package
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const jobResult = results[i];
        const sigSetCount = job.workReq.sets.length;
        if (!jobResult) {
          job.reject(Error(`No jobResult for index ${i}`));
          errorCount += sigSetCount;
        } else if (jobResult.code === WorkResultCode.success) {
          job.resolve(jobResult.result);
          successCount += sigSetCount;
        } else {
          const workerError = Error(jobResult.error.message);
          if (jobResult.error.stack) workerError.stack = jobResult.error.stack;
          job.reject(workerError);
          errorCount += sigSetCount;
        }
      }

      const workerJobTimeSec = Number(workerEndNs - workerStartNs) / 1e9;
      const latencyToWorkerSec = Number(workerStartNs - jobStartNs) / 1e9;
      const latencyFromWorkerSec = Number(jobEndNs - workerEndNs) / 1e9;

      if (workerJobTimeSec > 0) this.metrics?.blsThreadPool.jobsWorkerTime.inc({workerId}, workerJobTimeSec);
      this.metrics?.blsThreadPool.latencyToWorker.observe(latencyToWorkerSec);
      this.metrics?.blsThreadPool.latencyFromWorker.observe(latencyFromWorkerSec);
      if (successCount > 0) this.metrics?.blsThreadPool.successJobsSignatureSetsCount.inc(successCount);
      if (errorCount > 0) this.metrics?.blsThreadPool.errorJobsSignatureSetsCount.inc(errorCount);
      if (batchRetries > 0) this.metrics?.blsThreadPool.batchRetries.inc(batchRetries);
      if (batchSigsSuccess > 0) this.metrics?.blsThreadPool.batchSigsSuccess.inc(batchSigsSuccess);
    } catch (e) {
      // Worker communications should never reject
      if (!this.signal.aborted) this.logger.error("BlsMultiThreadWorkerPool error", {}, e);
      // Reject all
      for (const job of jobs) {
        job.reject(e);
      }
    }

    worker.status = {code: WorkerStatusCode.idle, workerApi};

    // Potentially run a new job
    setTimeout(this.runJob, 0);
  };

  /**
   * Grab pending work up to a max number of signatures
   */
  private prepareWork(): JobQueueItem<boolean>[] {
    const jobs: JobQueueItem<boolean>[] = [];
    let totalSigs = 0;

    while (totalSigs < MAX_SIGNATURE_SETS_PER_JOB) {
      const job = this.jobs.shift();
      if (!job) {
        break;
      }

      jobs.push(job);
      totalSigs += job.workReq.sets.length;
    }

    return jobs;
  }

  /**
   * Add all buffered jobs to the job queue and potentially run them immediatelly
   */
  private runBufferedJobs = (): void => {
    if (this.bufferedJobs) {
      this.jobs.push(...this.bufferedJobs.jobs);
      this.bufferedJobs = null;
      setTimeout(this.runJob, 0);
    }
  };

  /**
   * Stop all JavaScript execution in the worker thread immediatelly
   */
  private terminateAllWorkers = (): void => {
    for (const [id, worker] of this.workers.entries()) {
      // NOTE: 'threads' has not yet updated types, and NodeJS complains with
      // [DEP0132] DeprecationWarning: Passing a callback to worker.terminate() is deprecated. It returns a Promise instead.
      ((worker.worker.terminate() as unknown) as Promise<void>).catch((e) => {
        if (e) this.logger.error("Error terminating worker", {id}, e);
      });
    }
  };

  private abortAllJobs = (): void => {
    while (this.jobs.length > 0) {
      const job = this.jobs.shift();
      if (job) job.reject(new QueueError({code: QueueErrorCode.QUEUE_ABORTED}));
    }
  };

  /** For testing */
  private async waitTillInitialized(): Promise<void> {
    await Promise.all(
      this.workers.map(async (worker) => {
        if (worker.status.code === WorkerStatusCode.initializing) {
          await worker.status.initPromise;
        }
      })
    );
  }
}
