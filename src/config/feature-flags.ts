import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ForbiddenError } from '../utils/errors';
import { resolveFeatureFlags, type FeatureFlag } from './features';
import type { ConfigEnvironment } from './schema';

/** The identity and role data used by targeting rules. Values are never logged. */
export interface FeatureEvaluationContext {
  userId?: string;
  role?: string;
  roles?: readonly string[];
}

export interface FeatureFlagTargets {
  users?: readonly string[];
  roles?: readonly string[];
}

/**
 * A flag rule. `enabled: false` is an immediate kill switch and always wins.
 * `allow`/`deny` are evaluated before the boolean and percentage fallback.
 */
export interface FeatureFlagDefinition {
  enabled?: boolean;
  /** Percentage in the inclusive range 0..100. Assignment is stable per user. */
  percentage?: number;
  /** Alias accepted for configuration files that call this a rollout. */
  rolloutPercentage?: number;
  allow?: FeatureFlagTargets;
  deny?: FeatureFlagTargets;
  /** Shorthand aliases for allow/deny users and roles. */
  allowUsers?: readonly string[];
  denyUsers?: readonly string[];
  allowRoles?: readonly string[];
  denyRoles?: readonly string[];
}

export type FeatureFlagDefinitions<Flag extends string = string> = Partial<
  Record<Flag, FeatureFlagDefinition>
>;

export interface FeatureFlagSnapshot<Flag extends string = string> {
  version: string;
  updatedAt: string;
  flags: FeatureFlagDefinitions<Flag>;
}

export interface FeatureFlagSnapshotStore<Flag extends string = string> {
  getSnapshot(): FeatureFlagSnapshot<Flag>;
  replace(snapshot: FeatureFlagSnapshot<Flag>): void;
}

const EMPTY_SNAPSHOT: FeatureFlagSnapshot = {
  version: 'empty',
  updatedAt: new Date(0).toISOString(),
  flags: {},
};

function cloneDefinition(definition: FeatureFlagDefinition): FeatureFlagDefinition {
  return {
    ...definition,
    allow: definition.allow
      ? {
          users: definition.allow.users ? [...definition.allow.users] : undefined,
          roles: definition.allow.roles ? [...definition.allow.roles] : undefined,
        }
      : undefined,
    deny: definition.deny
      ? {
          users: definition.deny.users ? [...definition.deny.users] : undefined,
          roles: definition.deny.roles ? [...definition.deny.roles] : undefined,
        }
      : undefined,
    allowUsers: definition.allowUsers ? [...definition.allowUsers] : undefined,
    denyUsers: definition.denyUsers ? [...definition.denyUsers] : undefined,
    allowRoles: definition.allowRoles ? [...definition.allowRoles] : undefined,
    denyRoles: definition.denyRoles ? [...definition.denyRoles] : undefined,
  };
}

function cloneSnapshot<Flag extends string>(
  snapshot: FeatureFlagSnapshot<Flag>
): FeatureFlagSnapshot<Flag> {
  return {
    version: snapshot.version,
    updatedAt: snapshot.updatedAt,
    flags: Object.fromEntries(
      Object.entries(snapshot.flags).map(([flag, definition]) => [
        flag,
        cloneDefinition(definition as FeatureFlagDefinition),
      ])
    ) as FeatureFlagDefinitions<Flag>,
  };
}

export function createFeatureFlagSnapshot<Flag extends string>(
  flags: FeatureFlagDefinitions<Flag>,
  version = new Date().toISOString(),
  updatedAt = new Date().toISOString()
): FeatureFlagSnapshot<Flag> {
  return cloneSnapshot({ version, updatedAt, flags });
}

/** Atomic, bounded-in-process snapshot. It can be replaced by a Redis adapter. */
export class InMemoryFeatureFlagStore<
  Flag extends string = string,
