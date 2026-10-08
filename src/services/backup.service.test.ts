import { describe, expect, it } from 'vitest';
import { BackupService, type BackupTarget } from './backup.service';

function target(): BackupTarget & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    async put(key, payload) { files.set(key, payload); },
    async get(key) { const payload = files.get(key); if (!payload) throw new Error('missing'); return payload; },
    async list() { return [...files.keys()]; },
    async delete(key) { files.delete(key); },
  };
}

describe('BackupService', () => {
  it('writes encrypted copies to both targets and restores with integrity verification', async () => {
    const primary = target();
    const secondary = target();
    const service = new BackupService([primary, secondary], Buffer.alloc(32, 7));
    const manifest = await service.create({ snapshot: async () => ({ users: [{ id: 'u1' }] }) }, 'backup-1');
    expect(primary.files.has('backup-1.backup')).toBe(true);
    expect(secondary.files.has('backup-1.backup')).toBe(true);
    const restored = await service.restore('backup-1.backup');
    expect(restored.manifest.sha256).toBe(manifest.sha256);
    expect(restored.data).toEqual({ users: [{ id: 'u1' }] });
  });

  it('falls back to the secondary target and enforces AES-256 key size', async () => {
    const primary = target();
    const secondary = target();
    const service = new BackupService([primary, secondary], Buffer.alloc(32));
    await service.create({ snapshot: async () => ({ ok: true }) }, 'backup-2');
    primary.files.clear();
    await expect(service.restore('backup-2.backup')).resolves.toMatchObject({ data: { ok: true } });
    expect(() => new BackupService([primary, secondary], Buffer.alloc(16))).toThrow('32 bytes');
  });
});
