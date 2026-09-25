import { describe, it, expect } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import {
  ASSET_CODE_MAX_LENGTH,
  MAX_PAYMENT_AMOUNT,
  MEMO_MAX_LENGTH,
  buildTipMemo,
  isValidAssetCode,
  isValidStellarPublicKey,
  isValidStellarSecretKey,
  validateMemo,
  validatePaymentAmount,
} from './validation';

describe('isValidStellarPublicKey', () => {
  it('accepts a valid ed25519 public key', () => {
    expect(isValidStellarPublicKey(Keypair.random().publicKey())).toBe(true);
  });

  it('rejects secret keys, malformed strings and non-strings', () => {
    const keypair = Keypair.random();
    expect(isValidStellarPublicKey(keypair.secret())).toBe(false);
    expect(isValidStellarPublicKey('not-a-key')).toBe(false);
    expect(isValidStellarPublicKey('')).toBe(false);
    expect(isValidStellarPublicKey(null)).toBe(false);
    expect(isValidStellarPublicKey(123)).toBe(false);
  });
});

describe('isValidStellarSecretKey', () => {
  it('accepts a valid secret seed and rejects public keys', () => {
    const keypair = Keypair.random();
    expect(isValidStellarSecretKey(keypair.secret())).toBe(true);
    expect(isValidStellarSecretKey(keypair.publicKey())).toBe(false);
  });
});

describe('isValidAssetCode', () => {
  it('accepts 1-12 alphanumeric characters', () => {
    expect(isValidAssetCode('USDC')).toBe(true);
    expect(isValidAssetCode('xlm')).toBe(true);
    expect(isValidAssetCode('A'.repeat(ASSET_CODE_MAX_LENGTH))).toBe(true);
  });

  it('rejects empty, over-long and non-alphanumeric codes', () => {
    expect(isValidAssetCode('')).toBe(false);
    expect(isValidAssetCode('A'.repeat(ASSET_CODE_MAX_LENGTH + 1))).toBe(false);
    expect(isValidAssetCode('US DC')).toBe(false);
    expect(isValidAssetCode('US$C')).toBe(false);
  });
});

describe('validateMemo', () => {
  it('allows missing memos', () => {
    expect(validateMemo(undefined)).toEqual({ valid: true, length: 0 });
    expect(validateMemo(null)).toEqual({ valid: true, length: 0 });
  });

  it('accepts memos up to the Stellar limit', () => {
    expect(validateMemo('a'.repeat(MEMO_MAX_LENGTH)).valid).toBe(true);
  });

  it('rejects memos over the limit', () => {
    const result = validateMemo('a'.repeat(MEMO_MAX_LENGTH + 1));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain(String(MEMO_MAX_LENGTH));
  });

  it('counts multibyte characters by byte length', () => {
    // 'é' is 2 bytes in UTF-8, so 15 of them exceed 28 bytes.
    expect(validateMemo('é'.repeat(15)).valid).toBe(false);
  });

  it('rejects non-string memos', () => {
    expect(validateMemo(42).valid).toBe(false);
  });
});

describe('buildTipMemo', () => {
  it('prefixes short tip ids', () => {
    expect(buildTipMemo('abc123')).toBe('tip-abc123');
  });

  it('produces a memo that always satisfies the Stellar limit', () => {
    const longId = 'c'.repeat(40);
    const memo = buildTipMemo(longId);
    expect(validateMemo(memo).valid).toBe(true);
    expect(memo.length).toBeLessThanOrEqual(MEMO_MAX_LENGTH);
  });
});

describe('validatePaymentAmount', () => {
  it('accepts positive amounts with up to 7 decimals', () => {
    expect(validatePaymentAmount(1)).toMatchObject({ valid: true, value: 1 });
    expect(validatePaymentAmount('1.5')).toMatchObject({ valid: true, value: 1.5 });
    expect(validatePaymentAmount('0.0000001').valid).toBe(true);
  });

  it('rejects non-positive and non-finite amounts', () => {
    expect(validatePaymentAmount(0).valid).toBe(false);
    expect(validatePaymentAmount(-10).valid).toBe(false);
    expect(validatePaymentAmount(Number.POSITIVE_INFINITY).valid).toBe(false);
    expect(validatePaymentAmount('abc').valid).toBe(false);
    expect(validatePaymentAmount(undefined).valid).toBe(false);
  });

  it('rejects amounts above the sane maximum', () => {
    expect(validatePaymentAmount(MAX_PAYMENT_AMOUNT + 1).valid).toBe(false);
  });

  it('rejects more than 7 decimal places', () => {
    expect(validatePaymentAmount(1.12345678).valid).toBe(false);
  });
});
