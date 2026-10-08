import { emailNotificationQueue } from '../../lib/queue';
import { config } from '../../config/env';
import { isFeatureEnabled } from '../../config/features';
import { logger } from '../../utils/logger';

export type EmailTemplate = 'verification' | 'password-reset' | 'creator-verification' | 'account-locked' | 'notification';

export interface EmailNotification {
  to: string;
  template: EmailTemplate;
  data: Record<string, string>;
  userId?: string;
  eventType?: string;
}

export async function enqueueEmail(notification: EmailNotification): Promise<string> {
  // Feature flag gate (#60): verification mail is skipped entirely when the
  // email-verification flag is disabled for the environment.
  if (notification.template === 'verification' && !isFeatureEnabled('emailVerification')) {
    logger.info({ to: notification.to }, 'Email verification disabled by feature flag, skipping send');
    return '';
  }

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
  if (template === 'creator-verification') {
    const status = escape(data.status ?? 'updated');
    const reason = data.reason ? `<p>Review note: ${escape(data.reason)}</p>` : '';
    return { subject: `Creator verification ${status}`, html: `<p>Hello ${name},</p><p>Your creator verification request was ${status}.</p>${reason}` };
  }
  if (template === 'account-locked') {
    return { subject: 'Your Dorisio account was temporarily locked', html: `<p>Hello ${name},</p><p>We detected repeated failed login attempts. Your account is temporarily locked until ${escape(data.unlockAt ?? 'later')}.</p>` };
  }
  return { subject: escape(data.subject ?? 'Dorisio notification'), html: `<p>Hello ${name},</p><p>${escape(data.message ?? '')}</p>` };
}

/**
 * Sends (enqueues) a templated email. Thin wrapper used by services
 * (`AuthService`); actual delivery happens on the email notification worker.
 * Never throws: delivery failures are logged and reported as `false` so
 * callers can degrade gracefully.
 */
export async function sendEmail(notification: EmailNotification): Promise<boolean> {
  if (!config.SENDGRID_API_KEY) {
    logger.warn({ to: notification.to, template: notification.template }, 'SENDGRID_API_KEY not configured; email skipped');
    return false;
  }
  try {
    await enqueueEmail(notification);
    return true;
  } catch (err) {
    logger.error({ err, to: notification.to }, 'Failed to enqueue email');
    return false;
  }
}
