/**
 * Media processing (#64).
 *
 * The processor is optional infrastructure, so every path has to degrade to
 * "serve the original" rather than failing the upload. What must never happen is
 * a derivative being recorded as produced when it was not.
 */
import { describe, it, expect } from 'vitest';
import {
  FfmpegVideoProcessor,
  KindRoutingProcessor,
  NoopProcessor,
  SharpImageProcessor,
  createMediaProcessor,
  isDerivativeVariant,
  type MediaProcessor,
  type ProcessingResult,
} from '../media.processor';
import { PNG_BYTES } from './fakes';

const input = (kind: 'image' | 'video' = 'image', mimeType = 'image/png') => ({
  kind,
  mimeType,
  fileName: kind === 'image' ? 'photo.png' : 'clip.mp4',
  buffer: PNG_BYTES,
});

describe('NoopProcessor', () => {
  it('produces nothing and says why', async () => {
    const result = await new NoopProcessor('switched off').process();
    expect(result).toEqual({ status: 'skipped', processor: 'none', derivatives: [], error: 'switched off' });
  });
});

describe('KindRoutingProcessor', () => {
  class Named implements MediaProcessor {
    calls: string[] = [];
    constructor(readonly name: string) {}
    async process(entry: { kind: string }): Promise<ProcessingResult> {
      this.calls.push(entry.kind);
      return { status: 'done', processor: this.name, derivatives: [] };
    }
  }

  it('sends images to the image processor and videos to the video processor', async () => {
    const images = new Named('images');
    const videos = new Named('videos');
    const router = new KindRoutingProcessor(images, videos);

    expect(router.name).toBe('images+videos');

    await router.process(input('image'));
    await router.process(input('video', 'video/mp4'));

    expect(images.calls).toEqual(['image']);
    expect(videos.calls).toEqual(['video']);
  });
});

describe('SharpImageProcessor without sharp installed', () => {
  it('skips instead of failing, keeping the original usable', async () => {
    // `sharp` is an optional dependency; when the import resolves to nothing the
    // upload must still be servable.
    const result = await new SharpImageProcessor().process(input());

    if (result.status === 'done') {
      // sharp is installed in this environment: the derivative must be real.
      expect(result.derivatives.length).toBeGreaterThan(0);
      expect(result.derivatives[0].bytes.byteLength).toBeGreaterThan(0);
      expect(result.derivatives[0].mimeType).toBe('image/webp');
    } else {
      expect(result.status).toBe('skipped');
      expect(result.derivatives).toEqual([]);
      expect(result.error).toBeTruthy();
    }
  });
});

describe('FfmpegVideoProcessor without ffmpeg installed', () => {
  it('skips with an explanation rather than throwing', async () => {
    const processor = new FfmpegVideoProcessor({
      driver: 'ffmpeg',
      transcodeVideo: false,
      ffmpegPath: '__definitely_not_ffmpeg__',
      ffprobePath: '__definitely_not_ffprobe__',
      previewWidth: 640,
      optimizedWidth: 1600,
      optimizeAboveBytes: 200 * 1024,
    });

    const result = await processor.process(input('video', 'video/mp4'));

    expect(result).toEqual({
      status: 'skipped',
      processor: 'ffmpeg',
      derivatives: [],
      error: 'ffmpeg/ffprobe are not installed, the original video is served as uploaded',
    });
  });
});

describe('isDerivativeVariant', () => {
  it('accepts only the variants the services know how to serve', () => {
    expect(isDerivativeVariant('preview')).toBe(true);
    expect(isDerivativeVariant('optimized')).toBe(true);
    expect(isDerivativeVariant('thumbnail')).toBe(true);
    expect(isDerivativeVariant('original')).toBe(false);
  });
});

describe('createMediaProcessor', () => {
  it('builds the processor named by configuration', () => {
    expect(createMediaProcessor({ driver: 'none' })).toBeInstanceOf(NoopProcessor);
    expect(createMediaProcessor({ driver: 'sharp' })).toBeInstanceOf(SharpImageProcessor);
    expect(createMediaProcessor({ driver: 'ffmpeg' })).toBeInstanceOf(FfmpegVideoProcessor);
    expect(createMediaProcessor({ driver: 'auto' })).toBeInstanceOf(KindRoutingProcessor);
  });
});
