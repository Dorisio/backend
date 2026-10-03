import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { logger } from '../../utils/logger';
import { AuditService } from '../../services/audit.service';

/**
 * Creator webhook signature verification for incoming webhooks.
 *
 * Implements HMAC-SHA256 signature verification with:
 * - Timestamp expiration checking (5 minute window)
 * - Nonce-based replay attack prevention
 * - Secret rotation support (validates both current and previous secret during transition)
 *
 * Expected headers:
 * - X-Webhook-Signature: HMAC-SHA256 signature of request body
 * - X-Webhook-Timestamp: Unix timestamp (seconds)
 * - X-Webhook-Nonce: Unique request identifier
 */

export const DEFAULT_TOLERANCE_SECONDS = 300; // 5 minutes
export const SECRET_ROTATION_GRACE_PERIOD_DAYS = 7; // Accept previous secret for 7 days

export interface WebhookVerificationHeaders {
  signature?: string;
  timestamp?: string;
  nonce?: string;
}

export interface WebhookVerificationResult {
  valid: boolean;
  reason?: string;
  webhookId?: string;
  timestamp?: number;
  usedPreviousSecret?: boolean;
}

export interface VerifyOptions {
  toleranceSeconds?: number;
  /** Injectable clock (seconds since epoch) for tests */
  now?: number;
  /** Skip nonce check (for testing) */
  skipNonceCheck?: boolean;
}

/**
 * Parse webhook verification headers from request
 */
