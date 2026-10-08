/**
 * Media processing queue (issue #64).
 *
 * Reuses the existing `image-processing` queue rather than adding infrastructure;
 * the worker for that queue is the one that knows how to turn a `mediaId` into
 * derivatives. The job payload is just the id, so a retry always processes the
 * row's current state instead of a stale copy of it.
 */

import { imageProcessingQueue } from '../../lib/queue';
import { logger } from '../../utils/logger';

export const MEDIA_PROCESSING_JOB = 'process-media';

export async function enqueueMediaProcessing(mediaId: string): Promise<void> {
  try {
    await imageProcessingQueue.add(
      MEDIA_PROCESSING_JOB,
      { mediaId },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { count: 1_000 },
      }
    );
  } catch (error) {
    // The upload itself is verified and usable; derivatives can be produced later.
    logger.warn({ err: error, mediaId }, 'Could not queue media processing');
  }
}
