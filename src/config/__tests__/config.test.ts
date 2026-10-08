import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import {
  loadConfig,
  reloadConfig,
  resetConfigCache,
  getConfig,
  getActiveEnvironment,
  ConfigValidationError,
  resolveSecrets,
} from '../loader';
import { EnvSchema, EnvSchemaObject, isSecretKey, formatConfigIssues } from '../schema';
import { resetConfigAuditLog, getConfigAuditLog, getReloadAuditLog } from '../audit';
import { isFeatureEnabled } from '../features';

/**
 * Loads run against a temp project root with `loadEnvFiles: false` unless a
 * test explicitly writes env files, so the suite is hermetic.
 */
const base = { loadEnvFiles: false } as const;

describe('config schema (issue #60)', () => {
  it('applies documented defaults to an empty environment', () => {
    const config = EnvSchema.parse({ NODE_ENV: 'development' });

    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.DB_POOL_MIN).toBe(2);
    expect(config.DB_POOL_MAX).toBe(20);
    expect(config.RATE_LIMIT_ENABLED).toBe(true);
    expect(config.STELLAR_NETWORK).toBe('testnet');
    expect(config.NODE_ENV).toBe('development');
  });

  it('enforces types: numbers are numbers, booleans are booleans', () => {
    const config = EnvSchema.parse({
      NODE_ENV: 'development',
      PORT: '8080',
      RATE_LIMIT_ENABLED: 'true',
      CIRCUIT_BREAKER_FAILURE_THRESHOLD: '0.75',
    });

    expect(config.PORT).toBe(8080);
    expect(typeof config.PORT).toBe('number');
    expect(config.RATE_LIMIT_ENABLED).toBe(true);
    expect(typeof config.RATE_LIMIT_ENABLED).toBe('boolean');
    expect(config.CIRCUIT_BREAKER_FAILURE_THRESHOLD).toBe(0.75);
  });

  it('accepts every documented boolean spelling', () => {
    for (const value of ['true', '1', 'yes', 'on', 'TRUE', 'Yes']) {
      expect(EnvSchema.parse({ RATE_LIMIT_ENABLED: value }).RATE_LIMIT_ENABLED).toBe(true);
    }
    for (const value of ['false', '0', 'no', 'off', 'FALSE', 'Off']) {
      expect(EnvSchema.parse({ RATE_LIMIT_ENABLED: value }).RATE_LIMIT_ENABLED).toBe(false);
    }
  });

  it('rejects invalid types with readable messages', () => {
    expect(EnvSchema.safeParse({ PORT: 'abc' }).success).toBe(false);
    expect(EnvSchema.safeParse({ RATE_LIMIT_ENABLED: 'maybe' }).success).toBe(false);
    expect(EnvSchema.safeParse({ JWT_EXPIRES_IN: 'soon' }).success).toBe(false);
    expect(EnvSchema.safeParse({ LOG_LEVEL: 'verbose' }).success).toBe(false);
    expect(EnvSchema.safeParse({ STELLAR_NETWORK: 'lunarnet' }).success).toBe(false);
  });

  it('rejects out-of-range values', () => {
    expect(EnvSchema.safeParse({ PORT: '99999' }).success).toBe(false); // > 65535
    expect(EnvSchema.safeParse({ PORT: '0' }).success).toBe(false);
    expect(EnvSchema.safeParse({ ERROR_TRACKING_SAMPLE_RATE: '1.5' }).success).toBe(false);
    expect(EnvSchema.safeParse({ CIRCUIT_BREAKER_FAILURE_THRESHOLD: '2' }).success).toBe(false);
    expect(EnvSchema.safeParse({ REDIS_DB: '16' }).success).toBe(false);
  });

  it('enforces cross-field rules (pool max >= min)', () => {
    const result = EnvSchema.safeParse({ DB_POOL_MIN: '50', DB_POOL_MAX: '10' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatConfigIssues(result.error).join(' ')).toContain('DB_POOL_MAX');
    }
  });

  it('treats empty strings as "use the default"', () => {
    const config = EnvSchema.parse({ PORT: '', RATE_LIMIT_ENABLED: '', SENDGRID_API_KEY: '' });
    expect(config.PORT).toBe(3000);
    expect(config.RATE_LIMIT_ENABLED).toBe(true);
    expect(config.SENDGRID_API_KEY).toBeUndefined();
  });
});

