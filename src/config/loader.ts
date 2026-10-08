/**
 * Configuration loader (issue #60).
 *
 * Layers (lowest → highest precedence):
 *   1. Schema defaults (`src/config/schema.ts`)
 *   2. Environment file for NODE_ENV (`.env.development` / `.env.staging` /
 *      `.env.production` / `.env.test`)
 *   3. `.env` and `.env.local` (developer-machine overrides, git-ignored)
 *   4. Real process environment (orchestrator/CI — always wins)
 *
 * Between layering and validation, `{{ SECRET_NAME }}` references in secret
 * keys are resolved from the process environment (or an injected provider
 * map). An unresolved secret reference is a startup failure, never a literal
 * `{{ ... }}` string reaching the application.
 *
 * Validation runs on every load and reload: a `ConfigValidationError` lists
 * *all* problems at once so a misconfigured deployment can be fixed in one
 * round trip. Hot reloads are atomic — an invalid candidate leaves the
 * previous snapshot untouched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { EnvSchema, formatConfigIssues, isSecretKey, type ConfigEnvironment, type EnvConfig } from './schema';
import { resolveFeatureFlags } from './features';
import { recordConfigAudit, recordReloadAudit } from './audit';

export class ConfigValidationError extends Error {
  /** Every validation problem, formatted `KEY: message`. */
  public readonly issues: string[];
  /** The NODE_ENV the failed load ran under. */
  public readonly environment: string;

  constructor(issues: string[], environment: string) {
    super(
      `Invalid configuration (NODE_ENV=${environment}):\n` +
        issues.map((issue) => `  - ${issue}`).join('\n')
    );
    this.name = 'ConfigValidationError';
    this.issues = issues;
    this.environment = environment;
  }
}

export interface LoadConfigOptions {
  /**
   * Project root that environment files are resolved against. Defaults to the
   * repository root discovered from this module's location.
   */
  projectRoot?: string;
  /**
   * Source for `{{ SECRET_NAME }}` references. Defaults to the process
   * environment. Tests (and Vault/SOPS adapters) can inject their own map.
   */
  secretsProvider?: Record<string, string | undefined>;
  /**
   * Extra variables treated as the top layer — highest precedence. Used by
   * tests; production loads read the real `process.env`.
   */
  env?: Record<string, string | undefined>;
  /** When false, environment files are skipped (tests, inline embeddings). */
  loadEnvFiles?: boolean;
}

const ENV_FILE_BY_ENV: Record<ConfigEnvironment, string> = {
  development: '.env.development',
  staging: '.env.staging',
  production: '.env.production',
  test: '.env.test',
};

/** Repo root, derived from this module's location (works under ESM and tsx). */
function defaultProjectRoot(): string {
  // src/config/loader.ts → repo root is two levels up.
  return fileURLToPath(new URL('../../', import.meta.url));
}

function readDotEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const parsed = dotenv.parse(fs.readFileSync(filePath));
  return parsed as Record<string, string>;
}

/**
 * Layered variable table: defaults < per-NODE_ENV file < `.env`/`.env.local`
 * < caller-supplied `env` (normally `process.env`). Also returns which layer
 * supplied each key, for the audit log.
 */
function buildLayeredEnv(
  options: LoadConfigOptions,
  environment: ConfigEnvironment
): { layered: Record<string, string | undefined>; sources: Record<string, 'env-file' | 'process-env'> } {
  const projectRoot = options.projectRoot ?? defaultProjectRoot();
  const layered: Record<string, string | undefined> = {};
  const sources: Record<string, 'env-file' | 'process-env'> = {};

  if (options.loadEnvFiles !== false) {
    // 2. Environment file for the active NODE_ENV.
    for (const [key, value] of Object.entries(readDotEnvFile(path.join(projectRoot, ENV_FILE_BY_ENV[environment])))) {
      layered[key] = value;
      sources[key] = 'env-file';
    }
    // 3. Developer-machine overrides (git-ignored). `.env.local` wins.
    for (const file of ['.env', '.env.local']) {
      for (const [key, value] of Object.entries(readDotEnvFile(path.join(projectRoot, file)))) {
        layered[key] = value;
        sources[key] = 'env-file';
      }
    }
  }

  // 4. Explicit env — normally the real process environment — always wins.
  for (const [key, value] of Object.entries(options.env ?? process.env)) {
    layered[key] = value;
    sources[key] = 'process-env';
  }

  return { layered, sources };
}

const SECRET_REFERENCE = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

/**
 * Resolves `{{ SECRET_NAME }}` references. Every key may use a reference (env
 * files like `.env.staging` reference REDIS_URL too); the difference is that
 * an **unresolved** reference is a startup failure for secret keys, while for
 * non-secret keys it is dropped so the schema default applies — a non-secret
 * reference in a committed file must never leak `{{ ... }}` into modules that
 * parse values eagerly (e.g. ioredis URL parsing).
 */