export function parseWebhookHeaders(
  headers: Record<string, string | string[] | undefined>
): WebhookVerificationHeaders {
  const getHeader = (key: string): string | undefined => {
    const value = headers[key.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };

  return {
    signature: getHeader('x-webhook-signature'),
    timestamp: getHeader('x-webhook-timestamp'),
    nonce: getHeader('x-webhook-nonce'),
  };
}

/**
 * Compute HMAC-SHA256 signature
 */
export function computeWebhookSignature(
  payload: string,
  secret: string,
  timestamp: number,
  nonce: string
): string {
  const signedPayload = `${timestamp}.${nonce}.${payload}`;
  return createHmac('sha256', secret).update(signedPayload).digest('hex');
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
function safeEqual(a: string, b: string): boolean {
  try {
    const bufferA = Buffer.from(a, 'utf8');
    const bufferB = Buffer.from(b, 'utf8');
    if (bufferA.length !== bufferB.length) {
      return false;
    }
    return timingSafeEqual(bufferA, bufferB);
  } catch {
    return false;
  }
}

/**
 * Check if timestamp is within acceptable tolerance window
 */
function isTimestampValid(timestamp: number, tolerance: number, now: number): boolean {
  if (tolerance <= 0) {
    return true; // No tolerance check
  }
  return Math.abs(now - timestamp) <= tolerance;
}

/**
 * Check if nonce has been used before (replay attack detection)
 */
async function isNonceUsed(
  prisma: PrismaClient,
  webhookId: string,
  nonce: string
): Promise<boolean> {
  const existingNonce = await prisma.webhookNonce.findUnique({
    where: { nonce },
    select: { id: true },
  });
  return existingNonce !== null;
}

/**
 * Store nonce to prevent replay attacks
 */
async function storeNonce(
  prisma: PrismaClient,
  webhookId: string,
  nonce: string,
  timestamp: number,
  expiresAt: Date
): Promise<void> {
  try {
    await prisma.webhookNonce.create({
      data: {
        webhookId,
        nonce,
        timestamp: BigInt(timestamp),
        expiresAt,
      },
    });
  } catch (error: any) {
    // If unique constraint violation, nonce was already used
    if (error.code === 'P2002') {
      throw new Error('Nonce already used');
    }
    throw error;
  }
}

/**
 * Clean up expired nonces (should be called periodically)
 */
export async function cleanupExpiredNonces(prisma: PrismaClient): Promise<number> {
  const result = await prisma.webhookNonce.deleteMany({
    where: {
      expiresAt: {
        lt: new Date(),
      },
    },
  });
  return result.count;
}

/**
 * Verify webhook signature with secret rotation support
 */
export async function verifyCreatorWebhookSignature(
  prisma: PrismaClient,
  webhookId: string,
  payload: string,
  headers: WebhookVerificationHeaders,
  options: VerifyOptions = {},
  ipAddress?: string
): Promise<WebhookVerificationResult> {
  const auditService = new AuditService(prisma.auditLog as any);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = options.now ?? Math.floor(Date.now() / 1000);

  // Validate required headers
  if (!headers.signature) {
    logger.warn({ webhookId, ipAddress }, 'Webhook verification failed: missing signature header');
    await auditService.record({
      action: 'webhook.verification_failed',
      resource: 'webhook',
      resourceId: webhookId,
      ipAddress,
      changes: { reason: { old: null, new: 'missing_signature_header' } },
    });
    return { valid: false, reason: 'Missing signature header' };
  }

  if (!headers.timestamp) {
    logger.warn({ webhookId, ipAddress }, 'Webhook verification failed: missing timestamp header');
    await auditService.record({
      action: 'webhook.verification_failed',
      resource: 'webhook',
      resourceId: webhookId,
      ipAddress,
      changes: { reason: { old: null, new: 'missing_timestamp_header' } },
    });
    return { valid: false, reason: 'Missing timestamp header' };
  }

  if (!headers.nonce) {
    logger.warn({ webhookId, ipAddress }, 'Webhook verification failed: missing nonce header');
    await auditService.record({
      action: 'webhook.verification_failed',
      resource: 'webhook',
      resourceId: webhookId,
      ipAddress,
      changes: { reason: { old: null, new: 'missing_nonce_header' } },
    });
    return { valid: false, reason: 'Missing nonce header' };
  }

  // Parse timestamp
  const timestamp = parseInt(headers.timestamp, 10);
  if (isNaN(timestamp)) {
    logger.warn(
      { webhookId, timestamp: headers.timestamp, ipAddress },
      'Webhook verification failed: invalid timestamp'
    );
    await auditService.record({
      action: 'webhook.verification_failed',
      resource: 'webhook',
      resourceId: webhookId,
      ipAddress,
      changes: { reason: { old: null, new: 'invalid_timestamp_format' } },
    });
    return { valid: false, reason: 'Invalid timestamp format' };
  }

  // Check timestamp tolerance
  if (!isTimestampValid(timestamp, tolerance, now)) {
    logger.warn(
      { webhookId, timestamp, now, tolerance, ipAddress },
      'Webhook verification failed: timestamp outside tolerance window'
    );
    await auditService.record({
      action: 'webhook.verification_failed',
      resource: 'webhook',
      resourceId: webhookId,
      ipAddress,
      changes: {
        reason: { old: null, new: 'timestamp_outside_tolerance' },
        timestamp: { old: null, new: timestamp },
      },
    });
    return {
      valid: false,
      reason: 'Timestamp outside tolerance window',
      timestamp,
    };
  }

  // Check for replay attack (nonce reuse)
  if (!options.skipNonceCheck) {
    const nonceUsed = await isNonceUsed(prisma, webhookId, headers.nonce);
    if (nonceUsed) {
      logger.warn(
        { webhookId, nonce: headers.nonce, ipAddress },
        'Webhook verification failed: nonce already used (replay attack detected)'
      );
      await auditService.record({
        action: 'webhook.replay_attack_detected',
        resource: 'webhook',
        resourceId: webhookId,
        ipAddress,
        changes: {
          reason: { old: null, new: 'nonce_reused' },
          nonce: { old: null, new: headers.nonce },
        },
      });
      return {
        valid: false,
        reason: 'Nonce already used (possible replay attack)',
        timestamp,
      };
    }
  }

  // Fetch webhook with secrets
  const webhook = await prisma.webhook.findUnique({
    where: { id: webhookId },
    select: {
      id: true,
      secret: true,
      previousSecret: true,
      secretRotatedAt: true,
    },
  });

  if (!webhook) {
    logger.warn({ webhookId }, 'Webhook verification failed: webhook not found');
    return { valid: false, reason: 'Webhook not found' };
  }

  if (!webhook.secret) {
    logger.warn({ webhookId }, 'Webhook verification failed: webhook secret not configured');
    return { valid: false, reason: 'Webhook secret not configured' };
  }

  // Compute expected signature with current secret
  const expectedSignature = computeWebhookSignature(
    payload,
    webhook.secret,
    timestamp,
    headers.nonce
  );
  const currentSecretValid = safeEqual(headers.signature, expectedSignature);

  if (currentSecretValid) {
    // Store nonce to prevent replay
    if (!options.skipNonceCheck) {
      const expiresAt = new Date((timestamp + tolerance) * 1000);
      await storeNonce(prisma, webhookId, headers.nonce, timestamp, expiresAt);
    }

    logger.info({ webhookId, timestamp }, 'Webhook signature verified successfully');
    return {
      valid: true,
      webhookId,
      timestamp,
      usedPreviousSecret: false,
    };
  }

  // Try previous secret if rotation is recent
  if (webhook.previousSecret && webhook.secretRotatedAt) {
    const rotationAgeMs = Date.now() - webhook.secretRotatedAt.getTime();
    const gracePeriodMs = SECRET_ROTATION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

    if (rotationAgeMs <= gracePeriodMs) {
      const expectedPreviousSignature = computeWebhookSignature(
        payload,
        webhook.previousSecret,
        timestamp,
        headers.nonce
      );
      const previousSecretValid = safeEqual(headers.signature, expectedPreviousSignature);

      if (previousSecretValid) {
        // Store nonce to prevent replay
        if (!options.skipNonceCheck) {
          const expiresAt = new Date((timestamp + tolerance) * 1000);
          await storeNonce(prisma, webhookId, headers.nonce, timestamp, expiresAt);
        }

        logger.info(
          { webhookId, timestamp, usedPreviousSecret: true },
          'Webhook signature verified with previous secret'
        );
        return {
          valid: true,
          webhookId,
          timestamp,
          usedPreviousSecret: true,
        };
      }
    }
  }

  // Signature verification failed
  logger.warn({ webhookId, timestamp }, 'Webhook verification failed: signature mismatch');
  return {
    valid: false,
    reason: 'Signature mismatch',
    timestamp,
  };
}

/**
 * Build webhook signature header for sending webhooks
 */
export function buildWebhookSignatureHeaders(
  payload: string,
  secret: string,
  timestamp?: number,
  nonce?: string
): Record<string, string> {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const n = nonce ?? randomBytes(16).toString('hex');
  const signature = computeWebhookSignature(payload, secret, ts, n);

  return {
    'X-Webhook-Signature': signature,
    'X-Webhook-Timestamp': ts.toString(),
    'X-Webhook-Nonce': n,
  };
}
