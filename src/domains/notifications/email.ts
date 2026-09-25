import { emailNotificationQueue } from '../../lib/queue';

export type EmailTemplate = 'verification' | 'password-reset' | 'notification';

export interface EmailNotification {
  to: string;
  template: EmailTemplate;
  data: Record<string, string>;
  userId?: string;
  eventType?: string;
}

export async function enqueueEmail(notification: EmailNotification): Promise<string> {
  const job = await emailNotificationQueue.add('send', notification, {
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { age: 7 * 24 * 60 * 60, count: 10000 },
    removeOnFail: { age: 30 * 24 * 60 * 60 },
  });
  return String(job.id);
}

export async function enqueueEmailBatch(notifications: EmailNotification[]): Promise<string[]> {
  const jobs = await emailNotificationQueue.addBulk(notifications.map((notification) => ({
    name: 'send',
    data: notification,
    opts: {
      attempts: 5,
      backoff: { type: 'exponential' as const, delay: 1000 },
      removeOnComplete: { age: 7 * 24 * 60 * 60, count: 10000 },
      removeOnFail: { age: 30 * 24 * 60 * 60 },
    },
  })));
  return jobs.map((job) => String(job.id));
}

export function renderEmail(template: EmailTemplate, data: Record<string, string>) {
  const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!);
  const name = escape(data.name ?? 'there');
  const link = escape(data.link ?? '');

  if (template === 'verification') {
    return { subject: 'Verify your Dorisio account', html: `<p>Hello ${name},</p><p><a href="${link}">Verify your email</a></p>` };
  }
  if (template === 'password-reset') {
    return { subject: 'Reset your Dorisio password', html: `<p>Hello ${name},</p><p><a href="${link}">Reset your password</a></p>` };
  }
  return { subject: escape(data.subject ?? 'Dorisio notification'), html: `<p>Hello ${name},</p><p>${escape(data.message ?? '')}</p>` };
}
