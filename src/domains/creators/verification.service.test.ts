import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ConflictError, ValidationError } from '../../utils/errors';

const { dispatchEvent } = vi.hoisted(() => ({
  dispatchEvent: vi.fn(),
}));

vi.mock('../webhooks/webhook.service', () => ({
  WebhookService: vi.fn(() => ({
    dispatchEvent,
  })),
}));

vi.mock('../notifications/email', () => ({
  enqueueEmail: vi.fn().mockResolvedValue('email-job-1'),
}));

vi.mock('./verification-documents', () => ({
  getVerificationDocumentPath: vi.fn((key: string) => `private/${key}`),
  removeVerificationDocuments: vi.fn().mockResolvedValue(undefined),
  storeVerificationDocuments: vi.fn().mockResolvedValue([
    {
      storageKey: 'request-1/id.png',
      filename: 'id.png',
      contentType: 'image/png',
      size: 5,
    },
  ]),
}));

import { enqueueEmail } from '../notifications/email';
import { removeVerificationDocuments, storeVerificationDocuments } from './verification-documents';
import { VerificationService } from './verification.service';

const creator = {
  id: 'creator-1',
  userId: 'user-1',
  verified: false,
  verifiedAt: null,
  verifiedUntil: null,
  user: { id: 'user-1', email: 'creator@example.com', name: 'Creator', verified: true },
};
const request = {
  id: 'request-1',
  creatorId: 'creator-1',
  status: 'submitted',
  creator: { ...creator, user: creator.user },
};

function createPrismaMock() {
  const tx = {
    creatorVerificationRequest: {
      create: vi.fn().mockResolvedValue(request),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue(request),
    },
    creatorVerificationEvent: { create: vi.fn().mockResolvedValue({}) },
    creator: {
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const transaction = vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
    callback(tx)
  );
  const mock = {
    creator: {
      findUnique: vi.fn().mockResolvedValue(creator),
      update: vi.fn().mockResolvedValue({}),
    },
    creatorVerificationRequest: {
      findUnique: vi.fn().mockResolvedValue(request),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    creatorVerificationDocument: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: transaction,
  };
  return { prisma: mock as unknown as PrismaClient, mock, tx, transaction };
}

describe('VerificationService', () => {
  let state: ReturnType<typeof createPrismaMock>;
  let service: VerificationService;

  beforeEach(() => {
    vi.clearAllMocks();
    state = createPrismaMock();
    service = new VerificationService(state.prisma);
  });

  it('requires a verified email and at least one identity document', async () => {
    await expect(service.submitRequest('user-1', { documents: [] })).rejects.toBeInstanceOf(
      ValidationError
    );

    state.mock.creator.findUnique.mockResolvedValue({
      ...creator,
      user: { ...creator.user, verified: false },
    });
    await expect(
      service.submitRequest('user-1', {
        documents: [{ filename: 'id.png', contentType: 'image/png', data: Buffer.from('image') }],
      })
    ).rejects.toThrow('Verify your email');
    expect(storeVerificationDocuments).not.toHaveBeenCalled();
  });

  it('creates a submitted request with stored document metadata, history, and email', async () => {
    const result = await service.submitRequest('user-1', {
      statement: 'I am this creator',
      documents: [{ filename: 'id.png', contentType: 'image/png', data: Buffer.from('image') }],
    });

    expect(result).toEqual(request);
    expect(state.tx.creatorVerificationRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ creatorId: 'creator-1', statement: 'I am this creator' }),
      })
    );
    expect(state.tx.creatorVerificationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'submitted', actorId: 'user-1' }),
      })
    );
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'creator@example.com',
        template: 'creator-verification',
        data: expect.objectContaining({ status: 'submitted' }),
      })
    );
  });

  it('cleans up uploaded files and reports a conflict for concurrent submissions', async () => {
    state.transaction.mockRejectedValueOnce(
      Object.assign(new Error('unique constraint'), { code: 'P2002' })
    );

    await expect(
      service.submitRequest('user-1', {
        documents: [{ filename: 'id.png', contentType: 'image/png', data: Buffer.from('image') }],
      })
    ).rejects.toBeInstanceOf(ConflictError);
    expect(removeVerificationDocuments).toHaveBeenCalledWith(expect.any(String));
  });

  it.each(['approved', 'rejected'] as const)(
    'records a %s decision and notifies the creator',
    async (decision) => {
      await service.decideRequest('request-1', 'admin-1', decision, 'Reviewed');

      expect(state.tx.creatorVerificationRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'request-1',
            status: 'submitted',
            expiresAt: { gt: expect.any(Date) },
          }),
          data: expect.objectContaining({
            status: decision,
            reviewerId: 'admin-1',
            reviewReason: 'Reviewed',
          }),
        })
      );
      expect(state.tx.creatorVerificationEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: decision,
            actorId: 'admin-1',
            reason: 'Reviewed',
          }),
        })
      );
      expect(enqueueEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: decision, reason: 'Reviewed' }),
        })
      );
      expect(state.tx.creator.update).toHaveBeenCalledTimes(decision === 'approved' ? 1 : 0);
    }
  );

  it('does not allow two admins to decide the same request', async () => {
    state.tx.creatorVerificationRequest.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.decideRequest('request-1', 'admin-1', 'approved')).rejects.toBeInstanceOf(
      ConflictError
    );
    expect(state.tx.creatorVerificationEvent.create).not.toHaveBeenCalled();
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it('expires overdue requests before allowing an admin decision', async () => {
    vi.spyOn(service, 'expireDueRequests').mockResolvedValue(1);
    state.mock.creatorVerificationRequest.findUnique.mockResolvedValue({
      ...request,
      status: 'expired',
    });

    await expect(service.decideRequest('request-1', 'admin-1', 'approved')).rejects.toThrow(
      'Verification request is no longer pending'
    );
    expect(service.expireDueRequests).toHaveBeenCalledWith(expect.any(Date));
    expect(state.tx.creator.update).not.toHaveBeenCalled();
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it('logs and emails verification revocation', async () => {
    state.mock.creator.findUnique.mockResolvedValue({
      ...creator,
      verified: true,
      verifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await expect(
      service.unverifyCreator('creator-1', 'admin-1', 'Policy violation')
    ).resolves.toEqual({ verified: false });
    expect(state.tx.creator.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'creator-1' },
        data: { verified: false, verifiedAt: null, verifiedUntil: null },
      })
    );
    expect(state.tx.creatorVerificationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'revoked',
          actorId: 'admin-1',
          reason: 'Policy violation',
        }),
      })
    );
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'revoked' }),
      })
    );
  });

  it('expires due requests, removes expired verification, and notifies the creator', async () => {
    state.mock.creatorVerificationRequest.findMany.mockResolvedValue([
      {
        ...request,
        status: 'approved',
        expiresAt: new Date('2025-01-01T00:00:00.000Z'),
        creator: { ...creator, user: creator.user },
      },
    ]);

    await expect(service.expireDueRequests(new Date('2026-01-01T00:00:00.000Z'))).resolves.toBe(1);
    expect(state.tx.creatorVerificationRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'expired', reviewedAt: new Date('2026-01-01T00:00:00.000Z') },
      })
    );
    expect(state.tx.creator.updateMany).toHaveBeenCalled();
    expect(state.tx.creatorVerificationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'expired' }),
      })
    );
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'expired' }),
      })
    );
  });

  it('cannot verify a creator outside the approved request workflow', async () => {
    await expect(service.verifyCreator('creator-1')).rejects.toBeInstanceOf(ValidationError);
    expect(state.mock.creator.update).not.toHaveBeenCalled();
  });
});
