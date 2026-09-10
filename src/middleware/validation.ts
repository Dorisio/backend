import { FastifyRequest, FastifyReply } from 'fastify';
import { ZodSchema } from 'zod';
import { ValidationError } from '../utils/errors';

export const createValidationMiddleware =
  (schema: ZodSchema) =>
  async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    try {
      schema.parse(request.body);
    } catch (error: unknown) {
      if (error instanceof Error) {
        throw new ValidationError(error.message);
      }
      throw error;
    }
  };

export const validateBody = (
  schema: ZodSchema
): ((request: FastifyRequest, reply: FastifyReply) => Promise<void>) => {
  return createValidationMiddleware(schema);
};
