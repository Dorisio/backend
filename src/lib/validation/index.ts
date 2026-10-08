import { z } from 'zod';

const id = z.string().trim().min(1).max(128);
const email = z.string().trim().email().max(320);
const amount = z.number().finite().positive().max(1_000_000);

export const authSchemas = {
  login: z.object({ email, password: z.string().min(8).max(256) }).strict(),
  register: z.object({ email, password: z.string().min(12).max(256), name: z.string().trim().min(1).max(120).optional() }).strict(),
};

export const paymentSchemas = {
  createTip: z.object({
    creatorId: id,
    amount,
    message: z.string().trim().max(2_000).optional(),
    idempotencyKey: z.string().trim().min(8).max(128).optional(),
  }).strict(),
  payout: z.object({ amount: amount.max(1_000_000) }).strict(),
  tipStatus: z.object({ status: z.enum(['pending', 'completed', 'failed', 'cancelled']) }).strict(),
};

export const creatorSchemas = {
  create: z.object({ username: z.string().trim().regex(/^[a-zA-Z0-9_]{3,32}$/), displayName: z.string().trim().max(120).optional(), bio: z.string().trim().max(2_000).optional() }).strict(),
  update: z.object({ displayName: z.string().trim().max(120).optional(), bio: z.string().trim().max(2_000).optional(), avatar: z.string().url().max(2_048).optional(), isPublic: z.boolean().optional() }).strict(),
};

export const adminSchemas = {
  idParams: z.object({ id }).strict(),
  pagination: z.object({ page: z.coerce.number().int().min(1).max(10_000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }).strict(),
};

export const requestSchemas = { auth: authSchemas, payments: paymentSchemas, creators: creatorSchemas, admin: adminSchemas };
export type RequestSchemas = typeof requestSchemas;
