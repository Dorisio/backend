import { createHash, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { NotFoundError, ValidationError } from '../../utils/errors';

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 5;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export class SessionService {
  constructor(private readonly prisma: PrismaClient, private readonly maxSessions = DEFAULT_MAX_SESSIONS) {}

  async create(userId: string, metadata: { userAgent?: string; ipAddress?: string; device?: string } = {}) {
    const now = new Date();
    await this.prisma.session.deleteMany({ where: { userId, OR: [{ expiresAt: { lte: now } }, { revokedAt: { not: null } }] } });
    const active = await this.prisma.session.findMany({ where: { userId, revokedAt: null, expiresAt: { gt: now } }, orderBy: { lastActivity: 'asc' } });
    if (active.length >= this.maxSessions) await this.prisma.session.deleteMany({ where: { id: active[0].id } });
    const token = randomBytes(32).toString('hex');
    await this.prisma.session.create({ data: { userId, token: digest(token), device: metadata.device, userAgent: metadata.userAgent, ipAddress: metadata.ipAddress, lastActivity: now, expiresAt: new Date(now.getTime() + SESSION_TIMEOUT_MS) } });
    return token;
  }

  async touch(token: string) {
    const session = await this.prisma.session.findUnique({ where: { token: digest(token) } });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) throw new ValidationError('Session expired');
    return this.prisma.session.update({ where: { id: session.id }, data: { lastActivity: new Date(), expiresAt: new Date(Date.now() + SESSION_TIMEOUT_MS) } });
  }

  async revoke(userId: string, sessionId: string) {
    const result = await this.prisma.session.updateMany({ where: { id: sessionId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (result.count === 0) throw new NotFoundError('Session');
  }

  async revokeAll(userId: string) {
    await this.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.prisma.user.update({ where: { id: userId }, data: { authVersion: { increment: 1 } } });
  }

  async list(userId: string) {
    return this.prisma.session.findMany({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { lastActivity: 'desc' }, select: { id: true, device: true, userAgent: true, ipAddress: true, lastActivity: true, expiresAt: true, createdAt: true } });
  }
}
