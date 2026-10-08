/**
 * Centralized configuration schema (issue #60).
 *
 * Every environment variable the application reads is declared here, exactly
 * once, with a type, a default and — where it makes sense — a range. The
 * schema is the single source of truth used by:
 *
 * - `src/config/loader.ts` — startup validation (fails fast on invalid config)
 * - `docs/CONFIGURATION.md` — the documentation of every variable
 * - `src/config/audit.ts` — which keys are secrets (never logged verbatim)
 *
 * Numeric and boolean values arrive from the environment as strings; the
 * helpers below coerce them (with empty string meaning "use the default") and
 * enforce the documented range, so a typo like `PORT=99999` is caught at
 * startup instead of at first request.
 */
import { z } from 'zod';

export type ConfigEnvironment = 'development' | 'staging' | 'production' | 'test';

/** Range/shape options for numeric environment variables. */
interface NumberOptions {
  /** Reject values below this (inclusive). */
  min?: number;
  /** Reject values above this (inclusive). */
  max?: number;
  /** Require an integer (default: false). */
  int?: boolean;
}

/**
 * Numeric variable with a default. Coercion happens inside the preprocess so
 * that `PORT=` (empty) and an unset `PORT` both fall back to the default,
 * while `PORT=abc` and out-of-range values produce readable Zod issues.
 */
function num(defaultValue: number, options: NumberOptions = {}) {
  return z.preprocess(
    (raw) => {
      if (raw === undefined || raw === null || raw === '') return defaultValue;
      const text = String(raw).trim();
      const value = options.int ? Number.parseInt(text, 10) : Number(text);
      return value; // NaN reaches z.number(), which rejects it as invalid_type
    },
    z.number({ invalid_type_error: 'must be a number' }).superRefine((value, ctx) => {
      if (options.min !== undefined && value < options.min) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be >= ${options.min}` });
      }
      if (options.max !== undefined && value > options.max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be <= ${options.max}` });
      }
    })
  );
}

/** Integer variable with a default. */
const int = (defaultValue: number, options: NumberOptions = {}) =>
  num(defaultValue, { ...options, int: true });

/** Numeric variable without a default (may be left unset). */
function optionalNum(options: NumberOptions = {}) {
  return z.preprocess(
    (raw) => {
      if (raw === undefined || raw === null || raw === '') return undefined;
      const text = String(raw).trim();
      return options.int ? Number.parseInt(text, 10) : Number(text);
    },
    z
      .number({ invalid_type_error: 'must be a number' })
      .superRefine((value, ctx) => {
        if (options.min !== undefined && value < options.min) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be >= ${options.min}` });
        }
        if (options.max !== undefined && value > options.max) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be <= ${options.max}` });
        }
      })
      .optional()
  );
}

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

/** Boolean variable (`true/1/yes/on`, `false/0/no/off`, case-insensitive). */
function bool(defaultValue: boolean) {
  return z.preprocess(
    (raw) => {
      if (raw === undefined || raw === null || raw === '') return defaultValue;
      const text = String(raw).trim().toLowerCase();
      if (TRUE_VALUES.has(text)) return true;
      if (FALSE_VALUES.has(text)) return false;
      return Number.NaN; // z.boolean() rejects non-booleans
    },
    z.boolean({ invalid_type_error: 'must be a boolean (true/false)' })
  );
}

/** String variable where an empty value is treated as unset. */
const optionalString = z.preprocess(
  (raw) => (raw === '' || raw === null ? undefined : raw),
  z.string().optional()
);

/** Optional string that must look like an email address when present. */
const optionalEmail = z.preprocess(
  (raw) => (raw === '' || raw === null ? undefined : raw),
  z.string().email().optional()
);

/** Duration string like "15m", "7d", "3600s". */
const duration = (defaultValue: string) =>
  z
    .string()
    .regex(/^\d+[smhd]$/, `must be a duration like "${defaultValue}" (e.g. 30s, 15m, 7d)`)
    .default(defaultValue);

/**
 * The full application configuration. Every key consumed anywhere in `src/`
 * must appear here — grep for `config.` and `process.env.` when adding one,
 * and document it in `docs/CONFIGURATION.md` (a test enforces this).
 */
