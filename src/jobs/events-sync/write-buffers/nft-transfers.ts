import { Job, Queue, QueueScheduler, Worker } from "bullmq";

import { logger } from "@/common/logger";
import { acquireLock, redis, releaseLock } from "@/common/redis";
import { config } from "@/config/index";
import { idb } from "@/common/db";
import { MqJobsDataManager } from "@/models/mq-jobs-data";
import _ from "lodash";

const QUEUE_NAME = "events-sync-nft-transfers-write";

export const queue = new Queue(QUEUE_NAME, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 10,
    backoff: {
      type: "exponential",
      delay: 10000,
    },
    removeOnComplete: true,
    removeOnFail: 10000,
    timeout: 60000,
  },
});
new QueueScheduler(QUEUE_NAME, { connection: redis.duplicate() });

// BACKGROUND WORKER ONLY
if (config.doBackgroundWork) {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const { id } = job.data;
      const { query } = await MqJobsDataManager.getJobData(id);

      if (!query) {
        return;
      }

      try {
        if (await acquireLock(getLockName(), 60)) {
          await idb.none(query);
        } else {
          await addToQueue(query);
        }
      } catch (error) {
        logger.error(QUEUE_NAME, `Failed flushing nft transfer events to the database: ${error}`);
        throw error;
      }
    },
    {
      connection: redis.duplicate(),
      // It's very important to have this queue be single-threaded
      // in order to avoid database write deadlocks (and it can be
      // even better to have it be single-process).
      concurrency: 1,
    }
  );

  worker.on("completed", async (job) => {
    const { id } = job.data;
    await MqJobsDataManager.deleteJobData(id);

    await releaseLock(getLockName());
  });

  worker.on("error", (error) => {
    logger.error(QUEUE_NAME, `Worker errored: ${error}`);
  });
}

export const getLockName = () => {
  return `${QUEUE_NAME}-lock`;
};

export const addToQueue = async (query: string) => {
  const ids = await MqJobsDataManager.addJobData(QUEUE_NAME, { query });
  await Promise.all(_.map(ids, async (id) => await queue.add(id, { id })));
};