> implements FeatureFlagSnapshotStore<Flag> {
  private snapshot: FeatureFlagSnapshot<Flag>;

  constructor(snapshot: FeatureFlagSnapshot<Flag> = EMPTY_SNAPSHOT as FeatureFlagSnapshot<Flag>) {
    this.snapshot = cloneSnapshot(snapshot);
  }

  getSnapshot(): FeatureFlagSnapshot<Flag> {
    return cloneSnapshot(this.snapshot);
  }

  replace(snapshot: FeatureFlagSnapshot<Flag>): void {
    this.snapshot = cloneSnapshot(snapshot);
  }
}

/** A source suitable for polling/pub-sub synchronization (for example Redis). */
export interface FeatureFlagSnapshotSource<Flag extends string = string> {
  read(): Promise<FeatureFlagSnapshot<Flag> | null>;
}

export async function syncFeatureFlagSnapshot<Flag extends string>(
  store: FeatureFlagSnapshotStore<Flag>,
  source: FeatureFlagSnapshotSource<Flag>
): Promise<boolean> {
  const snapshot = await source.read();
  if (!snapshot) return false;
  store.replace(snapshot);
  return true;
}

export type FeatureEvaluationReason =
  | 'disabled'
  | 'deny_user'
  | 'deny_role'
  | 'allow_user'
  | 'allow_role'
  | 'boolean'
  | 'percentage'
  | 'missing_context'
  | 'default';

export interface FeatureEvaluation {
  flag: string;
  enabled: boolean;
  reason: FeatureEvaluationReason;
  /** The anonymous bucket is useful for diagnostics and contains no identifier. */
  bucket?: number;
  snapshotVersion: string;
}

export interface FeatureEvaluationMetricSnapshot {
  total: number;
  enabled: number;
  disabled: number;
  byFlag: Record<string, { evaluations: number; enabled: number; disabled: number }>;
  byReason: Record<FeatureEvaluationReason, number>;
}

/** Low-cardinality metrics store; it deliberately does not retain user IDs. */
export class FeatureEvaluationMetrics {
  private total = 0;
  private enabled = 0;
  private disabled = 0;
  private readonly byFlag = new Map<
    string,
    { evaluations: number; enabled: number; disabled: number }
  >();
  private readonly byReason = new Map<FeatureEvaluationReason, number>();

  record(evaluation: Pick<FeatureEvaluation, 'flag' | 'enabled' | 'reason'>): void {
    this.total += 1;
    if (evaluation.enabled) this.enabled += 1;
    else this.disabled += 1;
    const flag = this.byFlag.get(evaluation.flag) ?? { evaluations: 0, enabled: 0, disabled: 0 };
    flag.evaluations += 1;
    if (evaluation.enabled) flag.enabled += 1;
    else flag.disabled += 1;
    this.byFlag.set(evaluation.flag, flag);
    this.byReason.set(evaluation.reason, (this.byReason.get(evaluation.reason) ?? 0) + 1);
  }

  snapshot(): FeatureEvaluationMetricSnapshot {
    const byReason = {} as Record<FeatureEvaluationReason, number>;
    for (const reason of [
      'disabled',
      'deny_user',
      'deny_role',
      'allow_user',
      'allow_role',
      'boolean',
      'percentage',
      'missing_context',
      'default',
    ] as FeatureEvaluationReason[]) {
      byReason[reason] = this.byReason.get(reason) ?? 0;
    }
    return {
      total: this.total,
      enabled: this.enabled,
      disabled: this.disabled,
      byFlag: Object.fromEntries([...this.byFlag].map(([key, value]) => [key, { ...value }])),
      byReason,
    };
  }

  reset(): void {
    this.total = 0;
    this.enabled = 0;
    this.disabled = 0;
    this.byFlag.clear();
    this.byReason.clear();
  }
}

export interface FeatureFlagLogger {
  debug?(
    fields: { flag: string; enabled: boolean; reason: FeatureEvaluationReason },
    message: string
  ): void;
}