export const EnvSchemaObject = z.object({
  // ── Runtime ────────────────────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  PORT: int(3000, { min: 1, max: 65_535 }),
  HTTP2_ENABLED: bool(false),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  RESPONSE_CACHE_CONTROL: z.string().default('private, no-cache'),
  RESPONSE_COMPRESSION_ENABLED: bool(true),
  // Max time (ms) to wait for in-flight requests to drain on SIGTERM/SIGINT (#23).
  SHUTDOWN_TIMEOUT_MS: int(30_000, { min: 1_000, max: 300_000 }),
  // Swagger server host (e.g. api.example.com). Empty = localhost.
  API_HOST: optionalString,

  // ── Database ───────────────────────────────────────────────────────────
  DATABASE_URL: optionalString,
  DATABASE_READ_REPLICA_URLS: optionalString,
  DB_REPLICA_ENABLED: bool(false),
  DB_REPLICA_LAG_TOLERANCE_SECONDS: int(5, { min: 0, max: 300 }),
  DB_REPLICA_HEALTHCHECK_INTERVAL_MS: int(10_000, { min: 1_000, max: 600_000 }),
  DB_POOL_MIN: int(2, { min: 1, max: 100 }),
  DB_POOL_MAX: int(20, { min: 1, max: 100 }),
  DB_CONNECTION_TIMEOUT_MS: int(5_000, { min: 100, max: 60_000 }),
  DB_IDLE_TIMEOUT_MS: int(30_000, { min: 0, max: 300_000 }),
  DB_MAX_LIFETIME_MS: int(1_800_000, { min: 1_000, max: 3_600_000 }),
  DB_STATEMENT_TIMEOUT_MS: int(10_000, { min: 0, max: 600_000 }),
  DB_SLOW_QUERY_THRESHOLD_MS: int(200, { min: 1, max: 60_000 }),
  DB_LOG_QUERIES: bool(false),
  // Read-query result cache (1-5 minutes, per issue #12)
  DB_QUERY_CACHE_TTL_MS: int(60_000, { min: 1_000, max: 300_000 }),
  DB_QUERY_CACHE_MAX_TTL_MS: int(300_000, { min: 1_000, max: 600_000 }),
  DB_QUERY_CACHE_MAX_ENTRIES: int(1_000, { min: 10, max: 100_000 }),
  DB_QUERY_CACHE_ENABLED: bool(true),
  DB_LEAK_DETECTION_TIMEOUT_MS: int(30_000, { min: 1_000, max: 300_000 }),
  DB_CIRCUIT_BREAKER_FAILURES: int(5, { min: 1, max: 100 }),
  DB_CIRCUIT_BREAKER_RESET_MS: int(10_000, { min: 100, max: 600_000 }),

  // ── Circuit breakers (external services) ──────────────────────────────
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: num(0.5, { min: 0, max: 1 }),
  CIRCUIT_BREAKER_SUCCESS_THRESHOLD: int(2, { min: 1, max: 100 }),
  CIRCUIT_BREAKER_TIMEOUT_MS: int(60_000, { min: 100, max: 600_000 }),
  CIRCUIT_BREAKER_RESET_TIMEOUT_MS: int(30_000, { min: 100, max: 600_000 }),
  CIRCUIT_BREAKER_MIN_REQUESTS: int(5, { min: 1, max: 1_000 }),
  CIRCUIT_BREAKER_ROLLING_WINDOW_MS: int(60_000, { min: 1_000, max: 3_600_000 }),
  CIRCUIT_BREAKER_VOLUME_THRESHOLD: int(5, { min: 1, max: 1_000 }),
  STELLAR_CIRCUIT_BREAKER_ENABLED: bool(true),
  WEBHOOK_CIRCUIT_BREAKER_ENABLED: bool(true),

  // ── Redis ──────────────────────────────────────────────────────────────
  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_HOST: optionalString,
  REDIS_PORT: optionalNum({ min: 1, max: 65_535 }),
  REDIS_PASSWORD: optionalString,
  REDIS_DB: optionalNum({ min: 0, max: 15 }),
  REDIS_POOL_MIN: int(5, { min: 1, max: 100 }),
  REDIS_POOL_MAX: int(20, { min: 1, max: 200 }),
  REDIS_POOL_IDLE_TIMEOUT_MS: int(300_000, { min: 0, max: 3_600_000 }),
  REDIS_CONNECTION_TIMEOUT_MS: int(30_000, { min: 1_000, max: 120_000 }),
  REDIS_HEALTHCHECK_INTERVAL_MS: int(60_000, { min: 1_000, max: 600_000 }),
  // In-memory fallback cache used when Redis is unreachable.
  CACHE_FALLBACK_MEMORY_SIZE: int(1_000, { min: 1, max: 100_000 }),
  CACHE_WARMUP_ENABLED: bool(false),
  CACHE_METRICS_ENABLED: bool(false),
  // Legacy aliases retained for deployments that have not migrated yet.
  WARMUP_CACHE: bool(false),
  ENABLE_CACHE_METRICS: bool(false),

  // ── Background jobs ───────────────────────────────────────────────────
  // Opt-in: the API process stays light unless explicitly told to run workers.
  JOBS_WORKERS_ENABLED: bool(false),
  ENABLE_WORKERS: bool(false),
  JOBS_CONCURRENCY: int(5, { min: 1, max: 64 }),
  JOB_DEFAULT_ATTEMPTS: int(3, { min: 1, max: 20 }),
  JOB_BACKOFF_MS: int(1_000, { min: 1, max: 600_000 }),
  WORKER_CONCURRENCY: int(5, { min: 1, max: 64 }),

  // ── Auth / JWT ─────────────────────────────────────────────────────────
  JWT_SECRET: z.string().min(1).default('your-secret-key-change-in-production'),
  JWT_EXPIRES_IN: duration('15m'),
  JWT_REFRESH_EXPIRES_IN: duration('7d'),

  // ── Error tracking ─────────────────────────────────────────────────────
  SENTRY_DSN: optionalString,
  ERROR_TRACKING_ENABLED: bool(true),
  ERROR_TRACKING_SAMPLE_RATE: num(1, { min: 0, max: 1 }),
  ERROR_TRACKING_TIMEOUT_MS: int(5_000, { min: 100, max: 60_000 }),

  // ── Stellar / Soroban ──────────────────────────────────────────────────
  STELLAR_NETWORK: z.enum(['testnet', 'mainnet', 'standalone']).default('testnet'),
  STELLAR_HORIZON_URL: z.string().default('https://horizon-testnet.stellar.org'),
  STELLAR_HORIZON_TIMEOUT_MS: int(60_000, { min: 1_000, max: 600_000 }),
  STELLAR_SERVER_SECRET_KEY: optionalString,
  USDC_CONTRACT_ID: optionalString,
  USDC_ISSUER: optionalString,

  // ── External payments ──────────────────────────────────────────────────
  PAYMENTS_PROVIDER: z.enum(['stripe', 'none']).default('none'),
  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,
  STRIPE_API_BASE: z.string().default('https://api.stripe.com'),
  PAYMENTS_WEBHOOK_TOLERANCE_SECONDS: int(300, { min: 10, max: 86_400 }),

  // ── Domain limits ──────────────────────────────────────────────────────
  WALLET_NONCE_EXPIRY: int(600, { min: 1, max: 86_400 }),
  MIN_PAYOUT_AMOUNT: num(50, { min: 0, max: 1_000_000 }),

  // ── Email ──────────────────────────────────────────────────────────────
  FRONTEND_URL: z.string().default('http://localhost:3000'),
  VERIFICATION_DOCUMENT_STORAGE_PATH: z.string().default('./private/verification-documents'),
  SENDGRID_API_KEY: optionalString,
  EMAIL_FROM: optionalEmail,
  // ── Email ──────────────────────────────────────────────────────────────
  FRONTEND_URL: z.string().default('http://localhost:3000'),
  VERIFICATION_DOCUMENT_STORAGE_PATH: z.string().default('./private/verification-documents'),
  SENDGRID_API_KEY: optionalString,
  EMAIL_FROM: optionalEmail,

  // ── HTTP surface ───────────────────────────────────────────────────────
  RESPONSE_CACHE_CONTROL: z.string().default('private, no-cache'),
  // Reverse proxy trust: false | number of hops | comma separated CIDR list.
  TRUST_PROXY: z.string().default('false'),
  CORS_ORIGINS: optionalString,
  CORS_CREDENTIALS: bool(true),
  CORS_MAX_AGE: int(600, { min: 0, max: 86_400 }),

  // ── Rate limiting (see src/config/rate-limit.ts) ───────────────────────
  RATE_LIMIT_ENABLED: bool(true),
  RATE_LIMIT_STORE: z.enum(['memory', 'redis']).default('memory'),
  RATE_LIMIT_PUBLIC_MAX: int(100, { min: 1, max: 100_000 }),
  RATE_LIMIT_PUBLIC_WINDOW_MS: int(60_000, { min: 1_000, max: 3_600_000 }),
  RATE_LIMIT_AUTHENTICATED_MAX: int(300, { min: 1, max: 100_000 }),
  RATE_LIMIT_AUTHENTICATED_WINDOW_MS: int(60_000, { min: 1_000, max: 3_600_000 }),
  RATE_LIMIT_SENSITIVE_MAX: int(10, { min: 1, max: 1_000 }),
  RATE_LIMIT_SENSITIVE_WINDOW_MS: int(60_000, { min: 1_000, max: 3_600_000 }),

  // ── API versioning ─────────────────────────────────────────────────────
  SUPPORTED_API_VERSIONS: z.string().default('1,2'),
  API_V1_SUNSET_DATE: z.string().optional(),

  // ── GraphQL ────────────────────────────────────────────────────────────
  GRAPHQL_ENABLED: bool(true),
  GRAPHQL_MAX_DEPTH: int(10, { min: 1, max: 100 }),
  GRAPHQL_MAX_COMPLEXITY: int(1_000, { min: 1, max: 100_000 }),

  // ── Feature flags (see src/config/features.ts) ─────────────────────────
  // Defaults are environment-aware; src/config/features.ts resolves them and
  // the loader folds the resolved values over these keys after validation.
  FEATURE_EMAIL_VERIFICATION: bool(true),
  FEATURE_ANALYTICS: bool(true),
  FEATURE_WEBHOOKS: bool(true),
  FEATURE_EXPORTS: bool(true),
  FEATURE_MAINTENANCE_MODE: bool(false),
});

