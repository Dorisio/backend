import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { WebhookService } from '../webhooks/webhook.service';
import { enqueueEmail } from '../notifications/email';
import {
  getVerificationDocumentPath,
  removeVerificationDocuments,
  storeVerificationDocuments,
  VerificationDocumentInput,
} from './verification-documents';

const DAY_MS = 24 * 60 * 60 * 1000;
const PENDING_REQUEST_TTL_MS = 30 * DAY_MS;
const VERIFICATION_DURATION_MS = 365 * DAY_MS;

type VerificationDecision = 'approved' | 'rejected';

export class VerificationService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  async verifyCreator(_creatorId: string): Promise<{ verified: boolean }> {
    throw new ValidationError('Creator verification requires an approved request');
  }

  async submitRequest(
    userId: string,
    input: { statement?: string; documents: VerificationDocumentInput[] }
  ) {
    return this.executeWithLogging('creator.verification.submit', async () => {
      await this.expireDueRequests();
      if (input.documents.length === 0) {
        throw new ValidationError('At least one verification document is required');
      }

      const creator = await this.prisma.creator.findUnique({
        where: { userId },
        include: { user: { select: { id: true, email: true, name: true, verified: true } } },
      });
      if (!creator) throw new NotFoundError('Creator');
      if (!creator.user.verified) {
        throw new ValidationError('Verify your email before requesting creator verification');
      }
      if (creator.verified && (!creator.verifiedUntil || creator.verifiedUntil > new Date())) {
        throw new ConflictError('Creator is already verified');
      }

      const requestId = randomUUID();
      const documents = await storeVerificationDocuments(requestId, input.documents);
      try {
        const request = await this.prisma.$transaction(async (tx) => {
          const created = await tx.creatorVerificationRequest.create({
            data: {
              id: requestId,
              creatorId: creator.id,
              statement: input.statement?.trim() || null,
              expiresAt: new Date(Date.now() + PENDING_REQUEST_TTL_MS),
              documents: { create: documents },
            },
            include: {
              documents: {
                select: {
                  id: true,
                  filename: true,
                  contentType: true,
                  size: true,
                  createdAt: true,
                },
              },
            },
          });
          await tx.creatorVerificationEvent.create({
            data: {
              creatorId: creator.id,
              requestId,
              actorId: userId,
              action: 'submitted',
              metadata: { documentCount: documents.length },
            },
          });
          return created;
        });
        await this.notify(creator.user, 'submitted');
        return request;
      } catch (error) {
        await removeVerificationDocuments(requestId);
        if ((error as { code?: string }).code === 'P2002') {
          throw new ConflictError('A pending verification request already exists');
        }
        throw error;
      }
    });
  }

  async getRequestHistory(userId: string) {
    return this.executeWithLogging('creator.verification.history', async () => {
      await this.expireDueRequests();
      const creator = await this.prisma.creator.findUnique({
        where: { userId },
        select: { id: true },
      });
      if (!creator) throw new NotFoundError('Creator');
      return this.prisma.creatorVerificationRequest.findMany({
        where: { creatorId: creator.id },
        orderBy: { createdAt: 'desc' },
        include: {
          documents: {
            select: { id: true, filename: true, contentType: true, size: true, createdAt: true },
          },
          events: { orderBy: { createdAt: 'asc' } },
        },
      });
    });
  }

  async getPendingRequests(page = 1, pageSize = 20) {
    return this.executeWithLogging('creator.verification.queue', async () => {
      await this.expireDueRequests();
      const safePage = Math.max(1, page);
      const safePageSize = Math.min(100, Math.max(1, pageSize));
      const where = { status: 'submitted' };
      const [items, total] = await Promise.all([
        this.prisma.creatorVerificationRequest.findMany({
          where,
          orderBy: { createdAt: 'asc' },
          skip: (safePage - 1) * safePageSize,
          take: safePageSize,
          include: {
            creator: { include: { user: { select: { id: true, email: true, name: true } } } },
            documents: {
              select: { id: true, filename: true, contentType: true, size: true, createdAt: true },
            },
          },
        }),
        this.prisma.creatorVerificationRequest.count({ where }),
      ]);
      return {
        items,
        total,
        page: safePage,
        pageSize: safePageSize,
        totalPages: Math.ceil(total / safePageSize),
      };
    });
  }

  async decideRequest(
    requestId: string,
    reviewerId: string,
    decision: VerificationDecision,
    reason?: string
  ) {
    return this.executeWithLogging(`creator.verification.${decision}`, async () => {
      const now = new Date();
      await this.expireDueRequests(now);
      const request = await this.prisma.creatorVerificationRequest.findUnique({
        where: { id: requestId },
        include: {
          creator: { include: { user: { select: { id: true, email: true, name: true } } } },
        },
      });
      if (!request) throw new NotFoundError('Verification request');
      if (request.status !== 'submitted')
        throw new ConflictError('Verification request is no longer pending');

      const verifiedUntil = new Date(now.getTime() + VERIFICATION_DURATION_MS);
      const result = await this.prisma.$transaction(async (tx) => {
        const changed = await tx.creatorVerificationRequest.updateMany({
          where: { id: requestId, status: 'submitted', expiresAt: { gt: now } },
          data: {
            status: decision,
            reviewerId,
            reviewedAt: now,
            reviewReason: reason?.trim() || null,
            ...(decision === 'approved' ? { expiresAt: verifiedUntil } : {}),
          },
        });
        if (changed.count === 0)
          throw new ConflictError('Verification request is no longer pending');

        if (decision === 'approved') {
          await tx.creator.update({
            where: { id: request.creatorId },
            data: { verified: true, verifiedAt: now, verifiedUntil },
          });
        }
        await tx.creatorVerificationEvent.create({
          data: {
            creatorId: request.creatorId,
            requestId,
            actorId: reviewerId,
            action: decision,
            reason: reason?.trim() || null,
            metadata:
              decision === 'approved' ? { verifiedUntil: verifiedUntil.toISOString() } : undefined,
          },
        });
        return tx.creatorVerificationRequest.findUniqueOrThrow({
          where: { id: requestId },
          include: {
            documents: {
              select: { id: true, filename: true, contentType: true, size: true, createdAt: true },
            },
          },
        });
      });

      if (decision === 'approved') {
        logger.info(`Creator verified: ${request.creatorId}`);

        await new WebhookService(this.prisma).dispatchEvent(
          request.creatorId,
          request.creatorId,
          'creator.verified',
          { creatorId: request.creatorId }
        );
      }

      await this.notify(request.creator.user, decision, reason);
      return result;
    });
  }

  async unverifyCreator(
    creatorId: string,
    actorId: string,
    reason: string
  ): Promise<{ verified: boolean }> {
    return this.executeWithLogging('creator.verification.revoke', async () => {
      const creator = await this.prisma.creator.findUnique({
        where: { id: creatorId },
        include: { user: { select: { id: true, email: true, name: true } } },
      });
      if (!creator) throw new NotFoundError('Creator');
      if (!creator.verified) throw new ConflictError('Creator is not currently verified');

      await this.prisma.$transaction(async (tx) => {
        await tx.creator.update({
          where: { id: creatorId },
          data: { verified: false, verifiedAt: null, verifiedUntil: null },
        });
        await tx.creatorVerificationEvent.create({
          data: {
            creatorId,
            actorId,
            action: 'revoked',
            reason: reason.trim(),
            metadata: { previousVerifiedAt: creator.verifiedAt?.toISOString() ?? null },
          },
        });
      });
      await this.notify(creator.user, 'revoked', reason);
      return { verified: false };
    });
  }

  async getVerificationDocument(documentId: string) {
    const document = await this.prisma.creatorVerificationDocument.findUnique({
      where: { id: documentId },
    });
    if (!document) throw new NotFoundError('Verification document');
    return { ...document, path: getVerificationDocumentPath(document.storageKey) };
  }

  async expireDueRequests(now = new Date()): Promise<number> {
    const expired = await this.prisma.creatorVerificationRequest.findMany({
      where: { status: { in: ['submitted', 'approved'] }, expiresAt: { lte: now } },
      include: {
        creator: { include: { user: { select: { id: true, email: true, name: true } } } },
      },
    });
    let count = 0;
    for (const request of expired) {
      const changed = await this.prisma.$transaction(async (tx) => {
        const result = await tx.creatorVerificationRequest.updateMany({
          where: { id: request.id, status: request.status, expiresAt: { lte: now } },
          data: { status: 'expired', reviewedAt: now },
        });
        if (!result.count) return false;
        if (request.status === 'approved') {
          await tx.creator.updateMany({
            where: { id: request.creatorId, verified: true, verifiedUntil: { lte: now } },
            data: { verified: false, verifiedAt: null, verifiedUntil: null },
          });
        }
        await tx.creatorVerificationEvent.create({
          data: { creatorId: request.creatorId, requestId: request.id, action: 'expired' },
        });
        return true;
      });
      if (changed) {
        count++;
        await this.notify(request.creator.user, 'expired');
      }
    }
    return count;
  }

  private async notify(
    user: { id: string; email: string; name: string | null },
    status: string,
    reason?: string
  ): Promise<void> {
    try {
      await enqueueEmail({
        to: user.email,
        template: 'creator-verification',
        data: { name: user.name ?? 'there', status, ...(reason ? { reason } : {}) },
        userId: user.id,
        eventType: `creator_verification.${status}`,
      });
    } catch (error) {
      logger.error(
        { error, userId: user.id, status },
        'Failed to enqueue creator verification email'
      );
    }
  }

  async getVerificationStatus(creatorId: string): Promise<{ verified: boolean }> {
    return this.executeWithLogging('creator.getVerificationStatus', async () => {
      await this.expireDueRequests();
      const creator = await this.prisma.creator.findUnique({
        where: { id: creatorId },
        select: { verified: true },
      });

      if (!creator) throw new NotFoundError('Creator');

      return { verified: creator.verified };
    });
  }
}
