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
  DB_SLOW_QUERY_THRESHOLD_MS: z.string().transform(Number).default('100'),
  DB_LOG_QUERIES: z.string().transform((val) => val === 'true').default('false'),
  DB_LEAK_DETECTION_TIMEOUT_MS: z.string().transform(Number).default('30000'),
  DB_CIRCUIT_BREAKER_FAILURES: z.string().transform(Number).default('5'),
  DB_CIRCUIT_BREAKER_RESET_MS: z.string().transform(Number).default('10000'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_HOST: z.string().optional(),
  REDIS_PORT: z.string().transform(Number).optional(),
  JWT_SECRET: z.string().default('your-secret-key-change-in-production'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  STELLAR_NETWORK: z.enum(['testnet', 'mainnet', 'standalone']).default('testnet'),
  STELLAR_HORIZON_URL: z.string().default('https://horizon-testnet.stellar.org'),
  STELLAR_SERVER_SECRET_KEY: z.string().optional(),
  USDC_CONTRACT_ID: z.string().optional(),
  USDC_ISSUER: z.string().optional(),
  WALLET_NONCE_EXPIRY: z.string().transform(Number).default('600'),
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
