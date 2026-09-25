import { FastifyInstance } from 'fastify';

/**
 * Response schemas across the route definitions are used to document the API
 * for OpenAPI consumers, and many are shorthand entries such as
 * `200: { description: 'Tip details' }`.
 *
 * Fastify's default serializer compiler (fast-json-stringify) rejects those
 * shorthand schemas while booting the server, so the application could not
 * start. Serializing with `JSON.stringify` keeps the schemas documentation-only
 * and returns the complete payload produced by the handlers (including fields
 * such as `timestamp`) without per-route schema filtering.
 */
export function applyJsonSerializer(app: FastifyInstance): void {
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
}
