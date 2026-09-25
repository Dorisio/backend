import { StrKey } from '@stellar/stellar-sdk';

/**
 * Stellar specific input validation helpers.
 *
 * These are intentionally pure and side-effect free so they can be reused by
 * Zod schemas, route handlers and services alike.
 */

/** Maximum byte length of a Stellar transaction memo (text). */
export const MEMO_MAX_LENGTH = 28;

/** Upper bound for a single tip/payment amount, protecting the ledger and DB. */
export const MAX_PAYMENT_AMOUNT = 1_000_000;

/** Asset codes are 1-12 alphanumeric characters (Stellar asset code rules). */
export const ASSET_CODE_MAX_LENGTH = 12;

export function isValidStellarPublicKey(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  try {
    return StrKey.isValidEd25519PublicKey(value);
  } catch {
    return false;
  }
}

export function isValidStellarSecretKey(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  try {
    return StrKey.isValidEd25519SecretSeed(value);
  } catch {
    return false;
  }
}

export function isValidAssetCode(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9]{1,12}$/.test(value);
}

export interface MemoValidationResult {
  valid: boolean;
  length: number;
  reason?: string;
}

/**
 * Validates a transaction memo against Stellar's 28 byte limit. Multibyte
 * characters are counted by their UTF-8 byte length, not by code points.
 */
export function validateMemo(memo: unknown): MemoValidationResult {
  if (memo === undefined || memo === null) {
    return { valid: true, length: 0 };
  }

  if (typeof memo !== 'string') {
    return { valid: false, length: 0, reason: 'Memo must be a string' };
  }

  const length = Buffer.byteLength(memo, 'utf8');
  if (length > MEMO_MAX_LENGTH) {
    return {
      valid: false,
      length,
      reason: `Memo must be at most ${MEMO_MAX_LENGTH} characters`,
    };
  }

  return { valid: true, length };
}

/**
 * Builds a memo for a tip that is guaranteed to fit within the Stellar memo
 * limit. Falls back to the bare identifier when the `tip-` prefix would push it
 * over the boundary.
 */
export function buildTipMemo(tipId: string): string {
  const prefixed = `tip-${tipId}`;
  if (Buffer.byteLength(prefixed, 'utf8') <= MEMO_MAX_LENGTH) {
    return prefixed;
  }
  return tipId.slice(0, MEMO_MAX_LENGTH);
}

export interface AmountValidationResult {
  valid: boolean;
  value?: number;
  reason?: string;
}

/**
 * Validates a payment amount: positive, finite, with at most 7 decimal places
 * (Stellar's precision) and within a sane upper bound.
 */
export function validatePaymentAmount(amount: unknown): AmountValidationResult {
  const value = typeof amount === 'string' ? Number(amount) : amount;

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { valid: false, reason: 'Amount must be a finite number' };
  }

  if (value <= 0) {
    return { valid: false, reason: 'Amount must be greater than 0' };
  }

  if (value > MAX_PAYMENT_AMOUNT) {
    return { valid: false, reason: `Amount must not exceed ${MAX_PAYMENT_AMOUNT}` };
  }

  const decimals = `${value}`.split('.')[1];
  if (decimals && decimals.length > 7) {
    return { valid: false, reason: 'Amount supports at most 7 decimal places' };
  }

  return { valid: true, value };
}
