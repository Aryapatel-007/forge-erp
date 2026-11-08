// Background jobs. A row per job in the database holds its next run and a lock, so if two
// servers run, each job still runs once. A job that throws is logged and tried next time.
import { JobState } from '../models/platform.js';

const jobs = new Map();
let timer = null;

export function defineJob(name, everyMinutes, run) {
  if (jobs.has(name)) throw new Error(`Job ${name} defined twice`);
  jobs.set(name, { name, everyMinutes, run });
}

export const listJobs = () => [...jobs.values()];

export async function runJobNow(name, now = new Date()) {
  const job = jobs.get(name);
  if (!job) throw new Error(`Unknown job ${name}`);
  return job.run(now);
}

export async function tick(now = new Date(), logger = console) {
  for (const job of jobs.values()) {
    await JobState.updateOne({ _id: job.name }, { $setOnInsert: { _id: job.name } }, { upsert: true });
    const claimed = await JobState.findOneAndUpdate(
      { _id: job.name, nextRunAt: { $lte: now }, lockedUntil: { $lte: now } },
      { lockedUntil: new Date(now.getTime() + 10 * 60000) },
      { new: true },
    );
    if (!claimed) continue;
    try {
      const result = await job.run(now);
      await JobState.updateOne({ _id: job.name }, {
        lastRunAt: now,
        lastResult: result === undefined ? 'done' : String(result).slice(0, 500),
        lastError: null,
        lockedUntil: new Date(0),
        nextRunAt: new Date(now.getTime() + job.everyMinutes * 60000),
      });
    } catch (error) {
      logger.error?.({ err: error, job: job.name }, 'Job failed');
      await JobState.updateOne({ _id: job.name }, {
        lastRunAt: now,
        lastError: String(error.message).slice(0, 500),
        lockedUntil: new Date(0),
        nextRunAt: new Date(now.getTime() + job.everyMinutes * 60000),
      });
    }
  }
}

export function startScheduler(logger, intervalMs = 60000) {
  if (timer) return;
  timer = setInterval(() => tick(new Date(), logger).catch((error) => logger.error({ err: error }, 'Scheduler tick failed')), intervalMs);
  timer.unref();
}

export function stopScheduler() {
  clearInterval(timer);
  timer = null;
}
