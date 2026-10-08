/**
 * Media processing (issue #64): image resizing/optimisation, video probing and
 * transcoding, preview generation.
 *
 * The processor seam keeps the API honest on hosts that do not have the tooling:
 * `sharp` is optional and `ffmpeg`/`ffprobe` are probed, and when one is missing
 * the result is `skipped` with the reason recorded on the media row instead of a
 * derivative that does not exist. The original upload is usable either way.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../../utils/logger';
import {
  DERIVATIVE_VARIANTS,
  type AllowedMimeType,
  type DerivativeVariant,
  type MediaKind,
  type ProcessingStatus,
} from './media.types';

const run = promisify(execFile);

export interface ProcessingDerivative {
  variant: DerivativeVariant;
  mimeType: AllowedMimeType;
  bytes: Buffer;
  width?: number;
  height?: number;
}

export interface ProcessingInput {
  kind: MediaKind;
  mimeType: string;
  /** Original file name, used only for the ffmpeg temp file extension. */
  fileName: string;
  buffer: Buffer;
}

export interface ProcessingResult {
  status: Exclude<ProcessingStatus, 'pending'>;
  processor: string;
  derivatives: ProcessingDerivative[];
  width?: number;
  height?: number;
  durationSeconds?: number;
  error?: string;
}

export interface MediaProcessor {
  readonly name: string;
  process(input: ProcessingInput): Promise<ProcessingResult>;
}

export interface SharpLike {
  (input: Buffer): {
    metadata(): Promise<{ width?: number; height?: number }>;
    resize(options: { width: number; withoutEnlargement: boolean }): SharpLikeChain;
  };
}

interface SharpLikeChain {
  webp(options: { quality: number }): { toBuffer(): Promise<Buffer> };
  jpeg(options: { quality: number }): { toBuffer(): Promise<Buffer> };
}

export interface ProcessorSettings {
  driver: 'auto' | 'sharp' | 'ffmpeg' | 'none';
  /** Transcode videos to webm instead of keeping the original codec. */
  transcodeVideo: boolean;
  ffmpegPath: string;
  ffprobePath: string;
  previewWidth: number;
  optimizedWidth: number;
  /** Images smaller than this are left as they are. */
  optimizeAboveBytes: number;
}

export const DEFAULT_PROCESSOR_SETTINGS: ProcessorSettings = {
  driver: 'auto',
  transcodeVideo: false,
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  previewWidth: 640,
  optimizedWidth: 1600,
  optimizeAboveBytes: 200 * 1024,
};

