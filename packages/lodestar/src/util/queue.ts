import {AbortSignal} from "abort-controller";
import pushable from "it-pushable";
import pipe from "it-pipe";
import {LodestarError} from "@chainsafe/lodestar-utils";

export enum QueueErrorCode {
  QUEUE_ABORTED = "QUEUE_ERROR_QUEUE_ABORTED",
  QUEUE_THROTTLED = "QUEUE_ERROR_QUEUE_THROTTLED",
}

export type QueueErrorCodeType = {code: QueueErrorCode.QUEUE_ABORTED} | {code: QueueErrorCode.QUEUE_THROTTLED};

export class QueueError extends LodestarError<QueueErrorCodeType> {
  constructor(type: QueueErrorCodeType) {
    super(type);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Job = (...args: any) => any;

type JobQueueItem<T extends Job = Job> = {
  job: T;
  resolve: (value?: ReturnType<T> | PromiseLike<ReturnType<T>> | undefined) => void;
  reject: (reason?: unknown) => void;
};

type JobQueueOpts = {
  queueSize: number;
  signal: AbortSignal;
  /**
   * Called when a job resolves or rejects.
   * Returns the total miliseconds ellapsed from job start to done
   */
  onJobDone?: (data: {ms: number}) => void;
};

export class JobQueue {
  private currentSize = 0;
  private queue = pushable<JobQueueItem>();
  private opts: JobQueueOpts;

  constructor(opts: JobQueueOpts) {
    this.opts = opts;
    void pipe(this.queue, async (source) => {
      for await (const job of source) {
        await this.processJob(job);
      }
    });
  }

  async processJob({job, resolve, reject}: JobQueueItem): Promise<void> {
    if (this.opts.signal.aborted) {
      reject(new QueueError({code: QueueErrorCode.QUEUE_ABORTED}));
    } else {
      const start = Date.now();
      try {
        const result = await job();
        resolve(result);
      } catch (e: unknown) {
        reject(e);
      } finally {
        this.opts.onJobDone?.({ms: Date.now() - start});
      }
    }
    this.currentSize--;
  }

  enqueueJob<T extends Job>(job: T): Promise<ReturnType<T>> {
    if (this.opts.signal.aborted) {
      throw new QueueError({code: QueueErrorCode.QUEUE_ABORTED});
    }
    if (this.currentSize + 1 > this.opts.queueSize) {
      throw new QueueError({code: QueueErrorCode.QUEUE_THROTTLED});
    }
    return new Promise((resolve, reject) => {
      this.queue.push({job, resolve, reject});
      this.currentSize++;
    });
  }
}
