import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FastifyReply, FastifyRequest } from 'fastify';
import { idempotencyPreHandler, idempotencyOnSend } from '../idempotency';
import { cacheService } from '../cache';

vi.mock('../cache', () => ({
  cacheService: {
    get: vi.fn(),
    set: vi.fn(),
    acquireLock: vi.fn(),
    releaseLock: vi.fn(),
  },
}));

function makeRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return {
    method: 'POST',
    url: '/api/v1/transactions/tip',
    routeOptions: { url: '/api/v1/transactions/tip' },
    headers: {},
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  } as unknown as FastifyRequest;
}

function makeReply(): FastifyReply & { statusCode: number } {
  const reply: any = {
    statusCode: 200,
    header: vi.fn().mockReturnThis(),
    code: vi.fn().mockImplementation((code: number) => {
      reply.statusCode = code;
      return reply;
    }),
    send: vi.fn().mockReturnThis(),
  };
  return reply;
}

describe('idempotencyPreHandler (#24)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proceeds normally when no Idempotency-Key header is present', async () => {
    const request = makeRequest({ headers: {} } as any);
    const reply = makeReply();

    await idempotencyPreHandler(request, reply);

    expect(cacheService.get).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('returns the cached response on a duplicate request with the same key', async () => {
    (cacheService.get as any).mockResolvedValue({ statusCode: 201, body: { id: 'tip_1' } });
    const request = makeRequest({ headers: { 'idempotency-key': 'key-1' } } as any);
    const reply = makeReply();

    await idempotencyPreHandler(request, reply);

    expect(reply.code).toHaveBeenCalledWith(201);
    expect(reply.send).toHaveBeenCalledWith({ id: 'tip_1' });
    expect(cacheService.acquireLock).not.toHaveBeenCalled();
  });

  it('acquires a lock and lets the handler proceed on a first-time key', async () => {
    (cacheService.get as any).mockResolvedValue(null);
    (cacheService.acquireLock as any).mockResolvedValue(true);
    const request = makeRequest({ headers: { 'idempotency-key': 'key-2' } } as any);
    const reply = makeReply();

    await idempotencyPreHandler(request, reply);

    expect(cacheService.acquireLock).toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
    expect((request as any).idempotencyCacheKey).toBeDefined();
    expect((request as any).idempotencyLockKey).toBeDefined();
  });

  it('returns 409 when the lock cannot be acquired and no cached result appears', async () => {
    (cacheService.get as any).mockResolvedValue(null);
    (cacheService.acquireLock as any).mockResolvedValue(false);
    const request = makeRequest({ headers: { 'idempotency-key': 'key-3' } } as any);
    const reply = makeReply();

    await idempotencyPreHandler(request, reply);

    expect(reply.code).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'IDEMPOTENCY_KEY_IN_PROGRESS' })
    );
  }, 10000);

  it('scopes the cache key by authenticated user so two users sharing a key value do not collide', async () => {
    (cacheService.get as any).mockResolvedValue(null);
    (cacheService.acquireLock as any).mockResolvedValue(true);

    const requestA = makeRequest({
      headers: { 'idempotency-key': 'shared-key' },
      user: { id: 'user-a' },
    } as any);
    const requestB = makeRequest({
      headers: { 'idempotency-key': 'shared-key' },
      user: { id: 'user-b' },
    } as any);

    await idempotencyPreHandler(requestA, makeReply());
    await idempotencyPreHandler(requestB, makeReply());

    expect((requestA as any).idempotencyCacheKey).not.toBe((requestB as any).idempotencyCacheKey);
  });
});

describe('idempotencyOnSend (#24)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when the request never went through idempotencyPreHandler', async () => {
    const request = makeRequest();
    const reply = makeReply();

    const result = await idempotencyOnSend(request, reply, JSON.stringify({ ok: true }));

    expect(cacheService.set).not.toHaveBeenCalled();
    expect(result).toBe(JSON.stringify({ ok: true }));
  });

  it('caches a successful response and releases the lock', async () => {
    const request = makeRequest({
      idempotencyCacheKey: 'idempotency:u:POST:/x:k',
      idempotencyLockKey: 'lock:idempotency:u:POST:/x:k',
    } as any);
    const reply = makeReply();
    reply.statusCode = 201;

    await idempotencyOnSend(request, reply, JSON.stringify({ id: 'tip_1' }));

    expect(cacheService.set).toHaveBeenCalledWith(
      'idempotency:u:POST:/x:k',
      { statusCode: 201, body: { id: 'tip_1' } },
      24 * 60 * 60
    );
    expect(cacheService.releaseLock).toHaveBeenCalledWith('lock:idempotency:u:POST:/x:k');
  });

  it('does not cache an error response but still releases the lock', async () => {
    const request = makeRequest({
      idempotencyCacheKey: 'idempotency:u:POST:/x:k',
      idempotencyLockKey: 'lock:idempotency:u:POST:/x:k',
    } as any);
    const reply = makeReply();
    reply.statusCode = 500;

    await idempotencyOnSend(request, reply, JSON.stringify({ error: 'boom' }));

    expect(cacheService.set).not.toHaveBeenCalled();
    expect(cacheService.releaseLock).toHaveBeenCalled();
  });

  it('releases the lock even if caching throws', async () => {
    (cacheService.set as any).mockRejectedValue(new Error('redis down'));
    const request = makeRequest({
      idempotencyCacheKey: 'idempotency:u:POST:/x:k',
      idempotencyLockKey: 'lock:idempotency:u:POST:/x:k',
    } as any);
    const reply = makeReply();
    reply.statusCode = 200;

    await expect(idempotencyOnSend(request, reply, '{}')).rejects.toThrow('redis down');
    expect(cacheService.releaseLock).toHaveBeenCalled();
  });
});
