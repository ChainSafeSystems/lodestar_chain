import {AbortController} from "abort-controller";
import {expect} from "chai";

import {JobQueue, QueueError, QueueErrorCode} from "../../../src/util/queue";

describe("Job queue", () => {
  const queueSize = 3;
  const jobDuration = 20;

  it("should only allow a single job at a time to run", async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    const jobQueue = new JobQueue({queueSize, signal});

    let activeJobs = 0;
    const job = async (): Promise<void> => {
      activeJobs++;
      await new Promise((resolve) => setTimeout(resolve, jobDuration));
      if (activeJobs > 1) {
        throw new Error();
      }
      activeJobs--;
    };

    // Start all jobs at the same time
    // expect none of the jobs to be running simultaneously
    await Promise.all(Array.from({length: queueSize}, () => jobQueue.enqueueJob(job)));
  });
  it("should throw after the queue is full", async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    const jobQueue = new JobQueue({queueSize, signal});

    const job = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, jobDuration));
    };
    // Start `queueSize` # of jobs at the same time
    // the queue is now full
    const jobs = Promise.all(Array.from({length: queueSize}, () => jobQueue.enqueueJob(job)));
    try {
      // the next enqueued job should go over the limit
      await jobQueue.enqueueJob(job);
    } catch (e: unknown) {
      assertQueueErrorCode(e, QueueErrorCode.QUEUE_THROTTLED);
    }

    await jobs;
  });
  it("should throw after the queue is aborted", async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    const jobQueue = new JobQueue({queueSize, signal});

    const job = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, jobDuration));
    };
    const jobs = Promise.allSettled(Array.from({length: queueSize}, () => jobQueue.enqueueJob(job)));
    controller.abort();
    const results = await jobs;

    // all jobs should be rejected with ERR_QUEUE_ABORTED
    for (const e of results) {
      if (e.status === "rejected") {
        assertQueueErrorCode(e.reason, QueueErrorCode.QUEUE_ABORTED);
      } else {
        expect.fail();
      }
    }

    // any subsequently enqueued job should also be rejected
    try {
      await jobQueue.enqueueJob(job);
    } catch (e: unknown) {
      assertQueueErrorCode(e, QueueErrorCode.QUEUE_ABORTED);
    }
  });
});

function assertQueueErrorCode(e: QueueError, code: QueueErrorCode): void {
  if (e instanceof QueueError) {
    expect(e.type.code).to.be.equal(code, "Wrong QueueErrorCode");
  } else {
    throw Error(`Expected e ${QueueError} to be instaceof QueueError`);
  }
}
