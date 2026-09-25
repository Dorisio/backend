/**
 * Request context propagation for centralized logging (#26).
 *
 * 11 files log via the module-level `logger` from `utils/logger.ts`
 * (not Fastify's request-scoped `request.log`), so none of those log
 * lines carried a requestId/userId — impossible to correlate one
 * request's logs across services once centralized. Refactoring every
 * call site to thread `request`/`reply` through would be a large, risky
 * change for a payments backend; AsyncLocalStorage lets any code, at any
 * depth in the call stack, read the current request's context without
 * that refactor. `utils/logger.ts`'s Pino `mixin` reads this on every
 * log call, so every existing `logger.info(...)` call gains requestId
 * (and userId once authenticated) automatically.
 */

import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  requestId: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Called once auth middleware resolves the user, so later log lines in the same request include userId too. */
export function setRequestContextUserId(userId: string): void {
  const context = storage.getStore();
  if (context) {
    context.userId = userId;
  }
}
