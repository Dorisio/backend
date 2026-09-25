import pino from 'pino';
import { config } from '../config';
import { getRequestContext } from '../lib/requestContext';

const isProduction = config.NODE_ENV === 'production';

export const logger = pino({
  level: config.LOG_LEVEL,
  // Injected into every log call's merge object — this is how requestId/
  // userId end up on every existing `logger.info(...)` call site (#26)
  // without threading the request through each one individually. See
  // src/lib/requestContext.ts for how the context gets populated.
  mixin() {
    const context = getRequestContext();
    if (!context) return {};
    return {
      requestId: context.requestId,
      ...(context.userId ? { userId: context.userId } : {}),
    };
  },
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
});