const noopLogger: FeatureFlagLogger = {};
export const featureEvaluationMetrics = new FeatureEvaluationMetrics();

/** Stable, platform-independent bucket in [0, 100). */
export function stablePercentageBucket(
  flag: string,
  userId: string,
  salt = 'dorisio-feature-flags-v1'
): number {
  const digest = createHash('sha256').update(`${salt}:${flag}:${userId}`).digest();
  const value = digest.readUInt32BE(0) / 0x1_0000_0000;
  return value * 100;
}

function listHas(list: readonly string[] | undefined, value: string | undefined): boolean {
  return Boolean(value && list?.some((candidate) => candidate === value));
}

function rolesFor(context: FeatureEvaluationContext): readonly string[] {
  return [...new Set([...(context.roles ?? []), ...(context.role ? [context.role] : [])])];
}

function normalizeTargets(
  definition: FeatureFlagDefinition,
  side: 'allow' | 'deny'
): FeatureFlagTargets {
  const nested = definition[side] ?? {};
  return {
    users: [
      ...(nested.users ?? []),
      ...(side === 'allow' ? (definition.allowUsers ?? []) : (definition.denyUsers ?? [])),
    ],
    roles: [
      ...(nested.roles ?? []),
      ...(side === 'allow' ? (definition.allowRoles ?? []) : (definition.denyRoles ?? [])),
    ],
  };
}

function percentageOf(definition: FeatureFlagDefinition): number | undefined {
  const percentage = definition.percentage ?? definition.rolloutPercentage;
  return typeof percentage === 'number' &&
    Number.isFinite(percentage) &&
    percentage >= 0 &&
    percentage <= 100
    ? percentage
    : undefined;
}

export interface FeatureFlagServiceOptions {
  metrics?: FeatureEvaluationMetrics;
  logger?: FeatureFlagLogger;
}

export class FeatureFlagService<Flag extends string = string> {
  readonly store: FeatureFlagSnapshotStore<Flag>;
  readonly metrics: FeatureEvaluationMetrics;
  private readonly logger: FeatureFlagLogger;

  constructor(
    snapshotOrStore: FeatureFlagSnapshot<Flag> | FeatureFlagSnapshotStore<Flag>,
    options: FeatureFlagServiceOptions = {}
  ) {
    this.store =
      'getSnapshot' in snapshotOrStore
        ? snapshotOrStore
        : new InMemoryFeatureFlagStore(snapshotOrStore);
    this.metrics = options.metrics ?? featureEvaluationMetrics;
    this.logger = options.logger ?? noopLogger;
  }

  snapshot(): FeatureFlagSnapshot<Flag> {
    return this.store.getSnapshot();
  }

  replace(snapshot: FeatureFlagSnapshot<Flag>): void {
    this.store.replace(snapshot);
  }

  evaluate(flag: Flag, context: FeatureEvaluationContext = {}): FeatureEvaluation {
    const snapshot = this.store.getSnapshot();
    const definition = snapshot.flags[flag];
    let result: FeatureEvaluation;

    if (!definition) {
      result = { flag, enabled: false, reason: 'default', snapshotVersion: snapshot.version };
    } else if (definition.enabled === false) {
      result = { flag, enabled: false, reason: 'disabled', snapshotVersion: snapshot.version };
    } else {
      const deny = normalizeTargets(definition, 'deny');
      const allow = normalizeTargets(definition, 'allow');
      const roles = rolesFor(context);
      if (listHas(deny.users, context.userId)) {
        result = { flag, enabled: false, reason: 'deny_user', snapshotVersion: snapshot.version };
      } else if (roles.some((role) => deny.roles?.includes(role))) {
        result = { flag, enabled: false, reason: 'deny_role', snapshotVersion: snapshot.version };
      } else if (listHas(allow.users, context.userId)) {
        result = { flag, enabled: true, reason: 'allow_user', snapshotVersion: snapshot.version };
      } else if (roles.some((role) => allow.roles?.includes(role))) {
        result = { flag, enabled: true, reason: 'allow_role', snapshotVersion: snapshot.version };
      } else {
        const percentage = percentageOf(definition);
        if (percentage !== undefined && !context.userId) {
          result = {
            flag,
            enabled: false,
            reason: 'missing_context',
            snapshotVersion: snapshot.version,
          };
        } else if (percentage !== undefined) {
          const bucket = stablePercentageBucket(String(flag), context.userId);
          result = {
            flag,
            enabled: bucket < percentage,
            reason: 'percentage',
            bucket,
            snapshotVersion: snapshot.version,
          };
        } else if (definition.enabled !== undefined) {
          result = {
            flag,
            enabled: definition.enabled,
            reason: 'boolean',
            snapshotVersion: snapshot.version,
          };
        } else {
          result = { flag, enabled: false, reason: 'default', snapshotVersion: snapshot.version };
        }
      }
    }

    this.metrics.record(result);
    this.logger.debug?.(
      { flag: String(flag), enabled: result.enabled, reason: result.reason },
      'feature flag evaluated'
    );
    return result;
  }

