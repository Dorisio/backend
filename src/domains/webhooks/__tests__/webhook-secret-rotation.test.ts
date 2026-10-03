import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { WebhookService } from '../webhook.service';

// Mock Prisma
const mockPrisma = {
  webhook: {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  auditLog: {
    create: vi.fn(),
  },
} as unknown as PrismaClient;

describe('Webhook Secret Rotation', () => {
  let service: WebhookService;
  const webhookId = 'webhook-123';
  const creatorId = 'creator-456';
  const userId = 'user-789';
  const currentSecret = 'current-secret-32-bytes-long!!!';
  const ipAddress = '127.0.0.1';
  const makeWebhookResponse = (overrides: Record<string, unknown> = {}) => ({
    id: webhookId,
    creatorId,
    url: 'https://example.com/webhook',
    events: ['tip.created'],
    secret: currentSecret,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    service = new WebhookService(mockPrisma);
  });

  describe('rotateWebhookSecret', () => {
    it('should rotate secret successfully', async () => {
      const webhook = {
        id: webhookId,
        creatorId,
        secret: currentSecret,
      };

      const rotatedWebhook = {
        id: webhookId,
        creatorId,
        url: 'https://example.com/webhook',
        events: ['tip.created'],
        secret: 'new-secret-will-be-generated',
        previousSecret: currentSecret,
        secretRotatedAt: new Date(),
        active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(mockPrisma.webhook.findUnique).mockResolvedValue(webhook as any);
      vi.mocked(mockPrisma.webhook.update).mockImplementation((args) => {
        return Promise.resolve({
          ...rotatedWebhook,
          secret: args.data.secret,
        } as any);
      });
      vi.mocked(mockPrisma.auditLog.create).mockResolvedValue({} as any);

      const result = await service.rotateWebhookSecret(webhookId, creatorId, userId, ipAddress);

      expect(result.id).toBe(webhookId);
      expect(result.secret).not.toBe(currentSecret); // New secret generated
      expect(mockPrisma.webhook.update).toHaveBeenCalledWith({
        where: { id: webhookId },
        data: {
          previousSecret: currentSecret,
          secret: expect.any(String),
          secretRotatedAt: expect.any(Date),
        },
        select: expect.any(Object),
      });

      // Verify audit log was created
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId,
          action: 'webhook.secret_rotated',
          resource: 'webhook',
          resourceId: webhookId,
          ipAddress,
        }),
      });
    });

    it('should throw NotFoundError if webhook does not exist', async () => {
      vi.mocked(mockPrisma.webhook.findUnique).mockResolvedValue(null);

      await expect(
        service.rotateWebhookSecret(webhookId, creatorId, userId, ipAddress)
      ).rejects.toThrow('Webhook not found');
    });

    it('should throw ValidationError if creator does not own webhook', async () => {
      const webhook = {
        id: webhookId,
        creatorId: 'different-creator',
        secret: currentSecret,
      };

      vi.mocked(mockPrisma.webhook.findUnique).mockResolvedValue(webhook as any);

      await expect(
        service.rotateWebhookSecret(webhookId, creatorId, userId, ipAddress)
      ).rejects.toThrow('Unauthorized');
    });

    it('should move current secret to previousSecret', async () => {
      const webhook = {
        id: webhookId,
        creatorId,
        secret: currentSecret,
      };

      vi.mocked(mockPrisma.webhook.findUnique).mockResolvedValue(webhook as any);
      vi.mocked(mockPrisma.webhook.update).mockResolvedValue(
        makeWebhookResponse({
          previousSecret: currentSecret,
          secretRotatedAt: new Date(),
        }) as any
      );
      vi.mocked(mockPrisma.auditLog.create).mockResolvedValue({} as any);

      await service.rotateWebhookSecret(webhookId, creatorId, userId, ipAddress);

      const updateCall = vi.mocked(mockPrisma.webhook.update).mock.calls[0][0];
      expect(updateCall.data.previousSecret).toBe(currentSecret);
      expect(updateCall.data.secret).toBeTruthy();
      expect(updateCall.data.secret).not.toBe(currentSecret);
    });

    it('should set secretRotatedAt timestamp', async () => {
      const webhook = {
        id: webhookId,
        creatorId,
        secret: currentSecret,
      };

      const beforeRotation = new Date();

      vi.mocked(mockPrisma.webhook.findUnique).mockResolvedValue(webhook as any);
      vi.mocked(mockPrisma.webhook.update).mockResolvedValue(
        makeWebhookResponse({
          secretRotatedAt: new Date(),
        }) as any
      );
      vi.mocked(mockPrisma.auditLog.create).mockResolvedValue({} as any);

      await service.rotateWebhookSecret(webhookId, creatorId, userId, ipAddress);

      const updateCall = vi.mocked(mockPrisma.webhook.update).mock.calls[0][0];
      const rotationTime = updateCall.data.secretRotatedAt as Date;
      expect(rotationTime).toBeInstanceOf(Date);
      expect(rotationTime.getTime()).toBeGreaterThanOrEqual(beforeRotation.getTime());
    });

    it('should generate cryptographically secure new secret', async () => {
      const webhook = {
        id: webhookId,
        creatorId,
        secret: currentSecret,
      };

      vi.mocked(mockPrisma.webhook.findUnique).mockResolvedValue(webhook as any);
      vi.mocked(mockPrisma.webhook.update).mockImplementation((args) => {
        return Promise.resolve(
          makeWebhookResponse({
            secret: args.data.secret,
          }) as any
        );
      });
      vi.mocked(mockPrisma.auditLog.create).mockResolvedValue({} as any);

      await service.rotateWebhookSecret(webhookId, creatorId, userId, ipAddress);

      const updateCall = vi.mocked(mockPrisma.webhook.update).mock.calls[0][0];
      const newSecret = updateCall.data.secret as string;

      // Should be hex string (64 chars for 32 bytes)
      expect(newSecret).toMatch(/^[a-f0-9]{64}$/);
      expect(newSecret.length).toBe(64);
    });
  });

  describe('clearExpiredPreviousSecrets', () => {
    it('should clear secrets rotated more than 7 days ago', async () => {
      vi.mocked(mockPrisma.webhook.updateMany).mockResolvedValue({ count: 5 });

      const count = await service.clearExpiredPreviousSecrets();

      expect(count).toBe(5);
      expect(mockPrisma.webhook.updateMany).toHaveBeenCalledWith({
        where: {
          previousSecret: {
            not: null,
          },
          secretRotatedAt: {
            lt: expect.any(Date),
          },
        },
        data: {
          previousSecret: null,
        },
      });

      // Verify the date is approximately 7 days ago
      const updateCall = vi.mocked(mockPrisma.webhook.updateMany).mock.calls[0][0];
      const expirationDate = updateCall.where.secretRotatedAt.lt as Date;
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      // Allow 1 second tolerance for test execution time
      expect(Math.abs(expirationDate.getTime() - sevenDaysAgo.getTime())).toBeLessThan(1000);
    });

    it('should handle no expired secrets', async () => {
      vi.mocked(mockPrisma.webhook.updateMany).mockResolvedValue({ count: 0 });

      const count = await service.clearExpiredPreviousSecrets();

      expect(count).toBe(0);
    });

    it('should only clear previousSecret, not current secret', async () => {
      vi.mocked(mockPrisma.webhook.updateMany).mockResolvedValue({ count: 3 });

      await service.clearExpiredPreviousSecrets();

      const updateCall = vi.mocked(mockPrisma.webhook.updateMany).mock.calls[0][0];
      expect(updateCall.where.previousSecret).toEqual({ not: null });
      expect(updateCall.data.previousSecret).toBeNull();
      expect(updateCall.data).not.toHaveProperty('secret');
    });
  });

  describe('Integration: Rotation and Grace Period', () => {
    it('should support both secrets during grace period', async () => {
      const webhook = {
        id: webhookId,
        creatorId,
        secret: currentSecret,
      };

      const newSecret = 'new-generated-secret-32-bytes!!';
      const rotationDate = new Date();

      vi.mocked(mockPrisma.webhook.findUnique).mockResolvedValue(webhook as any);
      vi.mocked(mockPrisma.webhook.update).mockResolvedValue(
        makeWebhookResponse({
          secret: newSecret,
          previousSecret: currentSecret,
          secretRotatedAt: rotationDate,
        }) as any
      );
      vi.mocked(mockPrisma.auditLog.create).mockResolvedValue({} as any);

      const result = await service.rotateWebhookSecret(webhookId, creatorId, userId, ipAddress);

      // After rotation, webhook should have both secrets
      // This would be verified by the verification module which checks both
      expect(result.secret).toBe(newSecret);

      const updateCall = vi.mocked(mockPrisma.webhook.update).mock.calls[0][0];
      expect(updateCall.data.previousSecret).toBe(currentSecret);
    });

    it('should generate different secret on each rotation', async () => {
      const webhook = {
        id: webhookId,
        creatorId,
        secret: currentSecret,
      };

      const secrets: string[] = [];

      vi.mocked(mockPrisma.webhook.findUnique).mockResolvedValue(webhook as any);
      vi.mocked(mockPrisma.webhook.update).mockImplementation((args) => {
        secrets.push(args.data.secret as string);

        return Promise.resolve(
          makeWebhookResponse({
            secret: args.data.secret,
          }) as any
        );
      });
      vi.mocked(mockPrisma.auditLog.create).mockResolvedValue({} as any);

      // Rotate twice
      await service.rotateWebhookSecret(webhookId, creatorId, userId, ipAddress);
      await service.rotateWebhookSecret(webhookId, creatorId, userId, ipAddress);

      expect(secrets).toHaveLength(2);
      expect(secrets[0]).not.toBe(secrets[1]);
      expect(secrets[0]).not.toBe(currentSecret);
      expect(secrets[1]).not.toBe(currentSecret);
    });
  });
});
