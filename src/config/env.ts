import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).default('3000'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DATABASE_URL: z.string().optional(),
  DB_POOL_MIN: z.string().transform(Number).default('2'),
  DB_POOL_MAX: z.string().transform(Number).default('20'),
  DB_CONNECTION_TIMEOUT_MS: z.string().transform(Number).default('5000'),
  DB_IDLE_TIMEOUT_MS: z.string().transform(Number).default('30000'),
  DB_MAX_LIFETIME_MS: z.string().transform(Number).default('1800000'),
  DB_STATEMENT_TIMEOUT_MS: z.string().transform(Number).default('10000'),
  DB_SLOW_QUERY_THRESHOLD_MS: z.string().transform(Number).default('200'),
  DB_LOG_QUERIES: z.string().transform((val) => val === 'true').default('false'),
  DB_LEAK_DETECTION_TIMEOUT_MS: z.string().transform(Number).default('30000'),
  DB_CIRCUIT_BREAKER_FAILURES: z.string().transform(Number).default('5'),
  DB_CIRCUIT_BREAKER_RESET_MS: z.string().transform(Number).default('10000'),
  // External services circuit breaker (Stellar Horizon, webhooks, etc.)
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: z.string().transform(Number).default('0.5'),
  CIRCUIT_BREAKER_SUCCESS_THRESHOLD: z.string().transform(Number).default('2'),
  CIRCUIT_BREAKER_TIMEOUT_MS: z.string().transform(Number).default('60000'),
  CIRCUIT_BREAKER_RESET_TIMEOUT_MS: z.string().transform(Number).default('30000'),
  CIRCUIT_BREAKER_MIN_REQUESTS: z.string().transform(Number).default('5'),
  CIRCUIT_BREAKER_ROLLING_WINDOW_MS: z.string().transform(Number).default('60000'),
  CIRCUIT_BREAKER_VOLUME_THRESHOLD: z.string().transform(Number).default('5'),
  STELLAR_CIRCUIT_BREAKER_ENABLED: z
    .string()
    .transform((val) => val === 'true')
    .default('true'),
  WEBHOOK_CIRCUIT_BREAKER_ENABLED: z
    .string()
    .transform((val) => val === 'true')
    .default('true'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_HOST: z.string().optional(),
  REDIS_PORT: z.string().transform(Number).optional(),
  REDIS_POOL_MIN: z.string().transform(Number).default('5'),
  REDIS_POOL_MAX: z.string().transform(Number).default('20'),
  REDIS_POOL_IDLE_TIMEOUT_MS: z.string().transform(Number).default(String(5 * 60 * 1000)),
  REDIS_CONNECTION_TIMEOUT_MS: z.string().transform(Number).default(String(30 * 1000)),
  REDIS_HEALTHCHECK_INTERVAL_MS: z.string().transform(Number).default(String(60 * 1000)),
  CACHE_FALLBACK_MEMORY_SIZE: z.string().transform(Number).default('1000'),
  JWT_SECRET: z.string().default('your-secret-key-change-in-production'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  STELLAR_NETWORK: z.enum(['testnet', 'mainnet', 'standalone']).default('testnet'),
  STELLAR_HORIZON_URL: z.string().default('https://horizon-testnet.stellar.org'),
  STELLAR_HORIZON_TIMEOUT_MS: z.string().transform(Number).default('60000'),
  STELLAR_SERVER_SECRET_KEY: z.string().optional(),
  USDC_CONTRACT_ID: z.string().optional(),
  USDC_ISSUER: z.string().optional(),
  // External payment processing
  PAYMENTS_PROVIDER: z.enum(['stripe', 'none']).default('none'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_API_BASE: z.string().default('https://api.stripe.com'),
  PAYMENTS_WEBHOOK_TOLERANCE_SECONDS: z.string().transform(Number).default('300'),
  WALLET_NONCE_EXPIRY: z.string().transform(Number).default('600'),
  // Issue #28 — CORS
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:5173'),
  CORS_CREDENTIALS: z.string().transform((v) => v !== 'false').default('true'),
  CORS_MAX_AGE: z.string().transform(Number).default('86400'),
  // Issue #27 — workers / jobs
  WORKER_CONCURRENCY: z.string().transform(Number).default('10'),
  ENABLE_WORKERS: z.string().transform((v) => v === 'true').default('false'),
  // Issue #30 — GraphQL
  GRAPHQL_ENABLED: z.string().transform((v) => v !== 'false').default('true'),
  GRAPHQL_MAX_DEPTH: z.string().transform(Number).default('5'),
  GRAPHQL_MAX_COMPLEXITY: z.string().transform(Number).default('100'),
});

type Environment = z.infer<typeof EnvSchema>;

const validateEnv = (): Environment => {
  const env = EnvSchema.safeParse(process.env);

  if (!env.success) {
    console.error('Invalid environment variables:', env.error.format());
    process.exit(1);
  }

  return env.data;
};

export const config = validateEnv();

/** Parsed CORS allow-list. Use `*` via CORS_ORIGINS=* for open (dev only). */
export function getCorsOrigins(): boolean | string[] {
  const raw = config.CORS_ORIGINS.trim();
  if (raw === '*') return true;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}
