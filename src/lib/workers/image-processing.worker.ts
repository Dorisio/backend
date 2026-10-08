import { Worker, Job } from 'bullmq';
import { bullConnection, backoffStrategy, moveToDeadLetter, QUEUE_NAMES } from '../queue';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';
import { MEDIA_PROCESSING_JOB } from '../../domains/media/media.queue';
import { createMediaService } from '../../domains/media/media.service';
import { NoScanScanner } from '../../domains/media/media.scanner';
import { buildProcessor, buildStorage } from '../../domains/media/media.factory';
import type { PrismaClient } from '@prisma/client';

/**
 * Turns a verified upload into its renditions (#64).
 *
 * Media jobs only carry a `mediaId`, so this resolves the row's current state at
 * run time and is safe to retry: a job that started before the media was scanned
 * will pick up the scanned row on its next attempt instead of trusting a payload.
 */
async function processMediaJob(job: Job, prisma: PrismaClient): Promise<unknown> {
  const mediaId = job.data?.mediaId as string | undefined;
  if (!mediaId) {
    throw new Error('Media job is missing mediaId');
  }

  const service = createMediaService(
    prisma,
    buildStorage(),
    // Scanning already happened on the upload path; the worker only derives.
    NoScanScanner,
    buildProcessor(),
    { cdnBaseUrl: config.MEDIA_CDN_BASE_URL }
  );

  await job.updateProgress(25);
  const result = await service.processMedia(mediaId);
  await job.updateProgress(100);

  return result;
}

/**
 * Prisma handle for media jobs. The API passes its instrumented client in; the
 * standalone worker process creates its own so `pnpm worker` still derives media.
 */
async function resolvePrisma(injected?: PrismaClient): Promise<PrismaClient> {
  if (injected) return injected;
  if (!fallbackPrisma) {
    const { PrismaClient: Prisma } = await import('@prisma/client');
    fallbackPrisma = new Prisma();
  }
  return fallbackPrisma;
}

let fallbackPrisma: PrismaClient | null = null;

export function createImageProcessingWorker(prisma?: PrismaClient) {
  const worker = new Worker(
    QUEUE_NAMES.imageProcessing,
    async (job: Job) => {
      // Media jobs are recognised by name so the pre-existing image pipeline and
      // the media pipeline can share one queue without stepping on each other.
      if (job.name === MEDIA_PROCESSING_JOB) {
        return processMediaJob(job, await resolvePrisma(prisma));
      }

      await job.updateProgress(25);
      logger.info({ assetUrl: job.data.assetUrl, ops: job.data.operations }, 'processing image');
      await job.updateProgress(100);
      return { processed: true, assetUrl: job.data.assetUrl };
    },
    {
      connection: bullConnection,
      concurrency: config.WORKER_CONCURRENCY,
      settings: { backoffStrategy },
    }
  );

  worker.on('failed', async (job, err) => {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 5)) {
      await moveToDeadLetter(QUEUE_NAMES.imageProcessing, String(job.id), job.data, err.message);
    }
  });

  return worker;
}
