import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).default('3000'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  // Max time (ms) to wait for in-flight requests to drain and resources to
  // close on SIGTERM/SIGINT before forcing exit (#23).
  SHUTDOWN_TIMEOUT_MS: z.string().transform(Number).default('30000'),
  DATABASE_URL: z.string().optional(),
  DB_POOL_MIN: z.string().transform(Number).default('2'),
  DB_POOL_MAX: z.string().transform(Number).default('20'),
  DB_CONNECTION_TIMEOUT_MS: z.string().transform(Number).default('5000'),
  DB_IDLE_TIMEOUT_MS: z.string().transform(Number).default('30000'),
  DB_MAX_LIFETIME_MS: z.string().transform(Number).default('1800000'),
  DB_STATEMENT_TIMEOUT_MS: z.string().transform(Number).default('10000'),
  DB_SLOW_QUERY_THRESHOLD_MS: z.string().transform(Number).default('200'),
  DB_LOG_QUERIES: z.string().transform((val) => val === 'true').default('false'),
  // Read-query result cache (1-5 minutes, per issue #12)
  DB_QUERY_CACHE_TTL_MS: z.string().transform(Number).default('60000'),
  DB_QUERY_CACHE_MAX_TTL_MS: z.string().transform(Number).default('300000'),
  DB_QUERY_CACHE_MAX_ENTRIES: z.string().transform(Number).default('1000'),
  DB_QUERY_CACHE_ENABLED: z.string().transform((val) => val !== 'false').default('true'),
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
  // Background job processing
  JOBS_WORKERS_ENABLED: z
    .string()
    .transform((val) => val === 'true')
    .default('false'),
  JOBS_CONCURRENCY: z.string().transform(Number).default('5'),
  JOB_DEFAULT_ATTEMPTS: z.string().transform(Number).default('3'),
  JOB_BACKOFF_MS: z.string().transform(Number).default('1000'),
  JWT_SECRET: z.string().default('your-secret-key-change-in-production'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  // Error tracking (Sentry compatible)
  SENTRY_DSN: z.string().optional(),
  ERROR_TRACKING_ENABLED: z
    .string()
    .transform((val) => val !== 'false')
    .default('true'),
  ERROR_TRACKING_SAMPLE_RATE: z
    .string()
    .transform(Number)
    .refine((val) => !Number.isNaN(val) && val >= 0 && val <= 1, {
      message: 'ERROR_TRACKING_SAMPLE_RATE must be between 0 and 1',
    })
    .default('1'),
  ERROR_TRACKING_TIMEOUT_MS: z.string().transform(Number).default('5000'),
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
  SENDGRID_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().email().optional(),
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
