import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  verifyCreatorWebhookSignature,
  computeWebhookSignature,
  parseWebhookHeaders,
  buildWebhookSignatureHeaders,
  cleanupExpiredNonces,
  DEFAULT_TOLERANCE_SECONDS,
} from '../creator-webhook-verification';

// Mock Prisma
const mockPrisma = {
  webhook: {
    findUnique: vi.fn(),
  },
  webhookNonce: {
    findUnique: vi.fn(),
    create: vi.fn(),
    deleteMany: vi.fn(),
  },
  auditLog: {
    create: vi.fn(),
  },
} as unknown as PrismaClient;

describe('Creator Webhook Verification', () => {
  const webhookId = 'webhook-test-id';
  const secret = 'test-secret-key-32-bytes-long!!!';
  const payload = JSON.stringify({ event: 'test.event', data: { id: 123 } });
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = 'unique-nonce-12345';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('computeWebhookSignature', () => {
    it('should compute HMAC-SHA256 signature correctly', () => {
      const signature = computeWebhookSignature(payload, secret, timestamp, nonce);
      expect(signature).toBeTruthy();
      expect(signature).toHaveLength(64); // SHA256 hex is 64 chars
    });

    it('should produce consistent signatures for same inputs', () => {
      const sig1 = computeWebhookSignature(payload, secret, timestamp, nonce);
      const sig2 = computeWebhookSignature(payload, secret, timestamp, nonce);
      expect(sig1).toBe(sig2);
    });

    it('should produce different signatures for different payloads', () => {
      const payload2 = JSON.stringify({ event: 'different.event' });
      const sig1 = computeWebhookSignature(payload, secret, timestamp, nonce);
      const sig2 = computeWebhookSignature(payload2, secret, timestamp, nonce);
      expect(sig1).not.toBe(sig2);
    });

    it('should produce different signatures for different secrets', () => {
      const secret2 = 'different-secret-key';
      const sig1 = computeWebhookSignature(payload, secret, timestamp, nonce);
      const sig2 = computeWebhookSignature(payload, secret2, timestamp, nonce);
      expect(sig1).not.toBe(sig2);
    });

    it('should produce different signatures for different timestamps', () => {
      const sig1 = computeWebhookSignature(payload, secret, timestamp, nonce);
      const sig2 = computeWebhookSignature(payload, secret, timestamp + 1, nonce);
      expect(sig1).not.toBe(sig2);
    });

    it('should produce different signatures for different nonces', () => {
      const sig1 = computeWebhookSignature(payload, secret, timestamp, nonce);
      const sig2 = computeWebhookSignature(payload, secret, timestamp, 'different-nonce');
      expect(sig1).not.toBe(sig2);
    });
  });

  describe('parseWebhookHeaders', () => {
    it('should parse valid headers correctly', () => {
      const headers = {
        'x-webhook-signature': 'abc123',
        'x-webhook-timestamp': '1234567890',
        'x-webhook-nonce': 'nonce123',
      };
      const parsed = parseWebhookHeaders(headers);
      expect(parsed.signature).toBe('abc123');
      expect(parsed.timestamp).toBe('1234567890');
      expect(parsed.nonce).toBe('nonce123');
    });

    it('should handle missing headers', () => {
      const parsed = parseWebhookHeaders({});
      expect(parsed.signature).toBeUndefined();
      expect(parsed.timestamp).toBeUndefined();
      expect(parsed.nonce).toBeUndefined();
    });

    it('should handle array header values', () => {
      const headers = {
        'x-webhook-signature': ['sig1', 'sig2'],
        'x-webhook-timestamp': ['123'],
      };
      const parsed = parseWebhookHeaders(headers as any);
      expect(parsed.signature).toBe('sig1');
      expect(parsed.timestamp).toBe('123');
    });
  });

  describe('buildWebhookSignatureHeaders', () => {
    it('should build valid signature headers', () => {
      const headers = buildWebhookSignatureHeaders(payload, secret, timestamp, nonce);
      expect(headers['X-Webhook-Signature']).toBeTruthy();
      expect(headers['X-Webhook-Timestamp']).toBe(timestamp.toString());
      expect(headers['X-Webhook-Nonce']).toBe(nonce);
    });

    it('should generate nonce if not provided', () => {
      const headers = buildWebhookSignatureHeaders(payload, secret, timestamp);
      expect(headers['X-Webhook-Nonce']).toBeTruthy();
      expect(headers['X-Webhook-Nonce'].length).toBeGreaterThan(0);
    });

    it('should use current time if timestamp not provided', () => {
      const before = Math.floor(Date.now() / 1000);
      const headers = buildWebhookSignatureHeaders(payload, secret);
      const after = Math.floor(Date.now() / 1000);
      const headerTime = parseInt(headers['X-Webhook-Timestamp']);
      expect(headerTime).toBeGreaterThanOrEqual(before);
      expect(headerTime).toBeLessThanOrEqual(after);
    });
  });

  describe('verifyCreatorWebhookSignature', () => {
    it('should verify valid signature successfully', async () => {
      const signature = computeWebhookSignature(payload, secret, timestamp, nonce);
      const headers = { signature, timestamp: timestamp.toString(), nonce };

      vi.mocked(mockPrisma.webhookNonce.findUnique).mockResolvedValue(null);
      vi.mocked(mockPrisma.webhook.findUnique).mockResolvedValue({
        id: webhookId,
        secret,
        previousSecret: null,
        secretRotatedAt: null,
      } as any);
      vi.mocked(mockPrisma.webhookNonce.create).mockResolvedValue({} as any);
      vi.mocked(mockPrisma.auditLog.create).mockResolvedValue({} as any);

      const result = await verifyCreatorWebhookSignature(
        mockPrisma,
        webhookId,
        payload,
        headers,
        { now: timestamp }
      );

      expect(result.valid).toBe(true);
      expect(result.webhookId).toBe(webhookId);
      expect(result.usedPreviousSecret).toBe(false);
    });

    it('should reject missing signature header', async () => {
      const headers = { timestamp: timestamp.toString(), nonce };

      vi.mocked(mockPrisma.auditLog.create).mockResolvedValue({} as any);

      const result = await verifyCreatorWebhookSignature(
        mockPrisma,
        webhookId,
        payload,
        headers,
        { now: timestamp }
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Missing signature header');
    });

    it('should reject missing timestamp header', async () => {
      const signature = computeWebhookSignature(payload, secret, timestamp, nonce);
      const headers = { signature, nonce };

      vi.mocked(mockPrisma.auditLog.create).mockResolvedValue({} as any);

      const result = await verifyCreatorWebhookSignature(
        mockPrisma,
        webhookId,
        payload,
        headers,
        { now: timestamp }
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Missing timestamp header');
    });

    it('should reject missing nonce header', async () => {
      const signature = computeWebhookSignature(payload, secret, timestamp, nonce);
      const headers = { signature, timestamp: timestamp.toString() };

      vi.mocked(mockPrisma.auditLog.create).mockResolvedValue({} as any);

      const result = await verifyCreatorWebhookSignature(
        mockPrisma,
        webhookId,
        payload,
        headers,
        { now: timestamp }
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Missing nonce header');
    });

    it('should reject invalid timestamp format', async () => {
      const signature = computeWebhookSignature(payload, secret, timestamp, nonce);
      const headers = { signature, timestamp: 'not-a-number', nonce };

      vi.mocked(mockPrisma.auditLog.create).mockResolvedValue({} as any);

      const result = await verifyCreatorWebhookSignature(
        mockPrisma,
        webhookId,
        payload,
        headers,
        { now: timestamp }
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Invalid timestamp format');
    });

    it('should reject timestamp outside tolerance window', async () => {
      const oldTimestamp = timestamp - DEFAULT_TOLERANCE_SECONDS - 100;
      const signature = computeWebhookSignature(payload, secret, oldTimestamp, nonce);
      const headers = { signature, timestamp: oldTimestamp.toString(), nonce };

      vi.mocked(mockPrisma.auditLog.create).mockResolvedValue({} as any);

      const result = await verifyCreatorWebhookSignature(
        mockPrisma,
        webhookId,
        payload,
        headers,
        { now: timestamp }
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Timestamp outside tolerance window');
    });

    it('should detect replay attack (nonce reuse)', async () => {
      const signature = computeWebhookSignature(payload, secret, timestamp, nonce);
      const headers = { signature, timestamp: timestamp.toString(), nonce };

      // Nonce already exists
      vi.mocked(mockPrisma.webhookNonce.findUnique).mockResolvedValue({
        id: 'existing-nonce',
        nonce,
      } as any);
      vi.mocked(mockPrisma.auditLog.create).mockResolvedValue({} as any);

      const result = await verifyCreatorWebhookSignature(
        mockPrisma,
        webhookId,
        payload,
        headers,
        { now: timestamp }
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('replay attack');
    });

    it('should reject invalid signature', async () => {
      const wrongSignature = 'invalid-signature-hash';
      const headers = { signature: wrongSignature, timestamp: timestamp.toString(), nonce };

      vi.mocked(mockPrisma.webhookNonce.findUnique).mockResolvedValue(null);
      vi.mocked(mockPrisma.webhook.findUnique).mockResolvedValue({
        id: webhookId,
        secret,
        previousSecret: null,
        secretRotatedAt: null,
      } as any);
      vi.mocked(mockPrisma.auditLog.create).mockResolvedValue({} as any);

      const result = await verifyCreatorWebhookSignature(
        mockPrisma,
        webhookId,
        payload,
        headers,
        { now: timestamp }
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Signature mismatch');
    });

    it('should accept previous secret during grace period', async () => {
      const previousSecret = 'old-secret-key';
      const rotationDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
      const signature = computeWebhookSignature(payload, previousSecret, timestamp, nonce);
      const headers = { signature, timestamp: timestamp.toString(), nonce };

      vi.mocked(mockPrisma.webhookNonce.findUnique).mockResolvedValue(null);
      vi.mocked(mockPrisma.webhook.findUnique).mockResolvedValue({
        id: webhookId,
        secret: 'new-secret-key',
        previousSecret,
        secretRotatedAt: rotationDate,
      } as any);
      vi.mocked(mockPrisma.webhookNonce.create).mockResolvedValue({} as any);
      vi.mocked(mockPrisma.auditLog.create).mockResolvedValue({} as any);

      const result = await verifyCreatorWebhookSignature(
        mockPrisma,
        webhookId,
        payload,
        headers,
        { now: timestamp }
      );

      expect(result.valid).toBe(true);
      expect(result.usedPreviousSecret).toBe(true);
    });

    it('should reject previous secret after grace period', async () => {
      const previousSecret = 'old-secret-key';
      const rotationDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago (past 7-day grace)
      const signature = computeWebhookSignature(payload, previousSecret, timestamp, nonce);
      const headers = { signature, timestamp: timestamp.toString(), nonce };

      vi.mocked(mockPrisma.webhookNonce.findUnique).mockResolvedValue(null);
      vi.mocked(mockPrisma.webhook.findUnique).mockResolvedValue({
        id: webhookId,
        secret: 'new-secret-key',
        previousSecret,
        secretRotatedAt: rotationDate,
      } as any);
      vi.mocked(mockPrisma.auditLog.create).mockResolvedValue({} as any);

      const result = await verifyCreatorWebhookSignature(
        mockPrisma,
        webhookId,
        payload,
        headers,
        { now: timestamp }
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Signature mismatch');
    });

    it('should skip nonce check when skipNonceCheck is true', async () => {
      const signature = computeWebhookSignature(payload, secret, timestamp, nonce);
      const headers = { signature, timestamp: timestamp.toString(), nonce };

      vi.mocked(mockPrisma.webhook.findUnique).mockResolvedValue({
        id: webhookId,
        secret,
        previousSecret: null,
        secretRotatedAt: null,
      } as any);
      vi.mocked(mockPrisma.auditLog.create).mockResolvedValue({} as any);

      const result = await verifyCreatorWebhookSignature(
        mockPrisma,
        webhookId,
        payload,
        headers,
        { now: timestamp, skipNonceCheck: true }
      );

      expect(result.valid).toBe(true);
      expect(mockPrisma.webhookNonce.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.webhookNonce.create).not.toHaveBeenCalled();
    });

    it('should handle webhook not found', async () => {
      const signature = computeWebhookSignature(payload, secret, timestamp, nonce);
      const headers = { signature, timestamp: timestamp.toString(), nonce };

      vi.mocked(mockPrisma.webhookNonce.findUnique).mockResolvedValue(null);
      vi.mocked(mockPrisma.webhook.findUnique).mockResolvedValue(null);
      vi.mocked(mockPrisma.auditLog.create).mockResolvedValue({} as any);

      const result = await verifyCreatorWebhookSignature(
        mockPrisma,
        webhookId,
        payload,
        headers,
        { now: timestamp }
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Webhook not found');
    });

    it('should handle webhook with no secret configured', async () => {
      const signature = computeWebhookSignature(payload, secret, timestamp, nonce);
      const headers = { signature, timestamp: timestamp.toString(), nonce };

      vi.mocked(mockPrisma.webhookNonce.findUnique).mockResolvedValue(null);
      vi.mocked(mockPrisma.webhook.findUnique).mockResolvedValue({
        id: webhookId,
        secret: null,
        previousSecret: null,
        secretRotatedAt: null,
      } as any);
      vi.mocked(mockPrisma.auditLog.create).mockResolvedValue({} as any);

      const result = await verifyCreatorWebhookSignature(
        mockPrisma,
        webhookId,
        payload,
        headers,
        { now: timestamp }
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Webhook secret not configured');
    });
  });

  describe('cleanupExpiredNonces', () => {
    it('should delete expired nonces', async () => {
      vi.mocked(mockPrisma.webhookNonce.deleteMany).mockResolvedValue({ count: 42 });

      const count = await cleanupExpiredNonces(mockPrisma);

      expect(count).toBe(42);
      expect(mockPrisma.webhookNonce.deleteMany).toHaveBeenCalledWith({
        where: {
          expiresAt: {
            lt: expect.any(Date),
          },
        },
      });
    });

    it('should handle no expired nonces', async () => {
      vi.mocked(mockPrisma.webhookNonce.deleteMany).mockResolvedValue({ count: 0 });

      const count = await cleanupExpiredNonces(mockPrisma);

      expect(count).toBe(0);
    });
  });
});