describe('production/staging guards', () => {
  it('fails when DATABASE_URL is missing in production', () => {
    const result = EnvSchema.safeParse({
      NODE_ENV: 'production',
      JWT_SECRET: 'a-very-strong-production-secret-0123456789',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatConfigIssues(result.error).join(' ')).toContain('DATABASE_URL');
    }
  });

  it('fails when JWT_SECRET is the placeholder or too short in production', () => {
    const placeholder = EnvSchema.safeParse({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://u:p@h/db',
    });
    expect(placeholder.success).toBe(false);

    const tooShort = EnvSchema.safeParse({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://u:p@h/db',
      JWT_SECRET: 'short',
    });
    expect(tooShort.success).toBe(false);
  });

  it('passes with strong secrets and DATABASE_URL in production', () => {
    const result = EnvSchema.safeParse({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://u:p@h/db',
      DB_SSL_MODE: 'verify-full',
      JWT_SECRET: 'a-very-strong-production-secret-0123456789',
    });
    expect(result.success).toBe(true);
  });

  it('requires certificate validation for production database connections', () => {
    const result = EnvSchema.safeParse({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://u:p@h/db',
      JWT_SECRET: 'a-very-strong-production-secret-0123456789',
      DB_SSL_MODE: 'require',
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(formatConfigIssues(result.error).join(' ')).toContain('DB_SSL_MODE');
  });
});

describe('config loader (issue #60)', () => {
  beforeEach(() => {
    resetConfigCache();
    resetConfigAuditLog();
  });

  it('loads defaults per environment', () => {
    const dev = loadConfig({ ...base, env: { NODE_ENV: 'development' } });
    expect(dev.NODE_ENV).toBe('development');
    expect(getActiveEnvironment()).toBe('development');

    resetConfigCache();
    const test = loadConfig({ ...base, env: { NODE_ENV: 'test', PORT: '3001' } });
    expect(test.NODE_ENV).toBe('test');
    expect(test.PORT).toBe(3001);
  });

  it('layers overrides: process env beats defaults', () => {
    const config = loadConfig({
      ...base,
      env: { NODE_ENV: 'development', RATE_LIMIT_PUBLIC_MAX: '500', LOG_LEVEL: 'debug' },
    });
    expect(config.RATE_LIMIT_PUBLIC_MAX).toBe(500);
    expect(config.LOG_LEVEL).toBe('debug');
  });

  it('reads the environment file matching NODE_ENV from the project root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    fs.writeFileSync(path.join(root, '.env.staging'), 'LOG_LEVEL=warn\nRATE_LIMIT_STORE=redis\n');

    const config = loadConfig({
      env: {
        NODE_ENV: 'staging',
        DATABASE_URL: 'postgres://u:p@h/db',
        DB_SSL_MODE: 'verify-full',
        JWT_SECRET: 'x'.repeat(40),
      },
      projectRoot: root,
    });

    expect(config.LOG_LEVEL).toBe('warn');
    expect(config.RATE_LIMIT_STORE).toBe('redis');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('gives real environment variables precedence over env files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    fs.writeFileSync(path.join(root, '.env.development'), 'LOG_LEVEL=debug\n');

    const config = loadConfig({
      env: { NODE_ENV: 'development', LOG_LEVEL: 'error' },
      projectRoot: root,
    });

    expect(config.LOG_LEVEL).toBe('error');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('collects ALL validation problems in one failure', () => {
    try {
      loadConfig({
        ...base,
        env: { NODE_ENV: 'development', PORT: 'not-a-number', RATE_LIMIT_PUBLIC_MAX: '0' },
      });
      expect.unreachable('expected ConfigValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const issues = (error as ConfigValidationError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(2);
      expect(issues.join('\n')).toContain('PORT');
      expect(issues.join('\n')).toContain('RATE_LIMIT_PUBLIC_MAX');
    }
  });

  it('fails fast with non-zero intent on invalid config (startup guard)', () => {
    // The boot path treats ConfigValidationError as fatal (src/index.ts loads
    // config at import time — the process exits before listen()).
    expect(() => loadConfig({ ...base, env: { NODE_ENV: 'development', PORT: '70000' } })).toThrow(
      ConfigValidationError
    );
  });

  it('aborts a real process boot with a non-zero exit code', async () => {
    // End-to-end: boot src/index.ts as production with a placeholder JWT and
    // no DATABASE_URL. Validation runs at import time, before the listener
    // opens, so the process must exit non-zero with a readable error.
    const tsxBin = path.resolve(__dirname, '../../../node_modules/.bin/tsx');
    const entry = path.resolve(__dirname, '../../../src/index.ts');

    await expect(
      execFileAsync(tsxBin, [entry], {
        env: {
          ...process.env,
          NODE_ENV: 'production',
          DATABASE_URL: 'postgres://ci:ci@localhost:5432/ci',
          JWT_SECRET: 'your-secret-key-change-in-production',
        },
      })
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('JWT_SECRET') });
  }, 30_000);

  it('memoizes the snapshot; getConfig returns the same object', () => {
    const first = getConfig({ ...base, env: { NODE_ENV: 'development' } });
    const second = getConfig();
    expect(second).toBe(first);
  });
});

describe('secret references ({{ SECRET_NAME }})', () => {
  beforeEach(() => {
    resetConfigCache();
  });

  it('resolves {{ REF }} from the secrets provider', () => {
    const config = loadConfig({
      ...base,
      env: { NODE_ENV: 'development', JWT_SECRET: '{{ PROVIDER_JWT }}' },
      secretsProvider: { PROVIDER_JWT: 'resolved-secret-value-0123456789' },
    });
    expect(config.JWT_SECRET).toBe('resolved-secret-value-0123456789');
  });

  it('resolves from process.env when no provider is injected', () => {
    process.env.PROC_SECRET_JWT = 'from-process-env-0123456789';
    try {
      const config = loadConfig({
        ...base,
        env: { NODE_ENV: 'development', JWT_SECRET: '{{ PROC_SECRET_JWT }}' },
      });
      expect(config.JWT_SECRET).toBe('from-process-env-0123456789');
    } finally {
      delete process.env.PROC_SECRET_JWT;
    }
  });

  it('fails fast when a secret reference cannot be resolved', () => {
    expect(() =>
      loadConfig({
        ...base,
        env: { NODE_ENV: 'development', JWT_SECRET: '{{ DEFINITELY_MISSING }}' },
      })
    ).toThrow(/DEFINITELY_MISSING/);
  });

  it('passes literal values through untouched', () => {
    const config = loadConfig({
      ...base,
      env: { NODE_ENV: 'development', JWT_SECRET: 'plain-literal-secret-0123456789' },
    });
    expect(config.JWT_SECRET).toBe('plain-literal-secret-0123456789');
  });

  it('resolves references in non-secret keys too, falling back to defaults when unresolved', () => {
    // Env files like .env.staging reference non-secret values (REDIS_URL).
    // Every reference resolves; an unresolved non-secret one is dropped so
    // the schema default applies instead of leaking {{ ... }} into consumers.
    const { resolved, unresolved } = resolveSecrets({
      FRONTEND_URL: '{{ APP_URL }}',
    });
    expect(resolved.FRONTEND_URL).toBeUndefined();
    expect(unresolved).toContain('FRONTEND_URL -> APP_URL');
  });
});

describe('feature flags', () => {
  beforeEach(() => {
    resetConfigCache();
    resetConfigAuditLog();
  });

  it('fold environment defaults into the snapshot', () => {
    const config = loadConfig({ ...base, env: { NODE_ENV: 'development' } });
    expect(config.FEATURE_ANALYTICS).toBe(true);
    expect(config.FEATURE_MAINTENANCE_MODE).toBe(false);
  });

  it('honor FEATURE_* environment overrides', () => {
    const config = loadConfig({
      ...base,
      env: { NODE_ENV: 'development', FEATURE_MAINTENANCE_MODE: 'true' },
    });
    expect(config.FEATURE_MAINTENANCE_MODE).toBe(true);
  });

  it('isFeatureEnabled reads the override and throws on unknown flags', () => {
    process.env.FEATURE_EXPORTS = 'false';
    try {
      expect(isFeatureEnabled('exports')).toBe(false);
      expect(() => isFeatureEnabled('notAFlag' as never)).toThrow(/Unknown feature flag/);
    } finally {
      delete process.env.FEATURE_EXPORTS;
    }
  });
});

describe('config audit log', () => {
  beforeEach(() => {
    resetConfigCache();
    resetConfigAuditLog();
  });

  it('records which keys came from which layer, redacting secrets', () => {
    loadConfig({
      ...base,
      env: {
        NODE_ENV: 'development',
        LOG_LEVEL: 'debug',
        JWT_SECRET: 'super-secret-value-0123456789',
      },
    });

    const log = getConfigAuditLog();
    const logLevel = log.find((entry) => entry.key === 'LOG_LEVEL');
    expect(logLevel?.source).toBe('process-env');
    expect(logLevel?.value).toBe('debug');

    const jwt = log.find((entry) => entry.key === 'JWT_SECRET');
    expect(jwt?.value).toBe('[REDACTED]');
  });

  it('redacts connection strings with passwords', () => {
    loadConfig({
      ...base,
      env: { NODE_ENV: 'development', DATABASE_URL: 'postgres://admin:hunter2@db:5432/app' },
    });
    const entry = getConfigAuditLog().find((e) => e.key === 'DATABASE_URL');
    expect(entry?.value).toBe('[REDACTED]');
  });

  it('records hot-reload outcomes', () => {
    loadConfig({ ...base, env: { NODE_ENV: 'development', LOG_LEVEL: 'debug' } });

    const reloaded = reloadConfig({ ...base, env: { NODE_ENV: 'development', LOG_LEVEL: 'warn' } });
    expect(reloaded.LOG_LEVEL).toBe('warn');

    const reloads = getReloadAuditLog();
    expect(reloads.some((r) => r.outcome === 'applied' && r.detail.includes('LOG_LEVEL'))).toBe(
      true
    );
  });

  it('keeps the previous snapshot when a hot reload is invalid', () => {
    loadConfig({ ...base, env: { NODE_ENV: 'development', LOG_LEVEL: 'debug' } });
    const before = getConfig();

    expect(() =>
      reloadConfig({ ...base, env: { NODE_ENV: 'development', LOG_LEVEL: 'bogus' } })
    ).toThrow(ConfigValidationError);

    expect(getConfig()).toBe(before);
    expect(getConfig().LOG_LEVEL).toBe('debug');
    expect(getReloadAuditLog().some((r) => r.outcome === 'rejected')).toBe(true);
  });
});

describe('documentation completeness', () => {
  it('documents every schema key in docs/CONFIGURATION.md', () => {
    const docs = fs.readFileSync(path.resolve(__dirname, '../../../docs/CONFIGURATION.md'), 'utf8');

    const keys = Object.keys(EnvSchemaObject.shape);
    const missing = keys.filter((key) => !docs.includes(`| \`${key}\``));
    expect(missing).toEqual([]);
  });

  it('documents every variable in .env.example', () => {
    const example = fs.readFileSync(path.resolve(__dirname, '../../../.env.example'), 'utf8');

    const keys = Object.keys(EnvSchemaObject.shape);
    const missing = keys.filter((key) => !example.includes(`${key}=`));
    expect(missing).toEqual([]);
  });
});

describe('secret key classification', () => {
  it('classifies known and shape-based secret keys', () => {
    expect(isSecretKey('JWT_SECRET')).toBe(true);
    expect(isSecretKey('DATABASE_URL')).toBe(true);
    expect(isSecretKey('SENDGRID_API_KEY')).toBe(true);
    expect(isSecretKey('STRIPE_SECRET_KEY')).toBe(true);
    expect(isSecretKey('REDIS_PASSWORD')).toBe(true);
    expect(isSecretKey('SOME_SERVICE_PASSWORD')).toBe(true);
    expect(isSecretKey('SECRET_TOKEN_VALUE')).toBe(true);
    expect(isSecretKey('LOG_LEVEL')).toBe(false);
    expect(isSecretKey('PORT')).toBe(false);
  });
});