  isEnabled(flag: Flag, context: FeatureEvaluationContext = {}): boolean {
    return this.evaluate(flag, context).enabled;
  }
}

export function featureContextFromRequest(request: FastifyRequest): FeatureEvaluationContext {
  const user = request.user as { userId?: string; role?: string; roles?: string[] } | undefined;
  return { userId: user?.userId, role: user?.role, roles: user?.roles };
}

export interface RequireFeatureOptions {
  /** If true, the request must be assigned a user for percentage targeting. */
  requireUserContext?: boolean;
  message?: string;
}

/** Fastify preHandler for routes protected by a feature flag. */
export function requireFeature<Flag extends string>(
  service: FeatureFlagService<Flag>,
  flag: Flag,
  options: RequireFeatureOptions = {}
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, _reply) => {
    const context = featureContextFromRequest(request);
    if (options.requireUserContext && !context.userId) {
      throw new ForbiddenError(options.message ?? 'This feature requires an authenticated user');
    }
    if (!service.isEnabled(flag, context)) {
      throw new ForbiddenError(options.message ?? 'This feature is not available');
    }
  };
}

/** Alias with middleware-oriented naming for existing route code. */
export const featureFlagMiddleware = requireFeature;

export function featureRoute<Flag extends string>(
  service: FeatureFlagService<Flag>,
  flag: Flag,
  options: RequireFeatureOptions = {}
): { preHandler: (request: FastifyRequest, reply: FastifyReply) => Promise<void> } {
  return { preHandler: requireFeature(service, flag, options) };
}

/** Build a snapshot from the legacy boolean environment flags. */
export function legacyFeatureFlagSnapshot(
  flags: FeatureFlag[] = [
    'emailVerification',
    'analytics',
    'webhooks',
    'exports',
    'maintenanceMode',
  ]
): FeatureFlagSnapshot<FeatureFlag> {
  const environment = (process.env.NODE_ENV as ConfigEnvironment) ?? 'development';
  const resolved = resolveFeatureFlags(
    environment === 'staging' || environment === 'production' || environment === 'test'
      ? environment
      : 'development'
  );
  const definitions = Object.fromEntries(
    flags.map((flag) => [flag, { enabled: resolved[flag] }])
  ) as FeatureFlagDefinitions<FeatureFlag>;
  return createFeatureFlagSnapshot(definitions, 'legacy-environment');
}

export function evaluateFeatureFlag(
  flag: FeatureFlag,
  context: FeatureEvaluationContext = {}
): FeatureEvaluation {
  return new FeatureFlagService(legacyFeatureFlagSnapshot()).evaluate(flag, context);
}

export function isFeatureEnabledFor(
  flag: FeatureFlag,
  context: FeatureEvaluationContext = {}
): boolean {
  return evaluateFeatureFlag(flag, context).enabled;
}
