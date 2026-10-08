/**
 * Media types and request schemas (#64).
 *
 * The declared content type is attacker-controlled, so `detectMimeType` deciding
 * from the bytes is the security-relevant part of the upload path; the schemas
 * decide what a client may even ask for.
 */
import { describe, it, expect } from 'vitest';
import {
  ALLOWED_MIME_TYPES,
  DEFAULT_MEDIA_LIMITS,
  MAX_MEDIA_PER_TIP,
  MediaListQuerySchema,
  RequestUploadSchema,
  detectMimeType,
  isAllowedMimeType,
  kindForMimeType,
  maxBytesForKind,
} from '../media.types';
import { CreateTipSchema as PaymentCreateTipSchema } from '../../payments/payment.schemas';
import { CreateTipSchema as TypesCreateTipSchema } from '../../payments/payment.types';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const jpeg = Buffer.from('ffd8ffe000104a464946000101', 'hex');
const gif = Buffer.from('GIF89a00000000', 'latin1');
const webp = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'latin1'),
]);
const webm = Buffer.from('1a45dfa3a342868101', 'hex');
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42', 'latin1')]);

describe('detectMimeType', () => {
  it('recognises the supported image formats from their magic bytes', () => {
    expect(detectMimeType(png)).toBe('image/png');
    expect(detectMimeType(jpeg)).toBe('image/jpeg');
    expect(detectMimeType(gif)).toBe('image/gif');
    expect(detectMimeType(webp)).toBe('image/webp');
  });

  it('recognises the supported video formats', () => {
    expect(detectMimeType(webm)).toBe('video/webm');
    expect(detectMimeType(mp4)).toBe('video/mp4');
  });

  it('refuses a file whose bytes are not a supported media type', () => {
    expect(detectMimeType(Buffer.from('<html><body>hi</body></html>', 'utf8'))).toBeNull();
    expect(detectMimeType(Buffer.from('%PDF-1.7', 'utf8'))).toBeNull();
    expect(detectMimeType(Buffer.alloc(0))).toBeNull();
  });

  it('does not mistake a RIFF container that is not WEBP for an image', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE', 'latin1'),
    ]);
    expect(detectMimeType(wav)).toBeNull();
  });

  it('does not accept a short buffer that merely starts with a signature', () => {
    expect(detectMimeType(Buffer.from([0x89, 0x50]))).toBeNull();
  });

  it('only reports types the upload path accepts', () => {
    for (const buffer of [png, jpeg, gif, webp, webm, mp4]) {
      const detected = detectMimeType(buffer);
      expect(detected).not.toBeNull();
      expect(isAllowedMimeType(detected as string)).toBe(true);
    }
  });
});

describe('kind and limits', () => {
  it('maps mime types to a kind', () => {
    expect(kindForMimeType('image/png')).toBe('image');
    expect(kindForMimeType('video/mp4')).toBe('video');
    expect(kindForMimeType('application/pdf')).toBeNull();
  });

  it('allows more bytes for video than for images', () => {
    expect(maxBytesForKind('image', DEFAULT_MEDIA_LIMITS)).toBe(DEFAULT_MEDIA_LIMITS.maxImageBytes);
    expect(maxBytesForKind('video', DEFAULT_MEDIA_LIMITS)).toBe(DEFAULT_MEDIA_LIMITS.maxVideoBytes);
    expect(DEFAULT_MEDIA_LIMITS.maxVideoBytes).toBeGreaterThan(DEFAULT_MEDIA_LIMITS.maxImageBytes);
  });

  it('advertises every supported type', () => {
    expect([...ALLOWED_MIME_TYPES].sort()).toEqual(
      ['image/gif', 'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'].sort()
    );
  });
});

describe('RequestUploadSchema', () => {
  it('accepts a well formed request', () => {
    expect(
      RequestUploadSchema.safeParse({ fileName: 'photo.png', contentType: 'image/png', sizeBytes: 1024 }).success
    ).toBe(true);
  });

  it('rejects a file name that tries to escape the upload prefix', () => {
    for (const fileName of ['../../etc/passwd', 'nested/photo.png', 'nested\\photo.png']) {
      expect(RequestUploadSchema.safeParse({ fileName, contentType: 'image/png', sizeBytes: 10 }).success).toBe(false);
    }
  });

  it('rejects a non positive or absurd size', () => {
    expect(RequestUploadSchema.safeParse({ fileName: 'a.png', contentType: 'image/png', sizeBytes: 0 }).success).toBe(false);
    expect(
      RequestUploadSchema.safeParse({
        fileName: 'a.png',
        contentType: 'image/png',
        sizeBytes: DEFAULT_MEDIA_LIMITS.maxVideoBytes + 1,
      }).success
    ).toBe(false);
  });
});

describe('MediaListQuerySchema', () => {
  it('coerces and bounds pagination', () => {
    expect(MediaListQuerySchema.parse({ page: '3', pageSize: '50' })).toMatchObject({ page: 3, pageSize: 50 });
    expect(MediaListQuerySchema.safeParse({ pageSize: '1000' }).success).toBe(false);
  });

  it('parses the attached filter from a query string', () => {
    expect(MediaListQuerySchema.parse({ attached: 'true' }).attached).toBe(true);
    expect(MediaListQuerySchema.parse({ attached: 'false' }).attached).toBe(false);
  });

  it('rejects an unknown status or kind', () => {
    expect(MediaListQuerySchema.safeParse({ status: 'exploded' }).success).toBe(false);
    expect(MediaListQuerySchema.safeParse({ kind: 'audio' }).success).toBe(false);
  });
});

describe('tip schema accepts media ids', () => {
  const base = { creatorId: 'ckx1234567890abcdefghijkl', amount: 10 };

  it('allows a tip with no media', () => {
    expect(TypesCreateTipSchema.safeParse(base).success).toBe(true);
  });

  it('allows up to the per-tip maximum', () => {
    const mediaIds = Array.from({ length: MAX_MEDIA_PER_TIP }, (_, index) => `media_${index}`);
    expect(TypesCreateTipSchema.safeParse({ ...base, mediaIds }).success).toBe(true);
    expect(PaymentCreateTipSchema.safeParse({ ...base, mediaIds }).success).toBe(true);
  });

  it('refuses more media than a tip may carry', () => {
    const mediaIds = Array.from({ length: MAX_MEDIA_PER_TIP + 1 }, (_, index) => `media_${index}`);
    expect(TypesCreateTipSchema.safeParse({ ...base, mediaIds }).success).toBe(false);
    expect(PaymentCreateTipSchema.safeParse({ ...base, mediaIds }).success).toBe(false);
  });

  it('refuses an empty media id', () => {
    expect(TypesCreateTipSchema.safeParse({ ...base, mediaIds: [''] }).success).toBe(false);
    expect(PaymentCreateTipSchema.safeParse({ ...base, mediaIds: ['  '] }).success).toBe(false);
  });
});
