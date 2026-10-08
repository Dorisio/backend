/**
 * Back-compat shim for the pre-centralized configuration module (issue #60).
 *
 * Keep existing `import { config } from '../config/env'` call sites working,
 * but route all validation, secret resolution, and auditing through the single
 * validated loader. Do not duplicate or bypass its schema here.
 */
import { getConfig } from './loader';

export const config = getConfig();

/** Resolve CORS origins from the centralized configuration. */
export function getCorsOrigins(): string[] | true {
  const raw = config.CORS_ORIGINS?.trim();
  if (!raw || raw === '*') return true;
  const origins = raw.split(',').map((origin) => origin.trim()).filter(Boolean);
  return origins.length > 0 ? origins : true;
}
