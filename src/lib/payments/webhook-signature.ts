import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Webhook signature verification (Stripe scheme).
 *
 * Stripe signs `<timestamp>.<raw body>` with HMAC-SHA256 and sends the result in
 * a `Stripe-Signature` header shaped like `t=...,v1=...`. We verify both the
 * digest (constant time) and the timestamp (replay protection).
 */

export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface SignatureHeader {
  timestamp?: number;
  signatures: string[];
}

export interface SignatureVerificationResult {
  valid: boolean;
  reason?: string;
  timestamp?: number;
}

export function parseSignatureHeader(header: string | undefined | null): SignatureHeader {
  if (!header) {
    return { signatures: [] };
  }

  const result: SignatureHeader = { signatures: [] };

  for (const part of header.split(',')) {
    const [key, value] = part.split('=').map((segment) => segment.trim());
    if (!key || !value) continue;

    if (key === 't') {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isNaN(parsed)) {
        result.timestamp = parsed;
      }
    } else if (key === 'v1') {
      result.signatures.push(value);
    }
  }

  return result;
}

export function computeSignature(payload: string, secret: string, timestamp: number): string {
  return createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

export interface VerifyOptions {
  toleranceSeconds?: number;
  /** Injectable clock (seconds since epoch) for tests. */
  now?: number;
}

export function verifyWebhookSignature(
  payload: string,
  header: string | undefined | null,
  secret: string,
  options: VerifyOptions = {}
): SignatureVerificationResult {
  if (!secret) {
    return { valid: false, reason: 'Webhook secret is not configured' };
  }

  const { timestamp, signatures } = parseSignatureHeader(header);
  if (timestamp === undefined || signatures.length === 0) {
    return { valid: false, reason: 'Malformed signature header' };
  }

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = options.now ?? Math.floor(Date.now() / 1000);

  if (tolerance > 0 && Math.abs(now - timestamp) > tolerance) {
    return { valid: false, reason: 'Signature timestamp outside tolerance', timestamp };
  }

  const expected = computeSignature(payload, secret, timestamp);
  const matched = signatures.some((signature) => safeEqual(signature, expected));

  return matched ? { valid: true, timestamp } : { valid: false, reason: 'Signature mismatch', timestamp };
}

export function buildSignatureHeader(payload: string, secret: string, timestamp: number): string {
  return `t=${timestamp},v1=${computeSignature(payload, secret, timestamp)}`;
}
