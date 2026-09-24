import { describe, it, expect } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import {
  BuildPaymentTransactionSchema,
  CreateTipSchema,
  SubmitPaymentTransactionSchema,
  TipHistoryQuerySchema,
  buildPaymentTransactionJsonSchema,
  createTipJsonSchema,
} from '../payment.schemas';

const validPublicKey = Keypair.random().publicKey();

describe('CreateTipSchema', () => {
  it('accepts a valid tip and applies defaults', () => {
    const result = CreateTipSchema.parse({ creatorId: 'creator-1', amount: 25 });
    expect(result.currency).toBe('USD');
    expect(result.amount).toBe(25);
  });

  it('sanitizes the message', () => {
    const result = CreateTipSchema.parse({
      creatorId: 'creator-1',
      amount: 5,
      message: '  <script>hi</script>  ',
    });
    expect(result.message).toBe('hi');
  });

  it('rejects invalid amounts', () => {
    expect(CreateTipSchema.safeParse({ creatorId: 'c', amount: 0 }).success).toBe(false);
    expect(CreateTipSchema.safeParse({ creatorId: 'c', amount: -1 }).success).toBe(false);
    expect(CreateTipSchema.safeParse({ creatorId: 'c', amount: 2_000_000 }).success).toBe(false);
  });

  it('rejects an over-long message', () => {
    const result = CreateTipSchema.safeParse({
      creatorId: 'c',
      amount: 5,
      message: 'a'.repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing creatorId', () => {
    expect(CreateTipSchema.safeParse({ amount: 5 }).success).toBe(false);
  });
});

describe('BuildPaymentTransactionSchema', () => {
  it('accepts valid Stellar inputs', () => {
    const result = BuildPaymentTransactionSchema.safeParse({
      senderPublicKey: validPublicKey,
      creatorPublicKey: validPublicKey,
      amount: '10.5',
      assetCode: 'USDC',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid public keys using StrKey validation', () => {
    const result = BuildPaymentTransactionSchema.safeParse({
      senderPublicKey: 'GINVALID',
      creatorPublicKey: validPublicKey,
      amount: '10',
    });
    expect(result.success).toBe(false);
  });

  it('rejects malformed or excessive amounts', () => {
    expect(
      BuildPaymentTransactionSchema.safeParse({
        senderPublicKey: validPublicKey,
        creatorPublicKey: validPublicKey,
        amount: 'abc',
      }).success
    ).toBe(false);

    expect(
      BuildPaymentTransactionSchema.safeParse({
        senderPublicKey: validPublicKey,
        creatorPublicKey: validPublicKey,
        amount: '999999999',
      }).success
    ).toBe(false);
  });

  it('rejects invalid asset codes', () => {
    expect(
      BuildPaymentTransactionSchema.safeParse({
        senderPublicKey: validPublicKey,
        creatorPublicKey: validPublicKey,
        amount: '10',
        assetCode: 'NOT A CODE',
      }).success
    ).toBe(false);
  });
});

describe('SubmitPaymentTransactionSchema', () => {
  it('requires an envelope', () => {
    expect(SubmitPaymentTransactionSchema.safeParse({}).success).toBe(false);
    expect(SubmitPaymentTransactionSchema.safeParse({ transactionEnvelope: 'AAAA...' }).success).toBe(
      true
    );
  });
});

describe('TipHistoryQuerySchema', () => {
  it('coerces numeric query values', () => {
    const result = TipHistoryQuerySchema.parse({ page: '2', pageSize: '25', first: '5' });
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(25);
    expect(result.first).toBe(5);
  });

  it('rejects out-of-range pagination', () => {
    expect(TipHistoryQuerySchema.safeParse({ pageSize: '1000' }).success).toBe(false);
    expect(TipHistoryQuerySchema.safeParse({ page: '0' }).success).toBe(false);
  });

  it('normalizes sort order and validates allowed sort fields', () => {
    expect(TipHistoryQuerySchema.parse({ sortOrder: 'DESC' }).sortOrder).toBe('desc');
    expect(TipHistoryQuerySchema.safeParse({ sortBy: 'password' }).success).toBe(false);
    expect(TipHistoryQuerySchema.safeParse({ sortBy: 'createdAt,amount' }).success).toBe(true);
  });

  it('validates the status filter', () => {
    expect(TipHistoryQuerySchema.safeParse({ status: 'completed' }).success).toBe(true);
    expect(TipHistoryQuerySchema.safeParse({ status: 'bogus' }).success).toBe(false);
  });
});

describe('derived OpenAPI schemas', () => {
  it('derives a JSON schema for the tip body', () => {
    const schema = createTipJsonSchema as {
      type: string;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.type).toBe('object');
    expect(schema.properties).toHaveProperty('amount');
    expect(schema.properties).toHaveProperty('currency');
    expect(schema.required).toEqual(expect.arrayContaining(['creatorId', 'amount']));
    // currency has a default and must not be required
    expect(schema.required).not.toContain('currency');
  });

  it('derives a JSON schema for the transaction build body', () => {
    const schema = buildPaymentTransactionJsonSchema as { properties: Record<string, unknown> };
    expect(schema.properties).toHaveProperty('senderPublicKey');
    expect(schema.properties).toHaveProperty('creatorPublicKey');
  });
});
