import { describe, it, expect } from 'vitest';
import {
  buildSignatureHeader,
  computeSignature,
  parseSignatureHeader,
  verifyWebhookSignature,
} from '../webhook-signature';

const SECRET = 'whsec_test_secret';
const PAYLOAD = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });
const NOW = 1_800_000_000;

describe('parseSignatureHeader', () => {
  it('extracts the timestamp and signatures', () => {
    expect(parseSignatureHeader('t=123,v1=abc,v1=def')).toEqual({
      timestamp: 123,
      signatures: ['abc', 'def'],
    });
  });

  it('handles missing or malformed headers', () => {
    expect(parseSignatureHeader(undefined)).toEqual({ signatures: [] });
    expect(parseSignatureHeader('')).toEqual({ signatures: [] });
    expect(parseSignatureHeader('garbage')).toEqual({ signatures: [] });
  });
});

describe('computeSignature', () => {
  it('is deterministic and depends on the timestamp', () => {
    expect(computeSignature(PAYLOAD, SECRET, 1)).toBe(computeSignature(PAYLOAD, SECRET, 1));
    expect(computeSignature(PAYLOAD, SECRET, 1)).not.toBe(computeSignature(PAYLOAD, SECRET, 2));
  });
});

describe('verifyWebhookSignature', () => {
  it('accepts a correctly signed payload', () => {
    const header = buildSignatureHeader(PAYLOAD, SECRET, NOW);
    expect(verifyWebhookSignature(PAYLOAD, header, SECRET, { now: NOW })).toEqual({
      valid: true,
      timestamp: NOW,
    });
  });

  it('rejects a tampered payload', () => {
    const header = buildSignatureHeader(PAYLOAD, SECRET, NOW);
    const tampered = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', extra: true });
    const result = verifyWebhookSignature(tampered, header, SECRET, { now: NOW });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Signature mismatch');
  });

  it('rejects a signature made with the wrong secret', () => {
    const header = buildSignatureHeader(PAYLOAD, 'wrong_secret', NOW);
    expect(verifyWebhookSignature(PAYLOAD, header, SECRET, { now: NOW }).valid).toBe(false);
  });

  it('rejects a timestamp outside the tolerance window', () => {
    const header = buildSignatureHeader(PAYLOAD, SECRET, NOW - 10_000);
    const result = verifyWebhookSignature(PAYLOAD, header, SECRET, { now: NOW, toleranceSeconds: 300 });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('tolerance');
  });

  it('allows disabling the timestamp check', () => {
    const header = buildSignatureHeader(PAYLOAD, SECRET, NOW - 10_000);
    expect(
      verifyWebhookSignature(PAYLOAD, header, SECRET, { now: NOW, toleranceSeconds: 0 }).valid
    ).toBe(true);
  });

  it('rejects malformed headers and missing secrets', () => {
    expect(verifyWebhookSignature(PAYLOAD, 't=abc', SECRET, { now: NOW }).valid).toBe(false);
    expect(verifyWebhookSignature(PAYLOAD, undefined, SECRET, { now: NOW }).valid).toBe(false);
    expect(verifyWebhookSignature(PAYLOAD, buildSignatureHeader(PAYLOAD, SECRET, NOW), '').valid).toBe(false);
  });

  it('accepts when any of the provided signatures matches', () => {
    const header = `t=${NOW},v1=deadbeef,${buildSignatureHeader(PAYLOAD, SECRET, NOW)}`;
    expect(verifyWebhookSignature(PAYLOAD, header, SECRET, { now: NOW }).valid).toBe(true);
  });
});
