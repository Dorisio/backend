import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { ValidationError } from '../../utils/errors';

const base32 = (value: Buffer) => value.toString('base64').replace(/=+$/g, '').replace(/\+/g, 'A').replace(/\//g, 'B');
const decodeBase32 = (value: string) => Buffer.from(value.replace(/=+$/g, '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const codeFor = (secret: string, counter: number) => {
  const digest = createHmac('sha1', decodeBase32(secret)).update(Buffer.from(counter.toString(16).padStart(16, '0'), 'hex')).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return number.toString().padStart(6, '0');
};
export const verifyTotp = (secret: string, input: string, now = Date.now()) => {
  if (!/^\d{6}$/.test(input)) return false;
  const counter = Math.floor(now / 30_000);
  return [-1, 0, 1].some((window) => { const expected = Buffer.from(codeFor(secret, counter + window)); const actual = Buffer.from(input); return expected.length === actual.length && timingSafeEqual(expected, actual); });
};

export class TwoFactorService {
  constructor(private readonly prisma: PrismaClient) {}
  async setup(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } }); if (!user) throw new ValidationError('User not found');
    const secret = base32(randomBytes(20));
    const plainBackupCodes = Array.from({ length: 10 }, () => randomBytes(6).toString('hex'));
    const backupCodes = await Promise.all(plainBackupCodes.map((code) => bcrypt.hash(code, 10)));
    await this.prisma.twoFactorAuth.upsert({ where: { userId }, create: { userId, secret, backupCodes }, update: { secret, backupCodes, enabled: false } });
    await this.event(userId, 'setup', true);
    const label = encodeURIComponent(`Dorisio:${user.email}`);
    return { secret, backupCodes: plainBackupCodes, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=Dorisio&algorithm=SHA1&digits=6&period=30` };
  }
  async enable(userId: string, code: string) {
    const record = await this.prisma.twoFactorAuth.findUnique({ where: { userId } });
    if (!record || !verifyTotp(record.secret, code)) { await this.event(userId, 'enable', false); throw new ValidationError('Invalid authenticator code'); }
    await this.prisma.twoFactorAuth.update({ where: { userId }, data: { enabled: true } }); await this.event(userId, 'enable', true); return { enabled: true };
  }
  async disable(userId: string, code: string) {
    const record = await this.prisma.twoFactorAuth.findUnique({ where: { userId } });
    if (!record || (!verifyTotp(record.secret, code) && !(await this.consumeBackupCode(record, code)))) { await this.event(userId, 'disable', false); throw new ValidationError('Invalid two-factor code'); }
    await this.prisma.twoFactorAuth.update({ where: { userId }, data: { enabled: false } }); await this.event(userId, 'disable', true); return { enabled: false };
  }
  async verify(userId: string, code: string, deviceToken?: string) {
    const record = await this.prisma.twoFactorAuth.findUnique({ where: { userId } });
    const valid = !!record && (verifyTotp(record.secret, code) || await this.consumeBackupCode(record, code));
    await this.event(userId, 'verify', valid); if (!valid) throw new ValidationError('Invalid two-factor code');
    if (!deviceToken) return { verified: true };
    const tokenHash = await bcrypt.hash(deviceToken, 10); await this.prisma.trustedDevice.create({ data: { userId, tokenHash, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } }); return { verified: true, trustedUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() };
  }
  private async consumeBackupCode(record: { id: string; backupCodes: string[] }, code: string) { const index = (await Promise.all(record.backupCodes.map((hash) => bcrypt.compare(code, hash)))).findIndex(Boolean); if (index < 0) return false; const remaining = record.backupCodes.filter((_, i) => i !== index); await this.prisma.twoFactorAuth.update({ where: { id: record.id }, data: { backupCodes: remaining } }); return true; }
  private event(userId: string, type: string, success: boolean) { return this.prisma.twoFactorEvent.create({ data: { userId, type, success } }); }
}
