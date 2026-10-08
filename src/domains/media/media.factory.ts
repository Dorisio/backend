/**
 * Configured media stack (issue #64).
 *
 * One place turns environment configuration into a `MediaService` and its
 * collaborators, so the HTTP routes and the image-processing worker build exactly
 * the same objects (same bucket, same scanner, same processor settings).
 */

import type { PrismaClient } from '@prisma/client';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';
import { createMediaStorage, type MediaStorage } from './media.storage';
import { createMalwareScanner, type MalwareScanner } from './media.scanner';
import { createMediaProcessor, type MediaProcessor } from './media.processor';
import { MediaService } from './media.service';

export interface MediaStack {
  service: MediaService;
  storage: MediaStorage;
  scanner: MalwareScanner;
  processor: MediaProcessor;
}

export function buildStorage(): MediaStorage {
  if (config.MEDIA_STORAGE === 's3') {
    return createMediaStorage({
      driver: 's3',
      s3: {
        bucket: config.MEDIA_S3_BUCKET as string,
        region: config.MEDIA_S3_REGION,
        accessKeyId: config.MEDIA_S3_ACCESS_KEY_ID as string,
        secretAccessKey: config.MEDIA_S3_SECRET_ACCESS_KEY as string,
        sessionToken: config.MEDIA_S3_SESSION_TOKEN,
        endpoint: config.MEDIA_S3_ENDPOINT,
        forcePathStyle: config.MEDIA_S3_FORCE_PATH_STYLE,
        requestTimeoutMs: config.MEDIA_STORAGE_TIMEOUT_MS,
      },
    });
  }

  return createMediaStorage({ driver: 'local', localRoot: config.MEDIA_LOCAL_ROOT });
}

export function buildScanner(): MalwareScanner {
  return createMalwareScanner({
    driver: config.MEDIA_SCANNER,
    clamav: { host: config.CLAMAV_HOST ?? '', port: config.CLAMAV_PORT, timeoutMs: config.CLAMAV_TIMEOUT_MS },
  });
}

export function buildProcessor(): MediaProcessor {
  return createMediaProcessor({
    driver: config.MEDIA_PROCESSOR,
    transcodeVideo: config.MEDIA_TRANSCODE_VIDEO,
    ffmpegPath: config.MEDIA_FFMPEG_PATH,
    ffprobePath: config.MEDIA_FFPROBE_PATH,
  });
}

export function createMediaStack(prisma: PrismaClient): MediaStack {
  const storage = buildStorage();
  const scanner = buildScanner();
  const processor = buildProcessor();

  const service = new MediaService(prisma, storage, scanner, processor, {
    limits: {
      maxImageBytes: config.MEDIA_MAX_IMAGE_BYTES,
      maxVideoBytes: config.MEDIA_MAX_VIDEO_BYTES,
      defaultQuotaBytes: config.MEDIA_DEFAULT_QUOTA_BYTES,
      uploadTtlSeconds: config.MEDIA_UPLOAD_TTL_SECONDS,
    },
    cdnBaseUrl: config.MEDIA_CDN_BASE_URL,
    uploadMode: config.MEDIA_UPLOAD_MODE,
  });

  logger.debug(
    { storage: storage.kind, scanner: scanner.name, processor: processor.name, uploadMode: config.MEDIA_UPLOAD_MODE },
    'Media stack configured'
  );

  return { service, storage, scanner, processor };
}
