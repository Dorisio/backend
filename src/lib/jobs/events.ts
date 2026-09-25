import { JobState } from './types';

/**
 * Job lifecycle events.
 *
 * Consumers (for example webhook dispatch) can subscribe to job outcomes
 * without the queue modules needing to know about them.
 */

export type JobEventType = 'enqueued' | 'active' | 'completed' | 'failed' | 'dead-letter' | 'progress';

export interface JobEvent {
  type: JobEventType;
  queue: string;
  jobId: string;
  name: string;
  data?: unknown;
  result?: unknown;
  error?: string;
  progress?: number;
  attemptsMade?: number;
  state?: JobState;
  timestamp: string;
}

export type JobEventHandler = (event: JobEvent) => void;

export class JobEventBus {
  private handlers = new Map<JobEventType, Set<JobEventHandler>>();

  on(type: JobEventType, handler: JobEventHandler): () => void {
    const set = this.handlers.get(type) ?? new Set<JobEventHandler>();
    set.add(handler);
    this.handlers.set(type, set);
    return () => this.off(type, handler);
  }

  off(type: JobEventType, handler: JobEventHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  emit(event: JobEvent): void {
    const handlers = this.handlers.get(event.type);
    if (!handlers) {
      return;
    }
    for (const handler of handlers) {
      try {
        handler(event);
      } catch {
        // A misbehaving listener must never break job processing.
      }
    }
  }

  listenerCount(type: JobEventType): number {
    return this.handlers.get(type)?.size ?? 0;
  }

  clear(): void {
    this.handlers.clear();
  }
}

/** Shared event bus used by the job service and workers. */
export const jobEvents = new JobEventBus();

export function createJobEvent(
  type: JobEventType,
  fields: Omit<JobEvent, 'type' | 'timestamp'> & Partial<Pick<JobEvent, 'timestamp'>>
): JobEvent {
  return {
    type,
    timestamp: fields.timestamp ?? new Date().toISOString(),
    ...fields,
  };
}
