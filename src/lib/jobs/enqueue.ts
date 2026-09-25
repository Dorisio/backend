import type { JobsOptions } from 'bullmq';
import {
  analyticsQueue,
  emailQueue,
  exportsQueue,
  imageProcessingQueue,
  JobPriorityName,
  priorityValue,
  stellarConfirmationQueue,
  webhookDispatchQueue,
} from '../queue';

export type EnqueueOptions = {
  priority?: JobPriorityName;
  jobId?: string;
  delay?: number;
};

function opts(options: EnqueueOptions = {}): JobsOptions {
  return {
    priority: priorityValue(options.priority ?? 'normal'),
    jobId: options.jobId,
    delay: options.delay,
  };
}

export async function enqueueEmail(
  data: { to: string; subject: string; body: string; template?: string },
  options?: EnqueueOptions,
) {
  return emailQueue.add('send-email', data, opts(options));
}

export async function enqueueImageProcessing(
  data: { assetUrl: string; operations: string[]; userId?: string },
  options?: EnqueueOptions,
) {
  return imageProcessingQueue.add('process-image', data, opts(options));
}

export async function enqueueAnalytics(
  data: { creatorId: string; rangeDays?: number },
  options?: EnqueueOptions,
) {
  return analyticsQueue.add('compute-analytics', data, opts({ ...options, priority: options?.priority ?? 'low' }));
}

export async function enqueueExport(
  data: { userId: string; type: 'tips' | 'payouts' | 'analytics'; format?: 'csv' | 'json' },
  options?: EnqueueOptions,
) {
  return exportsQueue.add('generate-export', data, opts(options));
}

export async function enqueueStellarConfirmation(
  data: { tipId: string; transactionHash: string },
  options?: EnqueueOptions,
) {
  return stellarConfirmationQueue.add('confirm-stellar', data, opts({ ...options, priority: options?.priority ?? 'high' }));
}

export async function enqueueWebhookDispatch(
  data: { webhookId: string; eventType: string; payload: unknown },
  options?: EnqueueOptions,
) {
  return webhookDispatchQueue.add('dispatch-webhook', data, opts(options));
}
