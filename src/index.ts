import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { config } from './config/env';
import { AppError } from './utils/errors';
import { PrismaClient } from '@prisma/client';
import { registerAuthRoutes } from './domains/auth/auth.routes';
import { registerPaymentRoutes } from './domains/payments/payment.routes';

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
  },
});

// Initialize Prisma
const prisma = new PrismaClient();

// Register plugins
app.register(cors, {
  origin: true,
  credentials: true,
});

// Register routes
registerAuthRoutes(app, prisma);
registerPaymentRoutes(app, prisma);

// Health check endpoint
app.get('/health', async (_request, _reply) => {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: config.NODE_ENV,
  };
});

// Error handler
app.setErrorHandler(async (error, _request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  if (error instanceof AppError) {
    reply.code(error.statusCode).send({
      error: error.message,
      code: error.code,
    });
    return;
  }

  app.log.error(error);
  reply.code(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
});

const start = async (): Promise<void> => {
  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    console.log(`Server listening on http://0.0.0.0:${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
