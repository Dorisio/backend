import { z } from 'zod';
import { sanitizeString } from '../../middleware/validation';
import {
  ASSET_CODE_MAX_LENGTH,
  MAX_PAYMENT_AMOUNT,
  isValidAssetCode,
  isValidStellarPublicKey,
} from '../../lib/stellar/validation';
import { zodToJsonSchema } from '../../utils/zod-to-json-schema';
import { TIP_TEXT_SEARCH_MAX_LENGTH } from './tip-filters';
import { MAX_MEDIA_PER_TIP } from '../media/media.types';

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

const boundedNumber = (min: number, max: number, label: string) =>
  z.coerce
    .number()
    .finite(`${label} must be a finite number`)
    .min(min, `${label} must be at least ${min}`)
    .max(max, `${label} must not exceed ${max}`);

/**
 * Accepts any parseable date-time and normalizes it to ISO-8601 so the service
 * layer (and the echoed-back filter metadata) sees one canonical format.
 */
const isoDateSchema = (label: string) =>
  z
    .string()
    .trim()
    .refine((value) => !Number.isNaN(Date.parse(value)), `${label} must be an ISO-8601 date-time`)
    .transform((value) => new Date(value).toISOString());

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
  assetId: z.string().trim().min(1).max(100).optional(),
  idempotencyKey: z.string().trim().min(8, 'Idempotency key is too short').max(255).optional(),
  /**
   * Media uploaded beforehand and attached to this tip's message (#64). Every
   * id must belong to the tipper and be in the `ready` state.
   */
  mediaIds: z
    .array(z.string().trim().min(1, 'Media ID is required').max(100, 'Media ID is too long'))
    .max(MAX_MEDIA_PER_TIP, `A tip can carry at most ${MAX_MEDIA_PER_TIP} media items`)
    .optional(),
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
 *
 * Besides pagination and sorting it accepts the database-side filters added for
 * #56: date range, amount range, status, free-text search, sender and creator.
 * Every filter is optional and combined with AND by `buildTipWhere`.
 */
export const TipHistoryQuerySchema = z
  .object({
    page: boundedInt(1, 1_000_000, 'page').optional(),
    pageSize: boundedInt(1, 100, 'pageSize').optional(),
    limit: boundedInt(1, 100, 'limit').optional(),
    cursor: z.string().trim().max(512).optional(),
    after: z.string().trim().max(512).optional(),
    first: boundedInt(1, 100, 'first').optional(),
    sortBy: sortBySchema.optional(),
    sortOrder: sortOrderSchema.optional(),
    status: TipStatusEnum.optional(),
    // --- Filters (#56) -----------------------------------------------------
    minDate: isoDateSchema('minDate').optional(),
    maxDate: isoDateSchema('maxDate').optional(),
    minAmount: boundedNumber(0, MAX_PAYMENT_AMOUNT, 'minAmount').optional(),
    maxAmount: boundedNumber(0, MAX_PAYMENT_AMOUNT, 'maxAmount').optional(),
    query: sanitizedText(TIP_TEXT_SEARCH_MAX_LENGTH, 'Search query').optional(),
    fromUserId: z.string().trim().min(1, 'fromUserId is required').max(100).optional(),
    creatorId: z.string().trim().min(1, 'creatorId is required').max(100).optional(),
  })
  .refine(
    (q) => !q.minDate || !q.maxDate || Date.parse(q.minDate) <= Date.parse(q.maxDate),
    { message: 'minDate must be before or equal to maxDate', path: ['minDate'] }
  )
  .refine(
    (q) => q.minAmount === undefined || q.maxAmount === undefined || q.minAmount <= q.maxAmount,
    { message: 'minAmount must be less than or equal to maxAmount', path: ['minAmount'] }
  );

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
