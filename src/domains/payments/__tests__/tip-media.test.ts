/**
 * Tip media wiring (#64).
 *
 * The media domain owns the rules about what may be attached; this covers the
 * payment side of the contract: a tip only attaches media the tipper owns and
 * that is ready, a tip without media behaves exactly as before, and a tip that
 * asks for too much media is refused before anything is written.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PaymentService } from '../payment.service';
import { MAX_MEDIA_PER_TIP } from '../../media/media.types';
import { ValidationError } from '../../../utils/errors';

const USER = 'user-123';
const CREATOR = 'creator-123';

const mockPrisma = {
  creator: { findUnique: vi.fn(), update: vi.fn() },
  user: { findUnique: vi.fn() },
  wallet: { findFirst: vi.fn() },
  walletFlag: { findFirst: vi.fn() },
  accountFreeze: { findFirst: vi.fn() },
  tipMedia: { findMany: vi.fn(), updateMany: vi.fn() },
  tip: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
};

function readyMediaRow(id: string) {
  return {
    id,
    kind: 'image',
    status: 'ready',
    mimeType: 'image/png',
    fileName: 'photo.png',
    sizeBytes: 2048,
    width: 800,
    height: 600,
    durationSeconds: null,
    storageKey: `media/${USER}/${id}/original.png`,
    derivatives: [{ variant: 'thumbnail', key: `media/${USER}/${id}/thumbnail.webp` }],
    processingStatus: 'done',
    processingError: null,
    tipId: 'tip-123',
    attachedAt: new Date(),
    createdAt: new Date('2026-09-27T10:00:00.000Z'),
  };
}

describe('PaymentService.createTip with media', () => {
  let paymentService: PaymentService;

  beforeEach(() => {
    paymentService = new PaymentService(mockPrisma as any);
    vi.clearAllMocks();

    mockPrisma.user.findUnique.mockResolvedValue({ id: USER });
    mockPrisma.creator.findUnique.mockResolvedValue({ id: CREATOR, isPublic: true, verified: true });
    mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'wallet-1', publicKey: 'GCLEAN', verified: true });
    mockPrisma.walletFlag.findFirst.mockResolvedValue(null);
    mockPrisma.accountFreeze.findFirst.mockResolvedValue(null);
    mockPrisma.tipMedia.updateMany.mockResolvedValue({ count: 1 });
  });

  const tipRow = (media: unknown[] = []) => ({
    id: 'tip-123',
    fromUserId: USER,
    creatorId: CREATOR,
    amount: 100,
    message: 'Great content!',
    status: 'pending',
    transactionHash: null,
    media,
    createdAt: new Date('2026-09-27T11:00:00.000Z'),
    updatedAt: new Date('2026-09-27T11:00:00.000Z'),
  });

  it('leaves a tip without media exactly as before', async () => {
    mockPrisma.tip.create.mockResolvedValue(tipRow());

    const result = await paymentService.createTip(USER, { creatorId: CREATOR, amount: 100 });

    expect(result.media).toEqual([]);
    // The media table is not consulted at all when no media is requested.
    expect(mockPrisma.tipMedia.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.tip.create).toHaveBeenCalledWith({
      data: expect.not.objectContaining({ media: expect.anything() }),
    });
  });

  it('attaches ready media the tipper owns and stamps the attachment time', async () => {
    mockPrisma.tipMedia.findMany.mockResolvedValue([{ id: 'media_1' }, { id: 'media_2' }]);
    mockPrisma.tip.create.mockResolvedValue(tipRow([readyMediaRow('media_1'), readyMediaRow('media_2')]));

    const result = await paymentService.createTip(USER, {
      creatorId: CREATOR,
      amount: 100,
      mediaIds: ['media_1', 'media_2'],
    });

    // Ownership, readiness and the "not already attached" rule are enforced in the
    // lookup itself, so an id that fails any of them is simply not returned.
    expect(mockPrisma.tipMedia.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['media_1', 'media_2'] }, userId: USER, status: 'ready', tipId: null },
      select: { id: true },
    });
    expect(mockPrisma.tip.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        media: { connect: [{ id: 'media_1' }, { id: 'media_2' }] },
      }),
    });
    expect(mockPrisma.tipMedia.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['media_1', 'media_2'] }, tipId: 'tip-123' },
      data: { attachedAt: expect.any(Date) },
    });
    expect(result.media).toHaveLength(2);
    expect(result.media[0]).toMatchObject({
      id: 'media_1',
      status: 'ready',
      url: '/api/v1/media/media_1/content',
      thumbnailUrl: '/api/v1/media/media_1/content?variant=thumbnail',
      attachedTipId: 'tip-123',
    });
  });

  it('refuses the tip when one of the media ids is not attachable', async () => {
    // Only one of the two ids comes back: the other is foreign, still scanning,
    // already attached, or missing.
    mockPrisma.tipMedia.findMany.mockResolvedValue([{ id: 'media_1' }]);

    await expect(
      paymentService.createTip(USER, { creatorId: CREATOR, amount: 100, mediaIds: ['media_1', 'media_2'] })
    ).rejects.toThrow(ValidationError);

    expect(mockPrisma.tip.create).not.toHaveBeenCalled();
    expect(mockPrisma.tipMedia.updateMany).not.toHaveBeenCalled();
  });

  it('refuses more media than a tip may carry', async () => {
    const mediaIds = Array.from({ length: MAX_MEDIA_PER_TIP + 1 }, (_, index) => `media_${index}`);

    await expect(
      paymentService.createTip(USER, { creatorId: CREATOR, amount: 100, mediaIds })
    ).rejects.toThrow(ValidationError);

    expect(mockPrisma.tip.create).not.toHaveBeenCalled();
  });

  it('fails closed when the client has no media delegate at all', async () => {
    const prismaWithoutMedia = { ...mockPrisma, tipMedia: undefined };
    const service = new PaymentService(prismaWithoutMedia as any);
    mockPrisma.tip.create.mockResolvedValue(tipRow());

    await expect(
      service.createTip(USER, { creatorId: CREATOR, amount: 100, mediaIds: ['media_1'] })
    ).rejects.toThrow(ValidationError);
  });

  it('still returns the tip when stamping the attachment time fails', async () => {
    mockPrisma.tipMedia.findMany.mockResolvedValue([{ id: 'media_1' }]);
    mockPrisma.tipMedia.updateMany.mockRejectedValue(new Error('database is having a moment'));
    mockPrisma.tip.create.mockResolvedValue(tipRow([readyMediaRow('media_1')]));

    const result = await paymentService.createTip(USER, {
      creatorId: CREATOR,
      amount: 100,
      mediaIds: ['media_1'],
    });

    // The tip is committed; bookkeeping must not turn a success into a failure.
    expect(result.id).toBe('tip-123');
    expect(result.media).toHaveLength(1);
  });

  it('maps derivative keys to CDN-free API URLs when no CDN is configured', async () => {
    mockPrisma.tipMedia.findMany.mockResolvedValue([{ id: 'media_1' }]);
    mockPrisma.tip.create.mockResolvedValue(tipRow([{ ...readyMediaRow('media_1'), derivatives: [] }]));

    const result = await paymentService.createTip(USER, {
      creatorId: CREATOR,
      amount: 100,
      mediaIds: ['media_1'],
    });

    expect(result.media[0].thumbnailUrl).toBeNull();
    expect(result.media[0].previewUrl).toBeNull();
  });
});
