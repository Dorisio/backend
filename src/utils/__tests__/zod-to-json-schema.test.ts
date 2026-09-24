import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from '../zod-to-json-schema';

describe('zodToJsonSchema', () => {
  it('converts objects with required and optional properties', () => {
    const schema = z.object({
      name: z.string(),
      nickname: z.string().optional(),
    });

    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        nickname: { type: 'string' },
      },
      required: ['name'],
    });
  });

  it('maps string constraints', () => {
    const schema = z.object({
      code: z.string().min(2).max(8),
      slug: z.string().regex(/^[a-z-]+$/),
      email: z.string().email(),
    });

    const json = zodToJsonSchema(schema) as { properties: Record<string, Record<string, unknown>> };
    expect(json.properties.code).toEqual({ type: 'string', minLength: 2, maxLength: 8 });
    expect(json.properties.slug.pattern).toBe('^[a-z-]+$');
    expect(json.properties.email.format).toBe('email');
  });

  it('maps number constraints and integers', () => {
    const schema = z.object({
      amount: z.number().positive().max(100),
      count: z.number().int().min(1),
    });

    const json = zodToJsonSchema(schema) as { properties: Record<string, Record<string, unknown>> };
    expect(json.properties.amount).toEqual({
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 100,
    });
    expect(json.properties.count).toMatchObject({ type: 'integer', minimum: 1 });
  });

  it('converts enums and literals', () => {
    const schema = z.object({
      status: z.enum(['pending', 'completed']),
      kind: z.literal('tip'),
    });

    const json = zodToJsonSchema(schema) as { properties: Record<string, Record<string, unknown>> };
    expect(json.properties.status).toEqual({ type: 'string', enum: ['pending', 'completed'] });
    expect(json.properties.kind).toEqual({ const: 'tip' });
  });

  it('converts arrays with item schemas', () => {
    const schema = z.object({ tags: z.array(z.string()).min(1).max(5) });
    const json = zodToJsonSchema(schema) as { properties: Record<string, Record<string, unknown>> };
    expect(json.properties.tags).toEqual({
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 5,
    });
  });

  it('unwraps defaults, optionals and transforms', () => {
    const schema = z.object({
      currency: z.enum(['USD', 'XLM']).default('USD'),
      message: z.string().transform((value) => value.trim()),
    });

    const json = zodToJsonSchema(schema) as { properties: Record<string, Record<string, unknown>> };
    expect(json.properties.currency).toEqual({ type: 'string', enum: ['USD', 'XLM'] });
    expect(json.properties.message).toEqual({ type: 'string' });
  });

  it('marks strict objects as not allowing additional properties', () => {
    const schema = z.object({ a: z.string() }).strict();
    expect(zodToJsonSchema(schema)).toMatchObject({ additionalProperties: false });
  });

  it('degrades gracefully for unknown constructs', () => {
    expect(zodToJsonSchema(undefined)).toEqual({});
    expect(zodToJsonSchema({ not: 'a zod schema' })).toEqual({});
    expect(zodToJsonSchema(z.any())).toEqual({});
  });
});
