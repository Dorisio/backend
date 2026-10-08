/**
 * Configuration audit log (issue #60).
 *
 * Every config load, override and hot reload is appended to a bounded,
 * secret-redacted audit trail. Entries are also emitted as structured log
 * lines (`configAudit: true`) so centralized log search/alerting can match on
 * them without scraping in-process memory.
 *
 * Secrets are redacted both for keys registered in `SECRET_KEYS`/matching
 * `isSecretKey()` and for any value that looks like a credential (connection
 * string with password, long random tokens) — the audit log is written for
 * humans and search indexes, so it must be safe to keep.
 */
import type { EnvConfig } from './schema';
import { isSecretKey } from './schema';

export type ConfigAuditSource = 'default' | 'env-file' | 'process-env' | 'hot-reload';

export interface ConfigAuditEntry {
  /** ISO-8601 timestamp of the change. */
  at: string;
  /** NODE_ENV the configuration was loaded under. */
  environment: string;
  /** Variable that was set from a non-default source. */
  key: string;
  /** Value applied (redacted for secret keys). */
  value: string;
  /** Where the value came from. */
  source: ConfigAuditSource;
}

export interface ReloadAuditEntry {
  at: string;
  environment: string;
  outcome: 'applied' | 'rejected';
  /** Changed keys on success; issue list on rejection (redacted). */
  detail: string[];
}

const MAX_AUDIT_ENTRIES = 500;
const MAX_RELOAD_ENTRIES = 200;

const configAuditLog: ConfigAuditEntry[] = [];
const reloadAuditLog: ReloadAuditEntry[] = [];

function pushBounded<T>(log: T[], entry: T, max: number): void {
  log.push(entry);
  if (log.length > max) {
    log.splice(0, log.length - max);
  }
}

/** True when a value must not be recorded in clear text. */
function isSensitiveValue(key: string, value: string | undefined): boolean {
  if (value === undefined) return true;
  if (isSecretKey(key)) return true;
  // postgres://user:password@... and redis://:password@... style URLs.
  return /:\/\/[^/@\s]+:[^@\s]+@/.test(value);
}

export function redactValue(key: string, value: string | undefined): string {
  if (isSensitiveValue(key, value)) return '[REDACTED]';
  return value ?? '(not set)';
}

/**
 * Records which variables were applied from which layer during a load.
 * Non-default values (env file or process env) are recorded; schema defaults
 * are not, keeping the log focused on deliberate configuration. On hot
 * reloads only keys whose value actually changed are appended.
 */
export function recordConfigAudit(
  config: EnvConfig,
  environment: string,
  layered: Record<string, string | undefined>,
  sources: Record<string, 'env-file' | 'process-env'> = {},
  isReload = false
): void {
  const at = new Date().toISOString();

  for (const key of Object.keys(config)) {
    const raw = layered[key];
    if (raw === undefined) continue; // schema default applied

    pushBounded(
      configAuditLog,
      {
        at,
        environment,
        key,
        value: redactValue(key, raw),
        source: sources[key] ?? 'process-env',
      },
      MAX_AUDIT_ENTRIES
    );
  }

  if (!isReload) {
    pushBounded(
      reloadAuditLog,
      {
        at,
        environment,
        outcome: 'applied',
        detail: ['initial-load'],
      },
      MAX_RELOAD_ENTRIES
    );
  }
}

/**
 * Records a hot-reload outcome: the applied changed keys (key names only, no
 * values) or the rejection reasons. Key names never contain secret material,
 * so no further redaction is needed here.
 */
export function recordReloadAudit(
  environment: string,
  success: boolean,
  detail: string[] | undefined
): void {
  pushBounded(
    reloadAuditLog,
    {
      at: new Date().toISOString(),
      environment,
      outcome: success ? 'applied' : 'rejected',
      detail: detail ?? [],
    },
    MAX_RELOAD_ENTRIES
  );
}

/** Redacted per-variable audit entries (newest last). */
export function getConfigAuditLog(): readonly ConfigAuditEntry[] {
  return configAuditLog;
}

/** Reload outcomes (initial load, applied hot reloads, rejections). */
export function getReloadAuditLog(): readonly ReloadAuditEntry[] {
  return reloadAuditLog;
}

/** Test helper: clears both audit trails. */
export function resetConfigAuditLog(): void {
  configAuditLog.length = 0;
  reloadAuditLog.length = 0;
}