/**
 * Full schema including cross-field refinement — this is what the loader
 * parses. Use `EnvSchemaObject.shape` when the raw per-key shape is needed.
 */
export const EnvSchema = EnvSchemaObject.superRefine((config, ctx) => {
  // Cross-field checks the per-key rules cannot express.
  if (config.DB_POOL_MAX < config.DB_POOL_MIN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `DB_POOL_MAX (${config.DB_POOL_MAX}) must be >= DB_POOL_MIN (${config.DB_POOL_MIN})`,
      path: ['DB_POOL_MAX'],
    });
  }
  if (config.REDIS_POOL_MAX < config.REDIS_POOL_MIN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `REDIS_POOL_MAX (${config.REDIS_POOL_MAX}) must be >= REDIS_POOL_MIN (${config.REDIS_POOL_MIN})`,
      path: ['REDIS_POOL_MAX'],
    });
  }

  // Production and staging must never boot on incomplete or placeholder
  // configuration — fail fast here instead of at first request.
  if (config.NODE_ENV === 'production' || config.NODE_ENV === 'staging') {
    if (!config.DATABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DATABASE_URL is required when NODE_ENV=production/staging',
        path: ['DATABASE_URL'],
      });
    }
    if (!['verify-ca', 'verify-full'].includes(config.DB_SSL_MODE)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DB_SSL_MODE must be verify-ca or verify-full when NODE_ENV=production/staging',
        path: ['DB_SSL_MODE'],
      });
    }
    if (
      !config.JWT_SECRET ||
      config.JWT_SECRET === 'your-secret-key-change-in-production' ||
      config.JWT_SECRET.length < 32
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'JWT_SECRET must be a strong value (>= 32 characters, not the placeholder) when NODE_ENV=production/staging',
        path: ['JWT_SECRET'],
      });
    }
  }
});