export function resolveSecrets(
  values: Record<string, string | undefined>,
  secretsProvider: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): { resolved: Record<string, string | undefined>; unresolved: string[] } {
  const resolved: Record<string, string | undefined> = {};
  const unresolved: string[] = [];

  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string') {
      resolved[key] = value;
      continue;
    }

    const match = SECRET_REFERENCE.exec(value.trim());
    if (!match) {
      resolved[key] = value;
      continue;
    }

    const secretName = match[1];
    const secretValue = secretsProvider[secretName];
    if (secretValue === undefined || secretValue === '') {
      unresolved.push(`${key} -> ${secretName}`);
      // Drop in every case: for secret keys this is reported as a failure;
      // for non-secret keys the schema default takes over.
      resolved[key] = undefined;
    } else {
      resolved[key] = secretValue;
    }
  }

  return { resolved, unresolved };
}

/** The current validated snapshot. Set by `loadConfig()` / `reloadConfig()`. */
let currentConfig: EnvConfig | undefined;
let currentEnvironment: ConfigEnvironment = 'development';

/**
 * Validates the layered environment. Throws `ConfigValidationError` listing
 * every issue when anything is missing, mistyped, out of range, or when a
 * secret reference cannot be resolved.
 */
function validate(
  layered: Record<string, string | undefined>,
  environment: ConfigEnvironment,
  options: LoadConfigOptions,
  _sources: Record<string, 'env-file' | 'process-env'> = {}
): EnvConfig {
  const { resolved, unresolved } = resolveSecrets(layered, options.secretsProvider);

  // Unresolved references for secret keys are fatal; the loader re-checks the
  // fatal subset below (non-secret unresolved references fall back to
  // defaults silently).
  const fatalUnresolved = unresolved.filter((reference) =>
    isSecretKey(reference.split(' -> ')[0])
  );

  const issues: string[] = fatalUnresolved.map(
    (reference) => `${reference}: secret reference could not be resolved`
  );

  const parsed = EnvSchema.safeParse(resolved);
  if (!parsed.success) {
    issues.push(...formatConfigIssues(parsed.error));
  }

  if (issues.length > 0) {
    throw new ConfigValidationError(issues, environment);
  }

  // Feature flags: resolve environment-aware defaults with FEATURE_* overrides
  // and fold them over the schema keys so `config.FEATURE_*` is always the
  // effective value (schema booleans are plain defaults).
  const flags = resolveFeatureFlags(environment, layered);
  return {
    ...parsed.data!,
    FEATURE_EMAIL_VERIFICATION: flags.emailVerification,
    FEATURE_ANALYTICS: flags.analytics,
    FEATURE_WEBHOOKS: flags.webhooks,
    FEATURE_EXPORTS: flags.exports,
    FEATURE_MAINTENANCE_MODE: flags.maintenanceMode,
  };
}

/**
 * Loads, validates and returns the configuration snapshot. Idempotent:
 * subsequent calls return the already-loaded snapshot unless the environment
 * changed.
 */
export function loadConfig(options: LoadConfigOptions = {}): EnvConfig {
  const envSource = options.env ?? (process.env as Record<string, string | undefined>);
  const requested = envSource.NODE_ENV as ConfigEnvironment | undefined;
  const environment: ConfigEnvironment =
    requested === 'staging' || requested === 'production' || requested === 'test' ? requested : 'development';

  const { layered, sources } = buildLayeredEnv(options, environment);
  const config = validate(layered, environment, options, sources);

  currentConfig = config;
  currentEnvironment = environment;

  recordConfigAudit(config, environment, layered, sources);
  return config;
}

/**
 * Re-runs the full load + validation and atomically swaps the snapshot.
 * Throws `ConfigValidationError` without touching the current snapshot when
 * the new layering is invalid.
 */
export function reloadConfig(options: LoadConfigOptions = {}): EnvConfig {
  const previous = currentConfig;
  const envSource = options.env ?? (process.env as Record<string, string | undefined>);
  const requested = envSource.NODE_ENV as ConfigEnvironment | undefined;
  const environment: ConfigEnvironment =
    requested === 'staging' || requested === 'production' || requested === 'test' ? requested : currentEnvironment;

  const { layered, sources } = buildLayeredEnv(options, environment);

  let candidate: EnvConfig;
  try {
    candidate = validate(layered, environment, options, sources);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      recordReloadAudit(environment, false, error.issues);
    }
    throw error;
  }

  const changedKeys =
    previous === undefined
      ? undefined
      : Object.keys(candidate).filter(
          (key) =>
            (previous as Record<string, unknown>)[key] !== (candidate as Record<string, unknown>)[key]
        );

  currentConfig = candidate;
  currentEnvironment = environment;
  recordConfigAudit(candidate, environment, layered, sources, true);
  recordReloadAudit(environment, true, changedKeys);
  return candidate;
}

/** The current validated snapshot; loads it on first access. */
export function getConfig(options: LoadConfigOptions = {}): EnvConfig {
  return currentConfig ?? loadConfig(options);
}

/** Test helper: forget the loaded snapshot so the next access reloads. */
export function resetConfigCache(): void {
  currentConfig = undefined;
  currentEnvironment = 'development';
}

/** The NODE_ENV the current snapshot was loaded under. */
export function getActiveEnvironment(): ConfigEnvironment {
  return currentEnvironment;
}
