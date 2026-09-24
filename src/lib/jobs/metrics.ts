import { Counter, Gauge, Histogram } from 'prom-client';
import { QueueCounts } from './types';

/**
 * Prometheus metrics for background job processing. These power queue depth
 * alerting and latency dashboards (all exposed via `GET /metrics`).
 */

export const jobsEnqueuedTotal = new Counter({
  name: 'dorisio_jobs_enqueued_total',
  help: 'Total number of jobs enqueued',
  labelNames: ['queue', 'name', 'priority'],
});

export const jobsProcessedTotal = new Counter({
  name: 'dorisio_jobs_processed_total',
  help: 'Total number of jobs processed by outcome',
  labelNames: ['queue', 'name', 'status'],
});

export const jobDurationSeconds = new Histogram({
  name: 'dorisio_job_duration_seconds',
  help: 'Job processing duration in seconds',
  labelNames: ['queue', 'name'],
  buckets: [0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60],
});

export const queueDepthGauge = new Gauge({
  name: 'dorisio_queue_depth',
  help: 'Number of jobs per queue and state',
  labelNames: ['queue', 'state'],
});

export const deadLetterJobsGauge = new Gauge({
  name: 'dorisio_dead_letter_jobs',
  help: 'Number of jobs parked on the dead letter queue',
  labelNames: ['queue'],
});

export const jobRetriesTotal = new Counter({
  name: 'dorisio_job_retries_total',
  help: 'Total number of job retry attempts',
  labelNames: ['queue', 'name'],
});

export function recordJobEnqueued(queue: string, name: string, priority: number | string): void {
  jobsEnqueuedTotal.inc({ queue, name, priority: String(priority) });
}

export function recordJobProcessed(
  queue: string,
  name: string,
  status: 'completed' | 'failed'
): void {
  jobsProcessedTotal.inc({ queue, name, status });
}

export function recordJobDuration(queue: string, name: string, durationMs: number): void {
  jobDurationSeconds.observe({ queue, name }, durationMs / 1000);
}

export function recordJobRetry(queue: string, name: string): void {
  jobRetriesTotal.inc({ queue, name });
}

export function updateQueueDepth(queue: string, counts: QueueCounts): void {
  for (const [state, value] of Object.entries(counts)) {
    queueDepthGauge.set({ queue, state }, value);
  }
}

export function setDeadLetterCount(queue: string, count: number): void {
  deadLetterJobsGauge.set({ queue }, count);
}
