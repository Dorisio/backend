import { Job, Worker } from 'bullmq';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';
import { EmailNotification, renderEmail } from '../../domains/notifications/email';
import { emailNotificationRedis } from '../queue';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const emailNotificationWorker = new Worker<EmailNotification>(
  'email-notifications',
  async (job: Job<EmailNotification>) => {
    if (!config.SENDGRID_API_KEY || !config.EMAIL_FROM) {
      throw new Error('Email delivery is not configured (SENDGRID_API_KEY and EMAIL_FROM are required)');
    }
    if (job.data.template === 'notification' && job.data.userId && job.data.eventType) {
      const user = await prisma.user.findUnique({
        where: { id: job.data.userId },
        select: { notificationPreferences: true },
      });
      const preferences = user?.notificationPreferences as Record<string, Record<string, boolean>> | undefined;
      if (!preferences?.[job.data.eventType]?.email) {
        logger.info({ jobId: job.id, eventType: job.data.eventType }, 'Email skipped by user preference');
        return;
      }
    }
    const content = renderEmail(job.data.template, job.data.data);
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: job.data.to }] }],
        from: { email: config.EMAIL_FROM },
        subject: content.subject,
        content: [{ type: 'text/html', value: content.html }],
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      throw new Error(`SendGrid rejected email (${response.status})`);
    }
    logger.info({ jobId: job.id, recipient: job.data.to, template: job.data.template }, 'Email delivered');
  },
  { connection: emailNotificationRedis.duplicate() as any, concurrency: 5, limiter: { max: 20, duration: 1000 } },
);

emailNotificationWorker.on('failed', (job, error) => {
  logger.error({ jobId: job?.id, err: error }, 'Email job failed');
});
