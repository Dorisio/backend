import { z } from 'zod';
import { sanitizeString } from '../../middleware/validation';
import {
  ASSET_CODE_MAX_LENGTH,
  MAX_PAYMENT_AMOUNT,
  isValidAssetCode,
  isValidStellarPublicKey,
} from '../../lib/stellar/validation';
import { zodToJsonSchema } from '../../utils/zod-to-json-schema';

/**
 * Request schemas for the payments domain.
 *
 * These are the single source of truth for request validation: routes validate
 * with them (before touching the service/database) and the OpenAPI schemas at
 * the bottom of this file are derived from them, so documentation cannot drift
 * from enforcement.
 */

export const TipStatusEnum = z.enum(['pending', 'completed', 'failed', 'cancelled']);

export const ALLOWED_SORT_FIELDS = ['createdAt', 'amount', 'status', 'id', 'updatedAt'] as const;

export const StellarPublicKeySchema = z
  .string()
  .trim()
  .refine(isValidStellarPublicKey, { message: 'Invalid Stellar public key' });

/** Text fields are sanitized (control chars/tags removed) before length checks. */
const sanitizedText = (maxLength: number, label: string) =>
  z
    .string()
    .transform((value) => sanitizeString(value, { collapseWhitespace: false }))
    .pipe(z.string().max(maxLength, `${label} must be ${maxLength} characters or less`));

const sortBySchema = z
  .string()
  .trim()
  .max(200)
  .refine(
    (value) =>
      value
        .split(',')
        .map((field) => field.trim().replace(/^[+-]/, ''))
        .filter(Boolean)
        .every((field) => (ALLOWED_SORT_FIELDS as readonly string[]).includes(field)),
    { message: `sortBy must be a comma separated list of: ${ALLOWED_SORT_FIELDS.join(', ')}` }
  );

const sortOrderSchema = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .pipe(z.enum(['asc', 'desc']));

const boundedInt = (min: number, max: number, label: string) =>
  z.coerce
    .number()
    .int(`${label} must be an integer`)
    .min(min, `${label} must be at least ${min}`)
    .max(max, `${label} must not exceed ${max}`);

/**
 * POST /api/v1/transactions/tip
 */
export const CreateTipSchema = z.object({
  creatorId: z.string().trim().min(1, 'Creator ID is required').max(100, 'Creator ID is too long'),
  amount: z
    .number()
    .finite('Amount must be a finite number')
    .positive('Amount must be greater than 0')
    .max(MAX_PAYMENT_AMOUNT, `Amount must not exceed ${MAX_PAYMENT_AMOUNT}`),
  message: sanitizedText(500, 'Message').optional(),
  currency: z.enum(['USD', 'XLM', 'USDC']).default('USD'),
  idempotencyKey: z.string().trim().min(8, 'Idempotency key is too short').max(255).optional(),
});

/**
 * PATCH /api/v1/transactions/:id/status
 */
export const UpdateTipStatusSchema = z.object({
  status: TipStatusEnum,
  transactionHash: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{64}$/i, 'transactionHash must be a 64 character hex string')
    .optional(),
});

/**
 * POST /api/v1/transactions/:id/build
 */
export const BuildPaymentTransactionSchema = z.object({
  senderPublicKey: StellarPublicKeySchema,
  creatorPublicKey: StellarPublicKeySchema,
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,7})?$/, 'Invalid amount format')
    .refine((value) => Number(value) > 0, 'Amount must be greater than 0')
    .refine((value) => Number(value) <= MAX_PAYMENT_AMOUNT, `Amount must not exceed ${MAX_PAYMENT_AMOUNT}`),
  assetCode: z
    .string()
    .trim()
    .max(ASSET_CODE_MAX_LENGTH)
    .refine(isValidAssetCode, 'Invalid asset code')
    .optional(),
  assetIssuer: StellarPublicKeySchema.optional(),
});

/**
 * POST /api/v1/transactions/:id/submit
 */
export const SubmitPaymentTransactionSchema = z.object({
  transactionEnvelope: z
    .string()
    .trim()
    .min(1, 'Transaction envelope is required')
    .max(100_000, 'Transaction envelope is too large'),
});

/**
 * GET /api/v1/transactions/:id and confirm/status routes
 */
export const TipIdParamsSchema = z.object({
  id: z.string().trim().min(1, 'Tip ID is required').max(64, 'Tip ID is too long'),
});

/**
 * GET /api/v1/transactions/creator/:creatorId
 */
export const CreatorIdParamsSchema = z.object({
  creatorId: z.string().trim().min(1, 'Creator ID is required').max(100, 'Creator ID is too long'),
});

/**
 * Pagination/filtering query shared by history and creator listings.
 */
export const TipHistoryQuerySchema = z.object({
  page: boundedInt(1, 1_000_000, 'page').optional(),
  pageSize: boundedInt(1, 100, 'pageSize').optional(),
  limit: boundedInt(1, 100, 'limit').optional(),
  cursor: z.string().trim().max(512).optional(),
  after: z.string().trim().max(512).optional(),
  first: boundedInt(1, 100, 'first').optional(),
  sortBy: sortBySchema.optional(),
  sortOrder: sortOrderSchema.optional(),
  status: TipStatusEnum.optional(),
});

export type CreateTipInput = z.infer<typeof CreateTipSchema>;
export type UpdateTipStatusInput = z.infer<typeof UpdateTipStatusSchema>;
export type BuildPaymentTransactionInput = z.infer<typeof BuildPaymentTransactionSchema>;
export type SubmitPaymentTransactionInput = z.infer<typeof SubmitPaymentTransactionSchema>;
export type TipHistoryQueryInput = z.infer<typeof TipHistoryQuerySchema>;

/**
 * JSON schemas derived from the Zod schemas above, attached to Fastify routes so
 * `/docs` always reflects the real validation rules.
 */
export const createTipJsonSchema = zodToJsonSchema(CreateTipSchema);
export const updateTipStatusJsonSchema = zodToJsonSchema(UpdateTipStatusSchema);
export const buildPaymentTransactionJsonSchema = zodToJsonSchema(BuildPaymentTransactionSchema);
export const submitPaymentTransactionJsonSchema = zodToJsonSchema(SubmitPaymentTransactionSchema);
export const tipIdParamsJsonSchema = zodToJsonSchema(TipIdParamsSchema);
export const creatorIdParamsJsonSchema = zodToJsonSchema(CreatorIdParamsSchema);
export const tipHistoryQueryJsonSchema = zodToJsonSchema(TipHistoryQuerySchema);
