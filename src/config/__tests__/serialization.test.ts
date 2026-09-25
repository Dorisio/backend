import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { applyJsonSerializer } from '../serialization';

describe('applyJsonSerializer', () => {
  it('allows description-only response schemas to boot', async () => {
    const app = Fastify({ logger: false });
    applyJsonSerializer(app);

    app.get(
      '/json',
      { schema: { response: { 200: { description: 'ok' }, 400: { description: 'bad' } } } },
      async () => ({ success: true, timestamp: 'now' })
    );

    app.get(
      '/text',
      { schema: { response: { 200: { description: 'text' } } } },
      async (_request, reply) => reply.type('text/plain').send('hello')
    );

    await expect(app.ready()).resolves.toBeDefined();

    const json = await app.inject('/json');
    expect(JSON.parse(json.body)).toEqual({ success: true, timestamp: 'now' });

    const text = await app.inject('/text');
    expect(text.body).toBe('hello');

    await app.close();
  });

  it('returns the full payload rather than filtering to declared properties', async () => {
    const app = Fastify({ logger: false });
    applyJsonSerializer(app);

    app.get(
      '/partial',
      {
        schema: {
          response: {
            200: {
              type: 'object',
              properties: { success: { type: 'boolean' } },
            },
          },
        },
      },
      async () => ({ success: true, data: { id: 'x' }, timestamp: 'now' })
    );

    const response = await app.inject('/partial');
    expect(JSON.parse(response.body)).toEqual({
      success: true,
      data: { id: 'x' },
      timestamp: 'now',
    });

    await app.close();
  });
});
