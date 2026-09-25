/**
 * Minimal Zod -> JSON Schema (draft-07) converter.
 *
 * Fastify/OpenAPI need plain JSON Schemas, while our validation layer is
 * authored with Zod. Rather than duplicating every rule by hand (and letting
 * the two drift) we derive the documentation schema from the same Zod schema
 * that validates the request.
 *
 * Only the constructs used across the API are supported; unknown constructs
 * degrade to a permissive `{}` so a route is never blocked by a documentation
 * gap.
 */

export type JsonSchema = Record<string, unknown>;

interface ZodDef {
  typeName?: string;
  checks?: Array<Record<string, unknown>>;
  type?: unknown;
  value?: unknown;
  values?: unknown;
  innerType?: unknown;
  schema?: unknown;
  options?: unknown[];
  minLength?: { value: number };
  maxLength?: { value: number };
  unknownKeys?: string;
}

function getDef(schema: unknown): ZodDef | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  return (schema as { _def?: ZodDef })._def;
}

function getTypeName(schema: unknown): string | undefined {
  return getDef(schema)?.typeName;
}

function getObjectShape(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const shape = (schema as { shape?: unknown }).shape;
  if (typeof shape === 'function') {
    return (shape as () => Record<string, unknown>)();
  }
  if (shape && typeof shape === 'object') {
    return shape as Record<string, unknown>;
  }
  return undefined;
}

const OPTIONAL_TYPE_NAMES = new Set(['ZodOptional', 'ZodDefault', 'ZodNullable']);

function isOptionalSchema(schema: unknown): boolean {
  const typeName = getTypeName(schema);
  return typeName !== undefined && OPTIONAL_TYPE_NAMES.has(typeName);
}

function convertString(def: ZodDef): JsonSchema {
  const schema: JsonSchema = { type: 'string' };

  for (const check of def.checks ?? []) {
    switch (check.kind) {
      case 'min':
        schema.minLength = check.value as number;
        break;
      case 'max':
        schema.maxLength = check.value as number;
        break;
      case 'length':
        schema.minLength = check.value as number;
        schema.maxLength = check.value as number;
        break;
      case 'regex':
        schema.pattern = (check.regex as RegExp).source;
        break;
      case 'email':
        schema.format = 'email';
        break;
      case 'url':
        schema.format = 'uri';
        break;
      case 'uuid':
        schema.format = 'uuid';
        break;
      case 'cuid':
        schema.pattern = '^c[^\\s-]{8,}$';
        break;
      case 'datetime':
        schema.format = 'date-time';
        break;
      default:
        break;
    }
  }

  return schema;
}

function convertNumber(def: ZodDef): JsonSchema {
  let integer = false;
  let minimum: number | undefined;
  let maximum: number | undefined;
  let exclusiveMinimum: number | undefined;
  let exclusiveMaximum: number | undefined;
  let multipleOf: number | undefined;

  for (const check of def.checks ?? []) {
    const value = check.value as number;
    switch (check.kind) {
      case 'int':
        integer = true;
        break;
      case 'min':
        if (check.inclusive === false) exclusiveMinimum = value;
        else minimum = value;
        break;
      case 'max':
        if (check.inclusive === false) exclusiveMaximum = value;
        else maximum = value;
        break;
      case 'multipleOf':
        multipleOf = value;
        break;
      default:
        break;
    }
  }

  const schema: JsonSchema = { type: integer ? 'integer' : 'number' };
  if (minimum !== undefined) schema.minimum = minimum;
  if (maximum !== undefined) schema.maximum = maximum;
  if (exclusiveMinimum !== undefined) schema.exclusiveMinimum = exclusiveMinimum;
  if (exclusiveMaximum !== undefined) schema.exclusiveMaximum = exclusiveMaximum;
  if (multipleOf !== undefined) schema.multipleOf = multipleOf;
  return schema;
}

export function zodToJsonSchema(schema: unknown): JsonSchema {
  const def = getDef(schema);
  if (!def) return {};

  switch (def.typeName) {
    case 'ZodString':
      return convertString(def);

    case 'ZodNumber':
      return convertNumber(def);

    case 'ZodBoolean':
      return { type: 'boolean' };

    case 'ZodBigInt':
      return { type: 'integer', format: 'int64' };

    case 'ZodNull':
      return { type: 'null' };

    case 'ZodLiteral':
      return { const: def.value };

    case 'ZodEnum':
      return { type: 'string', enum: def.values };

    case 'ZodNativeEnum':
      return { enum: Object.values((def.values as Record<string, unknown>) ?? {}) };

    case 'ZodArray': {
      const arrayDef = def as ZodDef & { minLength?: { value: number }; maxLength?: { value: number } };
      const result: JsonSchema = { type: 'array', items: zodToJsonSchema(def.type) };
      if (arrayDef.minLength) result.minItems = arrayDef.minLength.value;
      if (arrayDef.maxLength) result.maxItems = arrayDef.maxLength.value;
      return result;
    }

    case 'ZodTuple': {
      const items = (def.options ?? []).map((option) => zodToJsonSchema(option));
      return { type: 'array', items, minItems: items.length, maxItems: items.length };
    }

    case 'ZodObject': {
      const shape = getObjectShape(schema) ?? {};
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, valueSchema] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(valueSchema);
        if (!isOptionalSchema(valueSchema)) {
          required.push(key);
        }
      }

      const result: JsonSchema = { type: 'object', properties };
      if (required.length > 0) result.required = required;
      if (def.unknownKeys === 'strict') result.additionalProperties = false;
      return result;
    }

    case 'ZodRecord':
      return { type: 'object', additionalProperties: zodToJsonSchema(def.value) };

    case 'ZodUnion':
      return { anyOf: (def.options ?? []).map((option) => zodToJsonSchema(option)) };

    case 'ZodDiscriminatedUnion':
      return { anyOf: (def.options ?? []).map((option) => zodToJsonSchema(option)) };

    case 'ZodIntersection':
      return { allOf: [zodToJsonSchema(def.type), zodToJsonSchema(def.schema)] };

    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodReadonly':
      return zodToJsonSchema(def.innerType);

    case 'ZodEffects':
      // Transforms and refinements are enforced at runtime by Zod; the underlying
      // shape is what we document.
      return zodToJsonSchema(def.schema);

    case 'ZodCatch':
      return zodToJsonSchema(def.innerType);

    case 'ZodPipeline':
      return zodToJsonSchema(def.schema);

    case 'ZodAny':
    case 'ZodUnknown':
      return {};

    case 'ZodNever':
      return { not: {} };

    default:
      return {};
  }
}
