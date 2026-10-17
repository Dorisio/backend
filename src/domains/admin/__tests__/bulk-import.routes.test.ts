import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { AdminService } from '../admin.service';
import { AppError, UnauthorizedError } from '../../../utils/errors';

// Mock auth middleware (same pattern as dispute.routes.integration.test.ts)
const authMiddlewareMock = vi.hoisted(() => vi.fn());
vi.mock('../../../middleware/auth', () => ({
  authMiddleware: authMiddlewareMock,
}));

// Mock hashPassword to avoid bcrypt overhead in tests
const hashPasswordMock = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/password', () => ({
  hashPassword: hashPasswordMock,
}));

// Mock cache
vi.mock('../../../lib/cache/index', () => ({
  default: { clear: vi.fn(), del: vi.fn() },
  getStats: vi.fn().mockReturnValue({}),
  getHitRate: vi.fn().mockReturnValue(0),
  resetStats: vi.fn(),
}));

vi.mock('../../../lib/cache/cache-warming', () => ({
  CacheWarmer: vi.fn().mockImplementation(() => ({
    warmAll: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../../lib/requestContext', () => ({
  setRequestContextUserId: vi.fn(),
  getRequestContext: vi.fn().mockReturnValue(undefined),
  runWithContext: vi.fn((_ctx, fn) => fn()),
}));

describe('Admin Bulk User Import (#202)', () => {
  let app: FastifyInstance;
  let prismaMock: any;
  const createdUsers: any[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    createdUsers.length = 0;

    // Pre-seed the admin user used by setAuthenticatedUser
    createdUsers.push({
      id: 'admin-user-1',
      email: 'admin@dorisio.com',
      password: 'hashed-x',
      role: 'admin',
    });

    hashPasswordMock.mockImplementation(async (password: string) => `hashed-${password}`);

    // Default: authenticated admin
    authMiddlewareMock.mockImplementation(async (request: { user?: unknown }) => {
      request.user = { userId: 'admin-user-1', email: 'admin@dorisio.com', role: 'admin' };
    });

    prismaMock = {
      user: {
        findUnique: vi.fn().mockImplementation(async ({ where }: any) => {
          if (where.id) {
            const existing = createdUsers.find((u) => u.id === where.id);
            if (existing) return existing;
            // Mock admin lookup for any admin-bob style id
            if (where.id.startsWith('admin-')) {
              return { id: where.id, email: 'admin@dorisio.com', role: 'admin' };
            }
            return null;
          }
          const existing = createdUsers.find((u) => u.email === where.email);
          return existing || null;
        }),
        create: vi.fn().mockImplementation(async ({ data }: any) => {
          const user = {
            id: `user-${createdUsers.length + 1}`,
            ...data,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          createdUsers.push(user);
          return user;
        }),
      },
      $transaction: vi.fn(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
        return callback(prismaMock);
      }),
    };

    app = Fastify({ logger: false });
    const adminService = new AdminService(prismaMock);

    const { requireAdmin } = await import('../../../middleware/rbac');

    const handler = async (request: any, reply: any) => {
      const user = request.user;
      if (!user) throw new Error('User not found');
      const { csv } = request.body;
      try {
      const result = await adminService.bulkImportUsers(user.userId, csv);
        return reply.code(200).send({ success: true, data: result, timestamp: new Date().toISOString() });
      } catch (error) {
        if (error instanceof AppError) {
          return reply.code(error.statusCode).send({
            success: false,
            error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
            timestamp: new Date().toISOString(),
          });
        }
        throw error;
      }
    };

    app.post<{ Body: { csv: string } }>('/api/v1/admin/users/bulk-import', { preHandler: requireAdmin }, handler);
    app.post<{ Body: { csv: string } }>('/api/admin/users/bulk-import', { preHandler: requireAdmin }, handler);
  });

  function setAuthenticatedUser(role: string, userId = 'admin-user-1') {
    authMiddlewareMock.mockImplementation(async (request: { user?: unknown }) => {
      request.user = { userId, email: 'admin@dorisio.com', role };
    });
  }

  const validCsv = `email,password,name,role
alice@example.com,securePass1,Alice,creator
bob@example.com,securePass2,Bob,fan`;

  it('creates all users from valid CSV and returns per-row report', async () => {
    setAuthenticatedUser('admin', 'admin-bob');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users/bulk-import',
      payload: { csv: validCsv },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.data.total).toBe(2);
    expect(body.data.created).toBe(2);
    expect(body.data.failed).toBe(0);
    expect(body.data.results).toHaveLength(2);
    expect(body.data.results[0]).toMatchObject({
      row: 2,
      email: 'alice@example.com',
      status: 'created',
    });
    expect(body.data.results[1]).toMatchObject({
      row: 3,
      email: 'bob@example.com',
      status: 'created',
    });
    expect(body.data.results[0].userId).toBeDefined();
    expect(body.data.results[1].userId).toBeDefined();

    expect(prismaMock.user.create).toHaveBeenCalledTimes(2);
  });

  it('supports /api/admin/users/bulk-import prefix', async () => {
    setAuthenticatedUser('admin');

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/users/bulk-import',
      payload: { csv: validCsv },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.data.created).toBe(2);
  });

  it('validates all rows before creating any user (fail-fast)', async () => {
    setAuthenticatedUser('admin');

    const invalidCsv = `email,password,name,role
alice@example.com,securePass1,Alice,creator
bob@example.com,short,Bob,fan
charlie@example.com,securePass3,Charlie,admin`;

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users/bulk-import',
      payload: { csv: invalidCsv },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(false);

    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it('returns per-row validation errors', async () => {
    setAuthenticatedUser('admin');

    const invalidCsv = `email,password,name,role
alice@example.com,securePass1,Alice,creator
bob@example.com,short,Bob,fan
,securePass3,NoEmail,fan
dave@example.com,securePass4,Dave,invalidrole`;

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users/bulk-import',
      payload: { csv: invalidCsv },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details).toBeDefined();
  });

  it('rejects duplicate email within CSV', async () => {
    setAuthenticatedUser('admin');

    const dupCsv = `email,password,name,role
alice@example.com,securePass1,Alice,creator
alice@example.com,securePass2,AliceAgain,fan`;

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users/bulk-import',
      payload: { csv: dupCsv },
    });

    expect(res.statusCode).toBe(400);
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it('rejects email already registered in database', async () => {
    setAuthenticatedUser('admin');

    createdUsers.push({
      id: 'existing-user',
      email: 'alice@example.com',
      password: 'hashed-x',
      role: 'fan',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users/bulk-import',
      payload: { csv: validCsv },
    });

    expect(res.statusCode).toBe(400);
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it('defaults missing role to fan and optional name', async () => {
    setAuthenticatedUser('admin');

    const minimalCsv = `email,password
carol@example.com,securePass1
dave@example.com,securePass2`;

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users/bulk-import',
      payload: { csv: minimalCsv },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.data.created).toBe(2);

    expect(prismaMock.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'carol@example.com',
          role: 'fan',
          name: null,
        }),
      })
    );
  });

  it('rejects non-admin requests with 403', async () => {
    authMiddlewareMock.mockImplementation(async (request: { user?: unknown }) => {
      request.user = { userId: 'fan-user', email: 'fan@dorisio.com', role: 'fan' };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users/bulk-import',
      payload: { csv: validCsv },
    });

    expect(res.statusCode).toBe(403);
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated requests', async () => {
    authMiddlewareMock.mockImplementation(async (_request: { user?: unknown }) => {
      throw new UnauthorizedError('Missing or invalid authorization header');
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users/bulk-import',
      payload: { csv: validCsv },
    });

    expect(res.statusCode).toBe(401);
  });

  it('rejects CSV with no data rows', async () => {
    setAuthenticatedUser('admin');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users/bulk-import',
      payload: { csv: 'email,password,name,role\n' },
    });

    expect(res.statusCode).toBe(400);
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it('rejects missing required columns', async () => {
    setAuthenticatedUser('admin');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users/bulk-import',
      payload: { csv: 'name,role\nAlice,creator\n' },
    });

    expect(res.statusCode).toBe(400);
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it('hashes passwords before storing', async () => {
    setAuthenticatedUser('admin');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users/bulk-import',
      payload: { csv: validCsv },
    });

    expect(res.statusCode).toBe(200);
    expect(hashPasswordMock).toHaveBeenCalledTimes(2);
    expect(hashPasswordMock).toHaveBeenCalledWith('securePass1');
    expect(hashPasswordMock).toHaveBeenCalledWith('securePass2');
  });

  it('returns 500 when transaction fails', async () => {
    setAuthenticatedUser('admin');

    let createCount = 0;
    prismaMock.user.create = vi.fn().mockImplementation(async ({ data }: any) => {
      createCount++;
      if (createCount === 2) {
        throw new Error('Database write failure');
      }
      const user = {
        id: `user-${createCount}`,
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      createdUsers.push(user);
      return user;
    });

    prismaMock.$transaction = vi.fn(async (callback: any) => callback(prismaMock));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users/bulk-import',
      payload: { csv: validCsv },
    });

    expect(res.statusCode).toBe(500);
  });
});
