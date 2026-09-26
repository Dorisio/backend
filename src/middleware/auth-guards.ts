/**
 * Registry of hooks that require an authenticated user. The rate limiter
 * reads it to classify a route as `authenticated` without the route having
 * to declare anything (see src/plugins/rateLimit.ts).
 */
type Guard = (...args: never[]) => unknown;

const authGuards = new WeakSet<Guard>();

export const registerAuthGuard = <T extends Guard>(guard: T): T => {
  authGuards.add(guard);
  return guard;
};

export const isAuthGuard = (hook: unknown): boolean =>
  typeof hook === 'function' && authGuards.has(hook as Guard);
