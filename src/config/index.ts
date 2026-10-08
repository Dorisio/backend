/**
 * Public configuration entry point (issue #60).
 *
 * ```ts
 * import { config } from '../config';          // validated snapshot
 * import { reloadConfig } from '../config';    // hot reload
 * import { isFeatureEnabled } from '../config';// feature flags
 * ```
 */
import { getConfig, type LoadConfigOptions } from './loader';
import type { EnvConfig } from './schema';

export { config } from './env';
export {
  loadConfig,
  reloadConfig,
  getConfig,
  resetConfigCache,
  getActiveEnvironment,
  resolveSecrets,
  ConfigValidationError,
} from './loader';
export type { LoadConfigOptions } from './loader';
export { EnvSchema, isSecretKey, formatConfigIssues, SECRET_KEYS } from './schema';
export type { EnvConfig, ConfigEnvironment } from './schema';
export {
  isFeatureEnabled,
  resolveFeatureFlag,
  resolveFeatureFlags,
  FEATURE_DEFAULTS,
  FEATURE_FLAG_ENV_VARS,
} from './features';
export type { FeatureFlag } from './features';
export {
  FeatureFlagService,
  FeatureEvaluationMetrics,
  InMemoryFeatureFlagStore,
  createFeatureFlagSnapshot,
  evaluateFeatureFlag,
  featureContextFromRequest,
  featureEvaluationMetrics,
  featureFlagMiddleware,
  featureRoute,
  isFeatureEnabledFor,
  legacyFeatureFlagSnapshot,
  requireFeature,
  stablePercentageBucket,
  syncFeatureFlagSnapshot,
} from './feature-flags';
export type {
  FeatureEvaluation,
  FeatureEvaluationContext,
  FeatureEvaluationMetricSnapshot,
  FeatureEvaluationReason,
  FeatureFlagDefinition,
  FeatureFlagDefinitions,
  FeatureFlagLogger,
  FeatureFlagSnapshot,
  FeatureFlagSnapshotSource,
  FeatureFlagSnapshotStore,
  RequireFeatureOptions,
} from './feature-flags';
export {
  getConfigAuditLog,
  getReloadAuditLog,
  resetConfigAuditLog,
  redactValue,
  type ConfigAuditEntry,
  type ReloadAuditEntry,
  type ConfigAuditSource,
} from './audit';

/** Lazily-loaded validated snapshot (see `loader.getConfig`). */
export function getValidatedConfig(options?: LoadConfigOptions): EnvConfig {
  return getConfig(options);
}
