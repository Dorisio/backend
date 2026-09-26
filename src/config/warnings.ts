/**
 * Startup configuration warnings: settings that are valid but unsafe. They are
 * collected here and logged together on boot so they appear as one
 * recognizable block with structured fields (`configWarning: true`,
 * `setting`) that log search and alerting can match on.
 */
import type { Logger } from 'pino';
import { config } from './env';
import { parseTrustProxy } from './rate-limit';

export interface ConfigWarning {
  setting: string;
  message: string;
}

type Env = Pick<typeof config, 'TRUST_PROXY' | 'RATE_LIMIT_ENABLED'>;

export function collectConfigWarnings(env: Env = config): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];

  if (parseTrustProxy(env.TRUST_PROXY) === true) {
    warnings.push({
      setting: 'TRUST_PROXY',
      message:
        'TRUST_PROXY=true trusts any X-Forwarded-For value. Clients can forge their IP and ' +
        'evade per-IP rate limits. Set a hop count or the proxy address range instead.',
    });
  }

  if (!env.RATE_LIMIT_ENABLED) {
    warnings.push({
      setting: 'RATE_LIMIT_ENABLED',
      message: 'Rate limiting is disabled. The API is unprotected against request floods.',
    });
  }

  return warnings;
}

/**
 * Logs each warning at `warn`, or at the configured level when that is
 * stricter (LOG_LEVEL=error/fatal), so the warnings are never filtered out.
 */
export function logConfigWarnings(
  log: Pick<Logger, 'level' | 'isLevelEnabled' | 'warn' | 'error' | 'fatal'>,
  warnings: ConfigWarning[]
): void {
  if (warnings.length === 0) return;

  const level = log.isLevelEnabled('warn') ? 'warn' : log.level === 'fatal' ? 'fatal' : 'error';
  for (const { setting, message } of warnings) {
    log[level]({ configWarning: true, setting }, `Configuration warning [${setting}]: ${message}`);
  }
  log[level](
    { configWarning: true, count: warnings.length, settings: warnings.map((w) => w.setting) },
    `${warnings.length} configuration warning(s) at startup, review before serving production traffic`
  );
}
