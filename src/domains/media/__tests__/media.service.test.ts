/**
 * Media service behaviour (#64).
 *
 * These cover the parts of the upload lifecycle that are easy to get subtly
 * wrong and expensive to get wrong in production: quota is only committed after
 * verification, a file whose bytes disagree with its declared type is refused and
 * removed, a dirty scan never becomes `ready`, and media can only ever be
 * attached to one tip by its owner.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MediaService } from '../media.service';
import { FakeMediaPrisma, asPrisma } from './fake-media-prisma';
import {
  EICAR_BYTES,
  InMemoryStorage,
  NoopProcessor,
  PNG_BYTES,
  StubProcessor,
  StubScanner,
  ThrowingScanner,
} from './fakes';

const USER = 'user_1';

function build(
  overrides: {
    scanner?: any;
    processor?: any;
    limits?: Record<string, number>;
    enqueue?: (mediaId: string) => Promise<void>;
  } = {}
) {
  const fake = new FakeMediaPrisma();
  const storage = new InMemoryStorage();
  const scanner = overrides.scanner ?? new StubScanner();
  const processor = overrides.processor ?? new NoopProcessor();
  const enqueued: string[] = [];

  const service = new MediaService(asPrisma(fake), storage, scanner, processor, {
    limits: { maxImageBytes: 1024, maxVideoBytes: 4096, defaultQuotaBytes: 10_000, ...overrides.limits },
    enqueueProcessing: overrides.enqueue ?? (async (id) => void enqueued.push(id)),
    now: () => Date.now(),
    cdnBaseUrl: 'https://cdn.test',
  });

  return { fake, storage, scanner, processor, service, enqueued };
}

describe('MediaService.requestUpload', () => {
  it('reserves a pending row without committing quota', async () => {
    const { service, fake, storage } = build();

    const { media, upload } = await service.requestUpload(USER, {
      fileName: 'photo.png',
      contentType: 'image/png',
      sizeBytes: 512,
    });

    expect(media.status).toBe('pending');
    expect(media.kind).toBe('image');
    expect(upload.method).toBe('PUT');
    expect(upload.url).toContain('storage.test');
    expect(fake.tipMedia).toHaveLength(1);
    // Nothing was written to storage and nothing was charged yet; the quota row
    // is only created to answer the check, with nothing counted against it.
    expect(storage.objects.size).toBe(0);
    expect(fake.mediaQuota[0]).toMatchObject({ usedBytes: 0, fileCount: 0 });
  });

  it('refuses a type that is not an allowed media type', async () => {
    const { service } = build();
    await expect(
      service.requestUpload(USER, { fileName: 'x.pdf', contentType: 'application/pdf', sizeBytes: 10 })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses an image larger than the image limit', async () => {
    const { service } = build();
    await expect(
      service.requestUpload(USER, { fileName: 'huge.png', contentType: 'image/png', sizeBytes: 2048 })
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('refuses a reservation that would exceed the storage quota', async () => {
    const { service, fake } = build();
    fake.seedQuota({ userId: USER, usedBytes: 9_800, limitBytes: 10_000, fileCount: 3 });

    await expect(
      service.requestUpload(USER, { fileName: 'p.png', contentType: 'image/png', sizeBytes: 512 })
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('counts in-flight reservations against the quota', async () => {
    const { service, fake } = build();
    fake.seedQuota({ userId: USER, usedBytes: 0, limitBytes: 10_000, fileCount: 0 });
    fake.seedMedia({ userId: USER, status: 'pending', sizeBytes: 9_900 });

    await expect(
      service.requestUpload(USER, { fileName: 'p.png', contentType: 'image/png', sizeBytes: 512 })
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('uses the proxy upload target when uploadMode is proxy', async () => {
    const fake = new FakeMediaPrisma();
    const service = new MediaService(asPrisma(fake), new InMemoryStorage(), new StubScanner(), new NoopProcessor(), {
      uploadMode: 'proxy',
      enqueueProcessing: async () => undefined,
    });

    const { upload } = await service.requestUpload(USER, {
      fileName: 'p.png',
      contentType: 'image/png',
      sizeBytes: 100,
    });

    expect(upload.url).toBe(`/api/v1/media/uploads/${fake.tipMedia[0].id}/content`);
  });
});

describe('MediaService.completeUpload', () => {
  it('verifies, scans, charges quota and queues processing', async () => {
    const { service, fake, storage, enqueued } = build();
    const { media } = await service.requestUpload(USER, {
      fileName: 'photo.png',
      contentType: 'image/png',
      sizeBytes: PNG_BYTES.byteLength,
    });
    await storage.putObject({ key: fake.tipMedia[0].storageKey, body: PNG_BYTES, contentType: 'image/png' });

    const ready = await service.completeUpload(USER, media.id);

    expect(ready.status).toBe('ready');
    expect(fake.tipMedia[0].scanner).toBe('stub');
    expect(fake.mediaQuota[0].usedBytes).toBe(PNG_BYTES.byteLength);
    expect(fake.mediaQuota[0].fileCount).toBe(1);
    expect(enqueued).toEqual([media.id]);
  });

  it('is idempotent once the media is ready', async () => {
    const { service, fake, storage } = build();
    const { media } = await service.requestUpload(USER, {
      fileName: 'photo.png',
      contentType: 'image/png',
      sizeBytes: PNG_BYTES.byteLength,
    });
    await storage.putObject({ key: fake.tipMedia[0].storageKey, body: PNG_BYTES, contentType: 'image/png' });
    await service.completeUpload(USER, media.id);

    const again = await service.completeUpload(USER, media.id);

    expect(again.status).toBe('ready');
    // Quota was charged exactly once.
    expect(fake.mediaQuota[0].fileCount).toBe(1);
  });

  it('marks the upload failed when the bytes never arrived', async () => {
    const { service } = build();
    const { media } = await service.requestUpload(USER, {
      fileName: 'photo.png',
      contentType: 'image/png',
      sizeBytes: 100,
    });

    await expect(service.completeUpload(USER, media.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await service.getMedia(USER, media.id)).status).toBe('failed');
  });

  it('rejects a file whose content does not match its declared type', async () => {
    const { service, fake, storage } = build();
    const { media } = await service.requestUpload(USER, {
      fileName: 'not-an-image.png',
      contentType: 'image/png',
      sizeBytes: 32,
    });
    await storage.putObject({
      key: fake.tipMedia[0].storageKey,
      body: Buffer.from('this is plain text, not a png', 'utf8'),
      contentType: 'image/png',
    });

    await expect(service.completeUpload(USER, media.id)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const row = await service.getMedia(USER, media.id);
    expect(row.status).toBe('rejected');
    // The bytes of a rejected upload are removed, not left in the bucket.
    expect(storage.objects.size).toBe(0);
  });

  it('rejects a file that is over the size limit for its kind', async () => {
    const { service, fake, storage } = build();
    const { media } = await service.requestUpload(USER, {
      fileName: 'photo.png',
      contentType: 'image/png',
      sizeBytes: 100,
    });
    await storage.putObject({
      key: fake.tipMedia[0].storageKey,
      body: Buffer.concat([PNG_BYTES, Buffer.alloc(2048)]),
      contentType: 'image/png',
    });

    await expect(service.completeUpload(USER, media.id)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect((await service.getMedia(USER, media.id)).status).toBe('rejected');
  });

  it('does not mark a malware-positive upload ready', async () => {
    const { service, fake, storage } = build({
      scanner: new StubScanner({ clean: false, signature: 'Eicar-Test-Signature' }),
    });
    const { media } = await service.requestUpload(USER, {
      fileName: 'photo.png',
      contentType: 'image/png',
      sizeBytes: PNG_BYTES.byteLength,
    });
    await storage.putObject({ key: fake.tipMedia[0].storageKey, body: PNG_BYTES, contentType: 'image/png' });

    await expect(service.completeUpload(USER, media.id)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const row = await service.getMedia(USER, media.id);
    expect(row.status).toBe('rejected');
    // Nothing was charged for a rejected upload.
    expect(fake.mediaQuota[0]).toMatchObject({ usedBytes: 0, fileCount: 0 });
    expect(storage.objects.size).toBe(0);
  });

  it('fails closed when the scanner itself errors', async () => {
    const { service, fake, storage } = build({ scanner: new ThrowingScanner() });
    const { media } = await service.requestUpload(USER, {
      fileName: 'photo.png',
      contentType: 'image/png',
      sizeBytes: PNG_BYTES.byteLength,
    });
    await storage.putObject({ key: fake.tipMedia[0].storageKey, body: PNG_BYTES, contentType: 'image/png' });

    await expect(service.completeUpload(USER, media.id)).rejects.toThrow('clamd unreachable');
    expect((await service.getMedia(USER, media.id)).status).toBe('failed');
    expect(fake.mediaQuota[0]).toMatchObject({ usedBytes: 0, fileCount: 0 });
  });

  it('refuses a media id owned by somebody else', async () => {
    const { service, fake, storage } = build();
    const { media } = await service.requestUpload(USER, {
      fileName: 'photo.png',
      contentType: 'image/png',
      sizeBytes: PNG_BYTES.byteLength,
    });
    await storage.putObject({ key: fake.tipMedia[0].storageKey, body: PNG_BYTES, contentType: 'image/png' });

    await expect(service.completeUpload('user_2', media.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('MediaService.processMedia', () => {
  it('skips media that is not ready yet', async () => {
    const { service, fake } = build();
    fake.seedMedia({ id: 'media_pending', userId: USER, status: 'uploaded' });

    const result = await service.processMedia('media_pending');

    expect(result.status).toBe('skipped');
    expect(result.error).toContain('uploaded');
  });

  it('stores derivatives and records their keys on the row', async () => {
    const processor = new StubProcessor({
      derivatives: [{ variant: 'thumbnail', mimeType: 'image/webp', bytes: Buffer.from('thumb'), width: 64, height: 64 }],
    });
    const { service, fake, storage } = build({ processor });

    fake.seedMedia({ id: 'media_ready', userId: USER, status: 'ready' });
    storage.objects.set(fake.tipMedia[0].storageKey, { body: PNG_BYTES, contentType: 'image/png' });

    const result = await service.processMedia('media_ready');

    expect(result).toMatchObject({ status: 'done', derivatives: 1 });
    const row = await service.findById('media_ready');
    expect(row?.processingStatus).toBe('done');
    expect(storage.objects.has(`media/${USER}/media_ready/thumbnail.webp`)).toBe(true);
  });

  it('records why processing was skipped without failing the media', async () => {
    const { service, fake, storage } = build({ processor: new NoopProcessor() });
    fake.seedMedia({ id: 'media_ready', userId: USER, status: 'ready' });
    storage.objects.set(fake.tipMedia[0].storageKey, { body: PNG_BYTES, contentType: 'image/png' });

    const result = await service.processMedia('media_ready');

    expect(result.status).toBe('skipped');
    const row = await service.findById('media_ready');
    expect(row?.status).toBe('ready');
    expect(row?.processingError).toContain('nothing available');
  });
});

describe('MediaService.attachToTip', () => {
  it('attaches ready, owned, unattached media to a tip', async () => {
    const { service, fake } = build();
    const media = fake.seedMedia({ userId: USER, status: 'ready' });

    const rows = await service.attachToTip(USER, 'tip_1', [media.id]);

    expect(rows[0].tipId).toBe('tip_1');
    expect(fake.tipMedia[0].tipId).toBe('tip_1');
    expect(fake.tipMedia[0].attachedAt).toBeInstanceOf(Date);
  });

  it('refuses media owned by another user', async () => {
    const { service, fake } = build();
    const media = fake.seedMedia({ userId: 'user_2', status: 'ready' });

    await expect(service.attachToTip(USER, 'tip_1', [media.id])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(fake.tipMedia[0].tipId).toBeNull();
  });

  it('refuses media that is still processing', async () => {
    const { service, fake } = build();
    const media = fake.seedMedia({ userId: USER, status: 'scanning' });

    await expect(service.attachToTip(USER, 'tip_1', [media.id])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('refuses an upload that is already attached to another tip', async () => {
    const { service, fake } = build();
    const media = fake.seedMedia({ userId: USER, status: 'ready', tipId: 'tip_other' });

    await expect(service.attachToTip(USER, 'tip_1', [media.id])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(fake.tipMedia[0].tipId).toBe('tip_other');
  });

  it('refuses more media than a tip may carry', async () => {
    const { service } = build();
    await expect(
      service.attachToTip(USER, 'tip_1', ['a', 'b', 'c', 'd', 'e'])
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('reports every problem in one response', async () => {
    const { service, fake } = build();
    const foreign = fake.seedMedia({ userId: 'user_2', status: 'ready' });
    const pending = fake.seedMedia({ userId: USER, status: 'pending' });

    await expect(service.attachToTip(USER, 'tip_1', [foreign.id, pending.id])).rejects.toMatchObject({
      details: {
        problems: [
          { mediaId: foreign.id, problem: 'not owned by this user' },
          { mediaId: pending.id, problem: 'is pending' },
        ],
      },
    });
  });

  it('deduplicates repeated ids', async () => {
    const { service, fake } = build();
    const media = fake.seedMedia({ userId: USER, status: 'ready' });

    const rows = await service.attachToTip(USER, 'tip_1', [media.id, media.id]);

    expect(rows).toHaveLength(1);
  });
});

describe('MediaService.listForTip and canRead', () => {
  it('lists only ready media attached to the tip, in attachment order', async () => {
    const { service, fake } = build();
    fake.seedMedia({ userId: USER, tipId: 'tip_1', status: 'ready', attachedAt: new Date(1) });
    fake.seedMedia({ userId: USER, tipId: 'tip_1', status: 'rejected', attachedAt: new Date(2) });
    fake.seedMedia({ userId: USER, tipId: 'tip_2', status: 'ready', attachedAt: new Date(3) });

    const items = await service.listForTip('tip_1');

    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('ready');
  });

  it('lets the owner read, and anyone read media on a visible tip', async () => {
    const { service, fake } = build();
    const own = fake.seedMedia({ userId: USER, status: 'pending' });
    fake.seedTip({ id: 'tip_1', moderationState: 'visible' });
    const attached = fake.seedMedia({ userId: 'user_9', tipId: 'tip_1', status: 'ready' });

    expect(await service.canRead(USER, own)).toBe(true);
    expect(await service.canRead('stranger', own)).toBe(false);
    expect(await service.canRead('stranger', attached)).toBe(true);
  });

  it('hides media whose tip has been taken down', async () => {
    const { service, fake } = build();
    fake.seedTip({ id: 'tip_1', moderationState: 'hidden' });
    const attached = fake.seedMedia({ userId: 'user_9', tipId: 'tip_1', status: 'ready' });

    expect(await service.canRead('stranger', attached)).toBe(false);
    // The owner of the media still sees their own upload.
    expect(await service.canRead('user_9', attached)).toBe(true);
  });
});

describe('MediaService.deleteMedia', () => {
  it('removes the original and derivatives and releases quota', async () => {
    const { service, fake, storage } = build();
    const media = fake.seedMedia({
      id: 'media_1',
      userId: USER,
      status: 'ready',
      sizeBytes: 900,
      derivatives: [{ variant: 'thumbnail', key: 'media/user_1/media_1/thumbnail.webp', mimeType: 'image/webp', bytes: 10 }],
    });
    storage.objects.set(media.storageKey, { body: PNG_BYTES, contentType: 'image/png' });
    storage.objects.set('media/user_1/media_1/thumbnail.webp', { body: PNG_BYTES, contentType: 'image/webp' });
    fake.seedQuota({ userId: USER, usedBytes: 900, fileCount: 1, limitBytes: 10_000 });

    await service.deleteMedia(USER, 'media_1');

    expect(fake.tipMedia).toHaveLength(0);
    expect(storage.objects.size).toBe(0);
    expect(fake.mediaQuota[0]).toMatchObject({ usedBytes: 0, fileCount: 0 });
  });

  it('refuses to delete media that a tip is using', async () => {
    const { service, fake } = build();
    const media = fake.seedMedia({ userId: USER, status: 'ready', tipId: 'tip_1' });

    await expect(service.deleteMedia(USER, media.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fake.tipMedia).toHaveLength(1);
  });

  it('refuses to delete somebody else’s media', async () => {
    const { service, fake } = build();
    const media = fake.seedMedia({ userId: 'user_2', status: 'ready' });

    await expect(service.deleteMedia(USER, media.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lets an admin delete somebody else’s media', async () => {
    const { service, fake } = build();
    const media = fake.seedMedia({ userId: 'user_2', status: 'ready' });

    await service.deleteMedia('admin_1', media.id, { isAdmin: true });

    expect(fake.tipMedia).toHaveLength(0);
  });

  it('does not refund quota for media that never became ready', async () => {
    const { service, fake } = build();
    const media = fake.seedMedia({ userId: USER, status: 'rejected', sizeBytes: 500 });
    fake.seedQuota({ userId: USER, usedBytes: 100, fileCount: 1, limitBytes: 10_000 });

    await service.deleteMedia(USER, media.id);

    expect(fake.mediaQuota[0]).toMatchObject({ usedBytes: 100, fileCount: 1 });
  });
});

describe('MediaService.getQuota', () => {
  it('creates the quota row on first use', async () => {
    const { service, fake } = build();
    const quota = await service.getQuota(USER);

    expect(quota).toMatchObject({ usedBytes: 0, reservedBytes: 0, limitBytes: 10_000, remainingBytes: 10_000 });
    expect(fake.mediaQuota).toHaveLength(1);
  });

  it('separates committed from reserved bytes', async () => {
    const { service, fake } = build();
    fake.seedQuota({ userId: USER, usedBytes: 2_000, fileCount: 2, limitBytes: 10_000 });
    fake.seedMedia({ userId: USER, status: 'pending', sizeBytes: 1_500 });
    fake.seedMedia({ userId: USER, status: 'ready', sizeBytes: 2_000 });

    const quota = await service.getQuota(USER);

    expect(quota).toMatchObject({ usedBytes: 2_000, reservedBytes: 1_500, remainingBytes: 6_500 });
  });

  it('never reports negative remaining bytes', async () => {
    const { service, fake } = build();
    fake.seedQuota({ userId: USER, usedBytes: 9_000, fileCount: 1, limitBytes: 10_000 });
    fake.seedMedia({ userId: USER, status: 'uploaded', sizeBytes: 5_000 });

    const quota = await service.getQuota(USER);

    expect(quota.remainingBytes).toBe(0);
  });
});

describe('MediaService.pruneStaleUploads', () => {
  it('closes abandoned uploads and removes their bytes', async () => {
    const { service, fake, storage } = build();
    const stale = fake.seedMedia({
      userId: USER,
      status: 'pending',
      createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    });
    storage.objects.set(stale.storageKey, { body: Buffer.from('x'), contentType: 'image/png' });

    const result = await service.pruneStaleUploads(60 * 24);

    expect(result.pruned).toBe(1);
    expect(fake.tipMedia[0].status).toBe('failed');
    expect(storage.objects.size).toBe(0);
  });

  it('leaves fresh uploads and attached media alone', async () => {
    const { service, fake } = build();
    fake.seedMedia({ userId: USER, status: 'pending' });
    fake.seedMedia({
      userId: USER,
      status: 'pending',
      tipId: 'tip_1',
      createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    });
    fake.seedMedia({ userId: USER, status: 'ready', createdAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000) });

    const result = await service.pruneStaleUploads(60 * 24);

    expect(result.pruned).toBe(0);
    expect(fake.tipMedia.map((row) => row.status)).toEqual(['pending', 'pending', 'ready']);
  });
});

describe('MediaService.listMine', () => {
  it('filters by status and attachment and paginates', async () => {
    const { service, fake } = build();
    fake.seedMedia({ userId: USER, status: 'ready', tipId: 'tip_1', createdAt: new Date(3) });
    fake.seedMedia({ userId: USER, status: 'ready', createdAt: new Date(2) });
    fake.seedMedia({ userId: USER, status: 'pending', createdAt: new Date(1) });
    fake.seedMedia({ userId: 'user_2', status: 'ready', createdAt: new Date(4) });

    const attached = await service.listMine(USER, { attached: true });
    expect(attached.total).toBe(1);

    const ready = await service.listMine(USER, { status: 'ready', pageSize: 1 });
    expect(ready.total).toBe(2);
    expect(ready.items).toHaveLength(1);
    expect(ready.totalPages).toBe(2);
    // Newest first.
    expect(ready.items[0].createdAt).toBe(new Date(3).toISOString());
  });
});