/** The validated, typed application configuration. */
export type EnvConfig = z.infer<typeof EnvSchemaObject>;

/** Keys that hold credentials and must be redacted in logs/audit entries. */
export const SECRET_KEYS: ReadonlySet<string> = new Set([
  'JWT_SECRET',
  'INTERNAL_SERVICE_API_KEYS',
  'STELLAR_SERVER_SECRET_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'SENDGRID_API_KEY',
  'REDIS_PASSWORD',
  'SENTRY_DSN',
  'DATABASE_URL',
  'DB_SSL_CA',
  'DB_SSL_CERT',
  'DB_SSL_KEY',
  'BACKUP_ENCRYPTION_KEY',
]);

/** True when `key` holds a credential whose value must never be logged. */
export function isSecretKey(key: string): boolean {
  if (SECRET_KEYS.has(key)) return true;
  // Deployments commonly inject extra credentials as SECRET_* / *_PASSWORD /
  // *_PRIVATE_KEY; stay on the safe side for anything matching those shapes.
  return (
    /^(SECRET|PASSWORD|PRIVATE_KEY|TOKEN|API_KEY)_/.test(key) ||
    /_(PASSWORD|SECRET|PRIVATE_KEY|TOKEN)$/.test(key)
  );
}

/** Structured, printable issue list for a failed validation. */
export function formatConfigIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}
