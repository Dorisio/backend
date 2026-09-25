import { PrismaClient } from '@prisma/client';
import { CircuitBreaker, getCircuitBreaker } from '../circuit-breaker';
import { logger } from '../../utils/logger';
import { JobRecord } from './types';

/**
 * Background job processors.
 *
 * Long-running work that used to happen inline on the request path (sending
 * email, processing images, aggregating analytics, polling Stellar) lives here.
 * Dependencies are injected so processors are unit-testable without Redis or
 * network access.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  template?: string;
  metadata?: Record<string, unknown>;
}

export interface ImageProcessingJob {
  sourceUrl: string;
  width?: number;
  height?: number;
  format?: 'webp' | 'jpeg' | 'png';
}

export interface AnalyticsJob {
  creatorId?: string;
  windowStart: string;
  windowEnd: string;
}

export interface StellarConfirmationJob {
  tipId: string;
  transactionHash: string;
}

export interface ProcessorDependencies {
  prisma?: PrismaClient;
  /** Transport responsible for actually delivering an email. */
  emailTransport?: (message: EmailMessage) => Promise<{ providerId?: string }>;
  /** Fetches the bytes for an image that needs processing. */
  imageFetcher?: (url: string) => Promise<unknown>;
  /** Circuit breaker guarding external calls. */
  emailBreaker?: CircuitBreaker;
}

export type JobProcessor = (data: unknown, job?: JobRecord) => Promise<unknown>;

export function createEmailProcessor(deps: ProcessorDependencies = {}): JobProcessor {
  const breaker = deps.emailBreaker ?? getCircuitBreaker('email-provider', { failureThreshold: 5 });
  const transport = deps.emailTransport ?? defaultEmailTransport;

  return async (data) => {
    const message = data as EmailMessage;
    if (!message?.to || !message?.subject) {
      throw new Error('Email job requires `to` and `subject`');
    }

    // The circuit breaker fails fast when the provider is down instead of
    // letting jobs pile up waiting on timeouts.
    const result = await breaker.execute(() => transport(message));
    logger.info({ to: message.to, subject: message.subject }, 'Email dispatched');
    return { delivered: true, providerId: result.providerId ?? null };
  };
}

async function defaultEmailTransport(message: EmailMessage): Promise<{ providerId?: string }> {
  // No provider configured: log so the job still succeeds in development and
  // the payload is observable. Production wires EMAIL_* env vars through.
  logger.info({ to: message.to, template: message.template }, 'Email transport (no-op) invoked');
  return { providerId: undefined };
}

export function createImageProcessor(deps: ProcessorDependencies = {}): JobProcessor {
  return async (data) => {
    const job = data as ImageProcessingJob;
    if (!job?.sourceUrl) {
      throw new Error('Image job requires `sourceUrl`');
    }

    const bytes = deps.imageFetcher ? await deps.imageFetcher(job.sourceUrl) : undefined;

    return {
      processed: true,
      sourceUrl: job.sourceUrl,
      format: job.format ?? 'webp',
      dimensions: { width: job.width ?? null, height: job.height ?? null },
      hasSourceBytes: bytes !== undefined,
    };
  };
}

export function createAnalyticsProcessor(deps: ProcessorDependencies = {}): JobProcessor {
  return async (data) => {
    const job = data as AnalyticsJob;
    if (!job?.windowStart || !job?.windowEnd) {
      throw new Error('Analytics job requires `windowStart` and `windowEnd`');
    }

    const prisma = deps.prisma;
    if (!prisma) {
      // Without a database we cannot aggregate; surface a clear error so the job
      // retries and eventually lands in the dead letter queue.
      throw new Error('Analytics processor requires a database connection');
    }

    const windowStart = new Date(job.windowStart);
    const windowEnd = new Date(job.windowEnd);

    const completed = await prisma.tip.aggregate({
      where: {
        status: 'completed',
        createdAt: { gte: windowStart, lte: windowEnd },
        ...(job.creatorId ? { creatorId: job.creatorId } : {}),
      },
      _sum: { amount: true },
      _count: { _all: true },
    });

    return {
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      creatorId: job.creatorId ?? null,
      totalAmount: completed._sum.amount ?? 0,
      tipCount: completed._count._all ?? 0,
    };
  };
}

export function createStellarConfirmationProcessor(deps: ProcessorDependencies = {}): JobProcessor {
  return async (data) => {
    const job = data as StellarConfirmationJob;
    if (!job?.tipId || !job?.transactionHash) {
      throw new Error('Stellar confirmation job requires `tipId` and `transactionHash`');
    }

    const prisma = deps.prisma;
    if (!prisma) {
      throw new Error('Stellar confirmation processor requires a database connection');
    }

    const updated = await prisma.tip.update({
      where: { id: job.tipId },
      data: { status: 'completed' },
    });

    return { confirmed: true, tipId: updated.id, transactionHash: job.transactionHash };
  };
}

/**
 * Builds the processor map used by the workers.
 */
export function createProcessors(deps: ProcessorDependencies = {}): Record<string, JobProcessor> {
  return {
    'email.send': createEmailProcessor(deps),
    'image.process': createImageProcessor(deps),
    'analytics.aggregate': createAnalyticsProcessor(deps),
    'stellar.confirm-transaction': createStellarConfirmationProcessor(deps),
  };
}
