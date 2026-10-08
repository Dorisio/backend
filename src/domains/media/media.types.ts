/**
 * Tip media types (issue #64).
 *
 * A tip message can carry images and short videos. Media is uploaded before the
 * tip exists, verified (declared type, real bytes, malware scan), stored in S3
 * or on local disk, optionally processed into smaller derivatives, and attached
 * to a tip at creation time. Everything downstream reads `MediaStatus` and the
 * per-user quota defined here.
 */

import { z } from 'zod';

export const MEDIA_KINDS = ['image', 'video'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Statuses a media row moves through. Only `ready` media can be attached. */
export const MEDIA_STATUSES = [
  'pending', // row created, waiting for the bytes to arrive
  'uploaded', // bytes are in storage, not verified yet
  'scanning', // malware scan in flight
  'ready', // verified and usable on a tip
  'rejected', // failed validation or the scan
  'failed', // storage/processing error the user can retry
] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

/** Statuses whose bytes are set aside but not yet committed to the quota. */
export const RESERVED_STATUSES: MediaStatus[] = ['pending', 'uploaded', 'scanning'];

export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export const VIDEO_MIME_TYPES = ['video/mp4', 'video/webm'] as const;
export const ALLOWED_MIME_TYPES = [...IMAGE_MIME_TYPES, ...VIDEO_MIME_TYPES] as const;
export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

export const EXTENSION_BY_MIME: Record<AllowedMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

export const MIME_BY_EXTENSION: Record<string, AllowedMimeType> = Object.entries(EXTENSION_BY_MIME).reduce(
  (acc, [mime, extension]) => ({ ...acc, [extension]: mime as AllowedMimeType }),
  {} as Record<string, AllowedMimeType>
);

export function kindForMimeType(mimeType: string): MediaKind | null {
  if ((IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) return 'image';
  if ((VIDEO_MIME_TYPES as readonly string[]).includes(mimeType)) return 'video';
  return null;
}

export function isAllowedMimeType(mimeType: string): mimeType is AllowedMimeType {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType);
}

/**
 * Magic number sniffing. The declared `contentType` and the file extension are
 * both attacker-controlled, so the bytes decide what a file really is.
 */
interface Signature {
  mimeType: AllowedMimeType;
  /** Byte offset the signature starts at. */
  offset: number;
  bytes: number[];
  /** Optional ASCII marker at the same offset (RIFF/WEBP, MP4 ftyp). */
  ascii?: string;
  /** For RIFF containers: the container marker sits after the 4 byte size. */
  containerAscii?: { offset: number; value: string };
}

const SIGNATURES: Signature[] = [
  { mimeType: 'image/jpeg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { mimeType: 'image/png', offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: 'image/gif', offset: 0, bytes: [0x47, 0x49, 0x46, 0x38], ascii: 'GIF8' },
  { mimeType: 'image/webp', offset: 0, bytes: [0x52, 0x49, 0x46, 0x46], ascii: 'RIFF', containerAscii: { offset: 8, value: 'WEBP' } },
  { mimeType: 'video/mp4', offset: 4, bytes: [0x66, 0x74, 0x79, 0x70], ascii: 'ftyp' },
  { mimeType: 'video/webm', offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3] },
];

/**
 * Returns the mime type the bytes actually are, or `null` when nothing matches.
 */
export function detectMimeType(buffer: Uint8Array): AllowedMimeType | null {
  for (const signature of SIGNATURES) {
    const slice = buffer.slice(signature.offset, signature.offset + signature.bytes.length);
    if (slice.length !== signature.bytes.length) continue;
    if (!signature.bytes.every((byte, index) => slice[index] === byte)) continue;

    if (signature.containerAscii) {
      const marker = buffer.slice(
        signature.containerAscii.offset,
        signature.containerAscii.offset + signature.containerAscii.value.length
      );
      if (String.fromCharCode(...marker) !== signature.containerAscii.value) continue;
    }

    return signature.mimeType;
  }
  return null;
}

// ── Limits ──────────────────────────────────────────────────────────────────

/** How many media items one tip message may carry. */
export const MAX_MEDIA_PER_TIP = 4;
/** How many media items one upload request batch may declare. */
export const DEFAULT_UPLOAD_TTL_SECONDS = 15 * 60;
export const MAX_UPLOAD_TTL_SECONDS = 60 * 60;

export interface MediaLimits {
  maxImageBytes: number;
  maxVideoBytes: number;
  defaultQuotaBytes: number;
  uploadTtlSeconds: number;
}

export const DEFAULT_MEDIA_LIMITS: MediaLimits = {
  maxImageBytes: 8 * 1024 * 1024,
  maxVideoBytes: 64 * 1024 * 1024,
  defaultQuotaBytes: 256 * 1024 * 1024,
  uploadTtlSeconds: DEFAULT_UPLOAD_TTL_SECONDS,
};

export function maxBytesForKind(kind: MediaKind, limits: MediaLimits = DEFAULT_MEDIA_LIMITS): number {
  return kind === 'image' ? limits.maxImageBytes : limits.maxVideoBytes;
}

/** Derivative variants the processor can produce. */
export const DERIVATIVE_VARIANTS = ['preview', 'optimized', 'thumbnail'] as const;
export type DerivativeVariant = (typeof DERIVATIVE_VARIANTS)[number];

export interface MediaDerivative {
  variant: DerivativeVariant;
  key: string;
  mimeType: AllowedMimeType;
  bytes: number;
  width?: number;
  height?: number;
}

export const PROCESSING_STATUSES = ['pending', 'done', 'skipped', 'failed'] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

// ── Request schemas ─────────────────────────────────────────────────────────

const fileNameSchema = z
  .string()
  .trim()
  .min(1, 'fileName is required')
  .max(255, 'fileName is too long')
  .refine((value) => !value.includes('/') && !value.includes('\\'), { message: 'fileName must not contain a path' })
  .refine((value) => !value.includes('\0'), { message: 'fileName must not contain control characters' });

/** POST /api/v1/media/uploads */
export const RequestUploadSchema = z.object({
  fileName: fileNameSchema,
  contentType: z.string().trim().max(100),
  sizeBytes: z
    .number()
    .int('sizeBytes must be an integer')
    .positive('sizeBytes must be greater than 0')
    .max(DEFAULT_MEDIA_LIMITS.maxVideoBytes, 'sizeBytes exceeds the maximum upload size'),
});

export type RequestUploadInput = z.infer<typeof RequestUploadSchema>;

/** PUT /api/v1/media/uploads/:mediaId/content — dev/local storage path. */
export const UploadContentSchema = z.object({
  /** Base64 encoded file body. */
  content: z.string().min(1, 'content is required'),
});

export type UploadContentInput = z.infer<typeof UploadContentSchema>;

/** GET /api/v1/media */
export const MediaListQuerySchema = z.object({
  status: z.enum(MEDIA_STATUSES).optional(),
  kind: z.enum(MEDIA_KINDS).optional(),
  attached: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === true || value === 'true')),
  page: z.coerce.number().int().min(1).max(1000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export type MediaListQuery = z.infer<typeof MediaListQuerySchema>;

/** Wire shape of a media item. */
export interface MediaView {
  id: string;
  kind: MediaKind;
  status: MediaStatus;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  url: string;
  previewUrl: string | null;
  thumbnailUrl: string | null;
  processing: { status: ProcessingStatus; error: string | null };
  createdAt: string;
  attachedTipId: string | null;
}

export interface QuotaView {
  usedBytes: number;
  reservedBytes: number;
  limitBytes: number;
  fileCount: number;
  remainingBytes: number;
}

export const DEFAULT_MEDIA_PAGE_SIZE = 20;
export const MAX_MEDIA_PAGE_SIZE = 100;
