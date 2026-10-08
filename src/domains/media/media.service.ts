/**
 * Tip media service (issue #64).
 *
 * Owns the whole upload lifecycle: reserve a slot (quota checked before any byte
 * moves), receive the bytes, verify what they actually are, scan them, commit the
 * quota, process derivatives, attach to a tip, and release everything on delete.
 * Only a `ready`, unowned-by-nobody-else, unattached media item can be attached to
 * a tip, and an attached item cannot be deleted out from under it.
 */

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { ConflictError, NotFoundError, PayloadTooLargeError, ValidationError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import {
  DEFAULT_MEDIA_LIMITS,
  DEFAULT_MEDIA_PAGE_SIZE,
  EXTENSION_BY_MIME,
  MAX_MEDIA_PER_TIP,
  MAX_MEDIA_PAGE_SIZE,
  RESERVED_STATUSES,
  detectMimeType,
  isAllowedMimeType,
  kindForMimeType,
  maxBytesForKind,
  type AllowedMimeType,
  type MediaDerivative,
  type MediaKind,
  type MediaLimits,
  type MediaListQuery,
  type MediaStatus,
  type MediaView,
  type QuotaView,
  type RequestUploadInput,
} from './media.types';
import { buildCdnUrl, type MediaStorage, type UploadTarget } from './media.storage';
import { collect, type MalwareScanner } from './media.scanner';
import type { MediaProcessor } from './media.processor';

export interface MediaRow {
  id: string;
  userId: string;
  tipId: string | null;
  kind: string;
  status: string;
  mimeType: string;
  fileName: string;
  storageKey: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  derivatives: unknown;
  processingStatus: string;
  processingError: string | null;
  scanner: string | null;
  scanSignature: string | null;
  scanCompletedAt: Date | null;
  uploadedAt: Date | null;
  attachedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Default enqueue hook. Imported lazily so building a `MediaService` does not
 * pull in the BullMQ/Redis connections (tests and workers that pass their own
 * `enqueueProcessing` never touch Redis).
 */
async function defaultEnqueueProcessing(mediaId: string): Promise<void> {
  const { enqueueMediaProcessing } = await import('./media.queue');
  await enqueueMediaProcessing(mediaId);
}

export interface MediaServiceOptions {
  limits?: Partial<MediaLimits>;
  cdnBaseUrl?: string;
  /** How the bytes reach storage: presigned direct upload, or through the API. */
  uploadMode?: 'direct' | 'proxy';
  /** Path the API serves media from; used to build relative URLs. */
  apiPath?: string;
  now?: () => number;
  enqueueProcessing?: (mediaId: string) => Promise<void>;
}

export class MediaService {
  private readonly limits: MediaLimits;
  private readonly apiPath: string;
  private readonly uploadMode: 'direct' | 'proxy';
  private readonly now: () => number;
  private readonly enqueue: (mediaId: string) => Promise<void>;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: MediaStorage,
    private readonly scanner: MalwareScanner,
    private readonly processor: MediaProcessor,
    private readonly options: MediaServiceOptions = {}
  ) {
    this.limits = { ...DEFAULT_MEDIA_LIMITS, ...(options.limits ?? {}) };
    this.apiPath = options.apiPath ?? '/api/v1/media';
    this.uploadMode = options.uploadMode ?? 'direct';
    this.now = options.now ?? (() => Date.now());
    this.enqueue = options.enqueueProcessing ?? defaultEnqueueProcessing;
  }

  // ── Upload lifecycle ───────────────────────────────────────────────────────

  /**
   * Reserves a slot and returns where to PUT the bytes. Nothing is stored and no
   * quota is committed until `completeUpload` has verified and scanned the file.
   */
  async requestUpload(
    userId: string,
    input: RequestUploadInput
  ): Promise<{ media: MediaView; upload: UploadTarget }> {
    const kind = this.assertUploadable(input.contentType, input.sizeBytes);
    await this.assertWithinQuota(userId, input.sizeBytes);

    const id = randomUUID();
    const media: MediaRow = (await this.prisma.tipMedia.create({
      data: {
        id,
        userId,
        kind,
        status: 'pending',
        mimeType: input.contentType,
        fileName: input.fileName,
        storageKey: this.originalKey(userId, id, input.contentType),
        sizeBytes: input.sizeBytes,
        processingStatus: 'pending',
        derivatives: [],
      },
    })) as MediaRow;

    const upload =
      this.uploadMode === 'direct'
        ? await this.storage.createUploadTarget({
            key: media.storageKey,
            contentType: media.mimeType,
            ttlSeconds: this.limits.uploadTtlSeconds,
          })
        : {
            url: `${this.apiPath}/uploads/${media.id}/content`,
            method: 'PUT' as const,
            headers: { 'Content-Type': media.mimeType },
            expiresAt: new Date(this.now() + this.limits.uploadTtlSeconds * 1000).toISOString(),
          };

    return { media: this.toView(media), upload };
  }

  /** Proxy upload path: the bytes arrive through the API instead of S3. */
  async writeUploadedContent(userId: string, mediaId: string, content: Buffer): Promise<MediaView> {
    const media = await this.requireOwned(userId, mediaId);
    if (media.status !== 'pending') {
      throw new ConflictError(`This upload is already ${media.status}`, { status: media.status });
    }

    this.assertUploadable(media.mimeType, content.byteLength);
    await this.storage.putObject({
      key: media.storageKey,
      body: content,
      contentType: media.mimeType,
    });

    const updated = (await this.prisma.tipMedia.update({
      where: { id: media.id },
      data: { status: 'uploaded', sizeBytes: content.byteLength, uploadedAt: new Date(this.now()) },
    })) as MediaRow;

    return this.toView(updated);
  }

  /**
   * Verifies the stored object: real type (magic bytes), real size, malware scan.
   * A rejected upload has its bytes removed, so nothing unsafe is left in the
   * bucket, and the reason is recorded on the row.
   */
  async completeUpload(userId: string, mediaId: string): Promise<MediaView> {
    const media = await this.requireOwned(userId, mediaId);
    if (media.status === 'ready') return this.toView(media);
    if (media.status !== 'pending' && media.status !== 'uploaded') {
      throw new ConflictError(`This upload cannot be verified while it is ${media.status}`, {
        status: media.status,
      });
    }

    const head = await this.storage.head(media.storageKey);
    if (!head) {
      await this.markFailed(media.id, 'the upload never arrived in storage');
      throw new NotFoundError('Upload');
    }

    const kind = (media.kind as MediaKind) ?? 'image';
    const maxBytes = maxBytesForKind(kind, this.limits);
    if (head.sizeBytes > maxBytes) {
      await this.reject(media, `file is ${head.sizeBytes} bytes, the limit is ${maxBytes}`);
      throw new PayloadTooLargeError('File exceeds the size limit for its type', {
        sizeBytes: head.sizeBytes,
        maxBytes,
      });
    }

    const object = await this.storage.getObject(media.storageKey);
    const buffer = await collect(object.body, maxBytes);

    const detected = detectMimeType(buffer.subarray(0, 64));
    if (!detected || detected !== media.mimeType) {
      await this.reject(
        media,
        detected
          ? `file content is ${detected}, not ${media.mimeType}`
          : `file content is not a supported ${kind} type`
      );
      throw new ValidationError('File content does not match its declared type', {
        declared: media.mimeType,
        detected,
      });
    }

    await this.prisma.tipMedia.update({ where: { id: media.id }, data: { status: 'scanning' } });

    let scan;
    try {
      scan = await this.scanner.scan(buffer);
    } catch (error) {
      // A scanner that cannot run is not a pass: the upload stays unusable and the
      // reason is recorded so it can be retried once scanning is healthy again.
      await this.markFailed(media.id, error instanceof Error ? error.message : 'malware scan failed');
      throw error;
    }

    if (!scan.clean) {
      await this.reject(media, `scanner ${scan.scanner} reported ${scan.signature ?? 'malware'}`);
      throw new ValidationError('Upload failed the malware scan', { signature: scan.signature });
    }

    const updated = (await this.prisma.tipMedia.update({
      where: { id: media.id },
      data: {
        status: 'ready',
        sizeBytes: buffer.byteLength,
        uploadedAt: media.uploadedAt ?? new Date(this.now()),
        scanner: scan.scanner,
        scanSignature: null,
        scanCompletedAt: new Date(this.now()),
      },
    })) as MediaRow;

    await this.commitQuota(userId, buffer.byteLength, 1);
    await this.enqueue(media.id);

    logger.info({ mediaId: media.id, kind, size: buffer.byteLength }, 'Media verified and ready');

    return this.toView(updated);
  }

  /**
   * Post-verification step, run from the image-processing worker: resize/optimise
   * images, probe and transcode videos, generate previews. A processor that is
   * not available leaves the original in place and records why.
   */
  async processMedia(mediaId: string): Promise<{
    status: string;
    processor: string;
    derivatives: number;
    error?: string;
  }> {
    const media = (await this.prisma.tipMedia.findUnique({ where: { id: mediaId } })) as MediaRow | null;
    if (!media) throw new NotFoundError('Media');
    if (media.status !== 'ready') {
      return { status: 'skipped', processor: this.processor.name, derivatives: 0, error: `media is ${media.status}` };
    }

    const object = await this.storage.getObject(media.storageKey);
    const buffer = await collect(object.body, maxBytesForKind(media.kind as MediaKind, this.limits));

    const result = await this.processor.process({
      kind: media.kind as MediaKind,
      mimeType: media.mimeType,
      fileName: media.fileName,
      buffer,
    });

    const derivatives: MediaDerivative[] = [];
    for (const derivative of result.derivatives) {
      const key = this.derivativeKey(media, derivative.variant, derivative.mimeType);
      await this.storage.putObject({ key, body: derivative.bytes, contentType: derivative.mimeType });
      derivatives.push({
        variant: derivative.variant,
        key,
        mimeType: derivative.mimeType,
        bytes: derivative.bytes.byteLength,
        width: derivative.width,
        height: derivative.height,
      });
    }

    await this.prisma.tipMedia.update({
      where: { id: media.id },
      data: {
        derivatives,
        processingStatus: result.status,
        processingError: result.error ?? null,
        width: media.width ?? result.width ?? null,
        height: media.height ?? result.height ?? null,
        durationSeconds: media.durationSeconds ?? result.durationSeconds ?? null,
      },
    });

    return {
      status: result.status,
      processor: result.processor,
      derivatives: derivatives.length,
      error: result.error,
    };
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  async getMedia(userId: string, mediaId: string): Promise<MediaView> {
    return this.toView(await this.requireOwned(userId, mediaId));
  }

  async listMine(userId: string, query: MediaListQuery = {}): Promise<{
    items: MediaView[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const page = Math.max(query.page ?? 1, 1);
    const pageSize = Math.min(query.pageSize ?? DEFAULT_MEDIA_PAGE_SIZE, MAX_MEDIA_PAGE_SIZE);

    const where: Record<string, unknown> = { userId };
    if (query.status) where.status = query.status;
    if (query.kind) where.kind = query.kind;
    if (query.attached === true) where.tipId = { not: null };
    if (query.attached === false) where.tipId = null;

    const [rows, total] = await Promise.all([
      this.prisma.tipMedia.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.tipMedia.count({ where }),
    ]);

    return {
      items: (rows as MediaRow[]).map((row) => this.toView(row)),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize) || 1,
    };
  }

  /** Media attached to a tip, in the order it was attached. */
  async listForTip(tipId: string): Promise<MediaView[]> {
    const rows = (await this.prisma.tipMedia.findMany({
      where: { tipId },
      orderBy: { attachedAt: 'asc' },
    })) as MediaRow[];

    return rows.filter((row) => row.status === 'ready').map((row) => this.toView(row));
  }

  /**
   * Whether a viewer may read the bytes behind a media id: its owner always can,
   * and anyone can read media attached to a tip that is visible.
   */
  async canRead(viewerId: string | null, media: MediaRow): Promise<boolean> {
    if (viewerId && media.userId === viewerId) return true;
    if (!media.tipId) return false;

    const tip = await this.prisma.tip.findUnique({
      where: { id: media.tipId },
      select: { moderationState: true },
    });
    return Boolean(tip) && (tip?.moderationState ?? 'visible') === 'visible';
  }

  async findById(mediaId: string): Promise<MediaRow | null> {
    return (await this.prisma.tipMedia.findUnique({ where: { id: mediaId } })) as MediaRow | null;
  }

  // ── Tip attachment ─────────────────────────────────────────────────────────

  /**
   * Attaches media to a tip. Every id must be the caller's own, verified and not
   * already attached, so one upload cannot be reused across tips.
   */
  async attachToTip(userId: string, tipId: string, mediaIds: string[]): Promise<MediaRow[]> {
    const unique = [...new Set(mediaIds)].filter(Boolean);
    if (unique.length === 0) return [];
    if (unique.length > MAX_MEDIA_PER_TIP) {
      throw new ValidationError(`A tip can carry at most ${MAX_MEDIA_PER_TIP} media items`, {
        maxMediaPerTip: MAX_MEDIA_PER_TIP,
        requested: unique.length,
      });
    }

    const rows = (await this.prisma.tipMedia.findMany({ where: { id: { in: unique } } })) as MediaRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));

    const problems: Array<{ mediaId: string; problem: string }> = [];
    for (const mediaId of unique) {
      const row = byId.get(mediaId);
      if (!row) problems.push({ mediaId, problem: 'not found' });
      else if (row.userId !== userId) problems.push({ mediaId, problem: 'not owned by this user' });
      else if (row.status !== 'ready') problems.push({ mediaId, problem: `is ${row.status}` });
      else if (row.tipId) problems.push({ mediaId, problem: 'already attached to another tip' });
    }

    if (problems.length > 0) {
      throw new ValidationError('Some media cannot be attached to this tip', { problems });
    }

    await this.prisma.tipMedia.updateMany({
      where: { id: { in: unique } },
      data: { tipId, attachedAt: new Date(this.now()) },
    });

    return unique.map((mediaId) => ({ ...(byId.get(mediaId) as MediaRow), tipId }));
  }

  // ── Deletion and quota ─────────────────────────────────────────────────────

  /** Deletes media and its derivatives, releasing the quota it held. */
  async deleteMedia(userId: string, mediaId: string, options: { isAdmin?: boolean } = {}): Promise<void> {
    const media = await this.requireOwned(userId, mediaId, options.isAdmin);

    if (media.tipId) {
      throw new ConflictError('Media attached to a tip cannot be deleted', { tipId: media.tipId });
    }

    await this.storage.delete(this.allKeys(media));
    await this.prisma.tipMedia.delete({ where: { id: media.id } });

    if (media.status === 'ready') {
      await this.commitQuota(media.userId, -media.sizeBytes, -1);
    }
  }

  async getQuota(userId: string): Promise<QuotaView> {
    const quota = await this.ensureQuota(userId);
    const reserved = await this.prisma.tipMedia.aggregate({
      where: { userId, status: { in: RESERVED_STATUSES } },
      _sum: { sizeBytes: true },
    });
    const reservedBytes = reserved._sum?.sizeBytes ?? 0;

    return {
      usedBytes: quota.usedBytes,
      reservedBytes,
      limitBytes: quota.limitBytes,
      fileCount: quota.fileCount,
      remainingBytes: Math.max(0, quota.limitBytes - quota.usedBytes - reservedBytes),
    };
  }

  /**
   * Housekeeping: uploads that were reserved but never completed. Their bytes (if
   * any) are removed and the rows are closed as `failed`, so a user who abandons
   * an upload does not permanently lose the quota it reserved.
   */
  async pruneStaleUploads(olderThanMinutes = 60 * 24): Promise<{ pruned: number }> {
    const cutoff = new Date(this.now() - olderThanMinutes * 60 * 1000);
    const rows = (await this.prisma.tipMedia.findMany({
      where: {
        status: { in: ['pending', 'uploaded'] },
        tipId: null,
        createdAt: { lt: cutoff },
      },
      take: 500,
    })) as MediaRow[];

    for (const row of rows) {
      try {
        await this.storage.delete(this.allKeys(row));
      } catch (error) {
        logger.warn({ err: error, mediaId: row.id }, 'Failed to delete an abandoned upload');
      }
      await this.markFailed(row.id, 'upload was never completed');
    }

    if (rows.length > 0) logger.info({ pruned: rows.length }, 'Pruned stale media uploads');
    return { pruned: rows.length };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private assertUploadable(contentType: string, sizeBytes: number): MediaKind {
    if (!isAllowedMimeType(contentType)) {
      throw new ValidationError('Unsupported media type', {
        contentType,
        allowed: Object.keys(EXTENSION_BY_MIME),
      });
    }
    const kind = kindForMimeType(contentType);
    if (!kind) {
      throw new ValidationError('Unsupported media type', { contentType });
    }

    const maxBytes = maxBytesForKind(kind, this.limits);
    if (sizeBytes > maxBytes) {
      throw new PayloadTooLargeError(`${kind === 'image' ? 'Image' : 'Video'} exceeds the size limit`, {
        sizeBytes,
        maxBytes,
      });
    }
    return kind;
  }

  private async assertWithinQuota(userId: string, additionalBytes: number): Promise<void> {
    const quota = await this.getQuota(userId);
    if (quota.usedBytes + quota.reservedBytes + additionalBytes > quota.limitBytes) {
      throw new PayloadTooLargeError('Storage quota exceeded', {
        limitBytes: quota.limitBytes,
        usedBytes: quota.usedBytes,
        reservedBytes: quota.reservedBytes,
        requestedBytes: additionalBytes,
      });
    }
  }

  private async ensureQuota(userId: string): Promise<{ usedBytes: number; fileCount: number; limitBytes: number }> {
    const existing = await this.prisma.mediaQuota.findUnique({ where: { userId } });
    if (existing) return existing;

    return this.prisma.mediaQuota.upsert({
      where: { userId },
      create: { userId, usedBytes: 0, fileCount: 0, limitBytes: this.limits.defaultQuotaBytes },
      update: {},
    });
  }

  private async commitQuota(userId: string, deltaBytes: number, deltaFiles: number): Promise<void> {
    const quota = await this.ensureQuota(userId);
    await this.prisma.mediaQuota.update({
      where: { userId },
      data: {
        usedBytes: Math.max(0, quota.usedBytes + deltaBytes),
        fileCount: Math.max(0, quota.fileCount + deltaFiles),
      },
    });
  }

  private async reject(media: MediaRow, reason: string): Promise<void> {
    await this.storage.delete(this.allKeys(media)).catch((error) => {
      logger.warn({ err: error, mediaId: media.id }, 'Failed to remove a rejected upload');
    });

    await this.prisma.tipMedia.update({
      where: { id: media.id },
      data: {
        status: 'rejected',
        processingStatus: 'skipped',
        processingError: reason,
        scanCompletedAt: new Date(this.now()),
      },
    });
  }

  private async markFailed(mediaId: string, reason: string): Promise<void> {
    await this.prisma.tipMedia.update({
      where: { id: mediaId },
      data: { status: 'failed', processingStatus: 'failed', processingError: reason },
    });
  }

  private async requireOwned(userId: string, mediaId: string, isAdmin = false): Promise<MediaRow> {
    const media = await this.findById(mediaId);
    if (!media) throw new NotFoundError('Media');
    if (!isAdmin && media.userId !== userId) throw new NotFoundError('Media');
    return media;
  }

  private originalKey(userId: string, mediaId: string, mimeType: string): string {
    const extension = isAllowedMimeType(mimeType) ? EXTENSION_BY_MIME[mimeType] : 'bin';
    return `media/${userId}/${mediaId}/original.${extension}`;
  }

  private derivativeKey(media: MediaRow, variant: string, mimeType: string): string {
    const extension = isAllowedMimeType(mimeType) ? EXTENSION_BY_MIME[mimeType] : 'bin';
    return `media/${media.userId}/${media.id}/${variant}.${extension}`;
  }

  private allKeys(media: MediaRow): string[] {
    const derivatives = Array.isArray(media.derivatives) ? (media.derivatives as MediaDerivative[]) : [];
    return [media.storageKey, ...derivatives.map((derivative) => derivative.key)];
  }

  private toView(media: MediaRow): MediaView {
    const derivatives = Array.isArray(media.derivatives) ? (media.derivatives as MediaDerivative[]) : [];
    const derivativeUrl = (variant: string): string | null => {
      const derivative = derivatives.find((entry) => entry.variant === variant);
      if (!derivative) return null;
      return buildCdnUrl(this.options.cdnBaseUrl, derivative.key) ?? `${this.apiPath}/${media.id}/content?variant=${variant}`;
    };

    return {
      id: media.id,
      kind: media.kind as MediaKind,
      status: media.status as MediaStatus,
      mimeType: media.mimeType,
      fileName: media.fileName,
      sizeBytes: media.sizeBytes,
      width: media.width ?? null,
      height: media.height ?? null,
      durationSeconds: media.durationSeconds ?? null,
      url: buildCdnUrl(this.options.cdnBaseUrl, media.storageKey) ?? `${this.apiPath}/${media.id}/content`,
      previewUrl: derivativeUrl('preview'),
      thumbnailUrl: derivativeUrl('thumbnail'),
      processing: {
        status: media.processingStatus as MediaView['processing']['status'],
        error: media.processingError ?? null,
      },
      createdAt: media.createdAt.toISOString(),
      attachedTipId: media.tipId,
    };
  }
}

export function createMediaService(
  prisma: PrismaClient,
  storage: MediaStorage,
  scanner: MalwareScanner,
  processor: MediaProcessor,
  options: MediaServiceOptions = {}
): MediaService {
  return new MediaService(prisma, storage, scanner, processor, options);
}