async function commandAvailable(binary: string): Promise<boolean> {
  try {
    await run(binary, ['-version'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

let sharpProbe: Promise<unknown | null> | null = null;
async function loadSharp(): Promise<SharpLike | null> {
  if (!sharpProbe) {
    sharpProbe = import('sharp' as string)
      .then((module) => (module as { default?: unknown }).default ?? module)
      .catch(() => null);
  }
  return (await sharpProbe) as SharpLike | null;
}

/** Images: preview + optimised webp, with the dimensions recorded. */
export class SharpImageProcessor implements MediaProcessor {
  readonly name = 'sharp';

  constructor(private readonly settings: ProcessorSettings = DEFAULT_PROCESSOR_SETTINGS) {}

  async process(input: ProcessingInput): Promise<ProcessingResult> {
    const sharp = await loadSharp();
    if (!sharp) {
      return {
        status: 'skipped',
        processor: this.name,
        derivatives: [],
        error: 'sharp is not installed, the original image is served as uploaded',
      };
    }

    try {
      const image = sharp(input.buffer);
      const metadata = await image.metadata();
      const derivatives: ProcessingDerivative[] = [];

      const widths: Array<{ variant: DerivativeVariant; width: number; quality: number }> = [
        { variant: 'preview', width: this.settings.previewWidth, quality: 72 },
        { variant: 'optimized', width: this.settings.optimizedWidth, quality: 82 },
      ];

      for (const target of widths) {
        if (metadata.width && metadata.width <= target.width && input.buffer.byteLength <= this.settings.optimizeAboveBytes) {
          continue;
        }
        const resized = sharp(input.buffer).resize({ width: target.width, withoutEnlargement: true });
        derivatives.push({
          variant: target.variant,
          mimeType: 'image/webp',
          bytes: await resized.webp({ quality: target.quality }).toBuffer(),
          width: metadata.width ? Math.min(metadata.width, target.width) : undefined,
          height: metadata.height && metadata.width ? Math.round((metadata.height * Math.min(metadata.width, target.width)) / metadata.width) : undefined,
        });
      }

      return {
        status: derivatives.length > 0 ? 'done' : 'skipped',
        processor: this.name,
        derivatives,
        width: metadata.width,
        height: metadata.height,
        error: derivatives.length > 0 ? undefined : 'image is already within the derivative sizes',
      };
    } catch (error) {
      logger.warn({ err: error }, 'Image processing failed');
      return {
        status: 'failed',
        processor: this.name,
        derivatives: [],
        error: error instanceof Error ? error.message : 'image processing failed',
      };
    }
  }
}

interface FfprobeOutput {
  streams?: Array<{ width?: number; height?: number; duration?: string }>;
  format?: { duration?: string };
}

/** Videos: probe dimensions/duration, extract a thumbnail, optionally transcode. */
export class FfmpegVideoProcessor implements MediaProcessor {
  readonly name = 'ffmpeg';

  constructor(private readonly settings: ProcessorSettings = DEFAULT_PROCESSOR_SETTINGS) {}

  async process(input: ProcessingInput): Promise<ProcessingResult> {
    const [ffmpegAvailable, ffprobeAvailable] = await Promise.all([
      commandAvailable(this.settings.ffmpegPath),
      commandAvailable(this.settings.ffprobePath),
    ]);

    if (!ffmpegAvailable || !ffprobeAvailable) {
      return {
        status: 'skipped',
        processor: this.name,
        derivatives: [],
        error: 'ffmpeg/ffprobe are not installed, the original video is served as uploaded',
      };
    }

    const workdir = await mkdtemp(path.join(os.tmpdir(), 'doriso-media-'));
    const extension = input.fileName.split('.').pop()?.slice(0, 5) || 'bin';
    const source = path.join(workdir, `source.${extension}`);

    try {
      await writeFile(source, input.buffer);

      let width: number | undefined;
      let height: number | undefined;
      let durationSeconds: number | undefined;
      try {
        const { stdout } = await run(
          this.settings.ffprobePath,
          ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', source],
          { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }
        );
        const parsed = JSON.parse(stdout) as FfprobeOutput;
        const video = parsed.streams?.find((stream) => stream.width || stream.height);
        width = video?.width;
        height = video?.height;
        const duration = Number(video?.duration ?? parsed.format?.duration);
        if (Number.isFinite(duration) && duration > 0) durationSeconds = Math.round(duration * 1000) / 1000;
      } catch (error) {
        logger.warn({ err: error }, 'ffprobe failed, continuing without video metadata');
      }

      const derivatives: ProcessingDerivative[] = [];

      // Poster frame: one second in (or the first frame for shorter clips).
      const thumbnailPath = path.join(workdir, 'thumbnail.jpg');
      try {
        await run(
          this.settings.ffmpegPath,
          ['-y', '-i', source, '-frames:v', '1', '-vf', `scale=${this.settings.previewWidth}:-2`, '-q:v', '4', thumbnailPath],
          { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }
        );
        derivatives.push({
          variant: 'preview',
          mimeType: 'image/jpeg',
          bytes: await readFile(thumbnailPath),
          width: width ? Math.min(width, this.settings.previewWidth) : undefined,
        });
      } catch (error) {
        logger.warn({ err: error }, 'Video thumbnail extraction failed');
      }

      let status: ProcessingResult['status'] = derivatives.length > 0 ? 'done' : 'skipped';
      let error: string | undefined =
        derivatives.length > 0 ? undefined : 'no derivative could be produced from this video';

      if (this.settings.transcodeVideo) {
        const transcodedPath = path.join(workdir, 'transcoded.webm');
        try {
          await run(
            this.settings.ffmpegPath,
            ['-y', '-i', source, '-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0', '-c:a', 'libopus', '-b:a', '96k', transcodedPath],
            { timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 }
          );
          const bytes = await readFile(transcodedPath);
          if (bytes.byteLength > 0) {
            derivatives.push({ variant: 'optimized', mimeType: 'video/webm', bytes, width, height });
            status = 'done';
            error = undefined;
          }
        } catch (transcodeError) {
          logger.warn({ err: transcodeError }, 'Video transcode failed, keeping the original');
          error = transcodeError instanceof Error ? transcodeError.message : 'video transcode failed';
          if (derivatives.length > 0) status = 'done';
        }
      }

      return { status, processor: this.name, derivatives, width, height, durationSeconds, error };
    } catch (error) {
      logger.warn({ err: error }, 'Video processing failed');
      return {
        status: 'failed',
        processor: this.name,
        derivatives: [],
        error: error instanceof Error ? error.message : 'video processing failed',
      };
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }
}

/** Used when processing is switched off: records why, produces nothing. */
export class NoopProcessor implements MediaProcessor {
  readonly name = 'none';

  constructor(private readonly reason = 'media processing is disabled') {}

  async process(): Promise<ProcessingResult> {
    return { status: 'skipped', processor: this.name, derivatives: [], error: this.reason };
  }
}

/** Routes by kind, so an image never waits on ffmpeg and vice versa. */
export class KindRoutingProcessor implements MediaProcessor {
  readonly name: string;

  constructor(private readonly image: MediaProcessor, private readonly video: MediaProcessor) {
    this.name = `${image.name}+${video.name}`;
  }

  process(input: ProcessingInput): Promise<ProcessingResult> {
    return input.kind === 'image' ? this.image.process(input) : this.video.process(input);
  }
}

export function isDerivativeVariant(value: string): value is DerivativeVariant {
  return (DERIVATIVE_VARIANTS as readonly string[]).includes(value);
}

export function createMediaProcessor(settings: Partial<ProcessorSettings> = {}): MediaProcessor {
  const merged: ProcessorSettings = { ...DEFAULT_PROCESSOR_SETTINGS, ...settings };

  if (merged.driver === 'none') return new NoopProcessor();
  if (merged.driver === 'sharp') return new SharpImageProcessor(merged);
  if (merged.driver === 'ffmpeg') return new FfmpegVideoProcessor(merged);

  return new KindRoutingProcessor(new SharpImageProcessor(merged), new FfmpegVideoProcessor(merged));
}
