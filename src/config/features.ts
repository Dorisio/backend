/**
 * Feature flags (issue #60).
 *
 * Flags are declared once, here, with a typed name and a per-environment
 * default. Each flag can be overridden per environment with a `FEATURE_*`
 * environment variable, and participates in the layered config + hot reload
 * like any other key.
 *
 * Route code reads flags through `isFeatureEnabled()` — never through raw
 * `process.env.FEATURE_X === 'true'` checks — so flag names stay greppable
 * and defaults stay declared in one place.
 */
import type { ConfigEnvironment } from './schema';

/** Typed flag names used by `isFeatureEnabled()`. */
export type FeatureFlag =
  | 'emailVerification'
  | 'analytics'
  | 'webhooks'
  | 'exports'
  | 'maintenanceMode';

/** Environment variable that overrides each flag. */
export const FEATURE_FLAG_ENV_VARS: Record<FeatureFlag, string> = {
  emailVerification: 'FEATURE_EMAIL_VERIFICATION',
  analytics: 'FEATURE_ANALYTICS',
  webhooks: 'FEATURE_WEBHOOKS',
  exports: 'FEATURE_EXPORTS',
  maintenanceMode: 'FEATURE_MAINTENANCE_MODE',
};

/** Per-environment defaults, applied when no override is present. */
export const FEATURE_DEFAULTS: Record<FeatureFlag, Record<ConfigEnvironment | 'default', boolean>> = {
  emailVerification: { default: true, development: true, staging: true, production: true, test: true },
  analytics: { default: true, development: true, staging: true, production: true, test: true },
  webhooks: { default: true, development: true, staging: true, production: true, test: true },
  exports: { default: true, development: true, staging: true, production: true, test: true },
  maintenanceMode: { default: false, development: false, staging: false, production: false, test: false },
};

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

function parseBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const text = String(raw).trim().toLowerCase();
  if (TRUE_VALUES.has(text)) return true;
  if (FALSE_VALUES.has(text)) return false;
  return undefined;
}

/**
 * Resolves one flag: explicit `FEATURE_*` override wins, then the
 * per-environment default, then the global default.
 */
export function resolveFeatureFlag(
  flag: FeatureFlag,
  environment: ConfigEnvironment,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): boolean {
  const override = parseBoolean(env[FEATURE_FLAG_ENV_VARS[flag]]);
  if (override !== undefined) return override;

  const defaults = FEATURE_DEFAULTS[flag];
  return defaults[environment] ?? defaults.default;
}

/**
 * Resolves every flag for the given environment. Used by the loader to fold
 * flags into the validated snapshot's `FEATURE_*` keys.
 */
export function resolveFeatureFlags(
  environment: ConfigEnvironment,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): Record<FeatureFlag, boolean> {
  return {
    emailVerification: resolveFeatureFlag('emailVerification', environment, env),
    analytics: resolveFeatureFlag('analytics', environment, env),
    webhooks: resolveFeatureFlag('webhooks', environment, env),
    exports: resolveFeatureFlag('exports', environment, env),
    maintenanceMode: resolveFeatureFlag('maintenanceMode', environment, env),
  };
}

/**
 * True when `flag` is enabled for the active environment. Throws for unknown
 * flag names — a typo must fail loudly, not silently return `false`.
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  if (!(flag in FEATURE_FLAG_ENV_VARS)) {
    throw new Error(`Unknown feature flag: ${String(flag)}`);
  }
  const envVar = FEATURE_FLAG_ENV_VARS[flag];
  const raw = process.env[envVar];
  const override = parseBoolean(raw);
  if (override !== undefined) return override;
  return resolveFeatureFlag(flag, (process.env.NODE_ENV as ConfigEnvironment) ?? 'development');
}
