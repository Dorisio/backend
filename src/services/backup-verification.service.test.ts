import { describe, expect, it } from 'vitest';
import { BackupService, type BackupTarget } from './backup.service';
import {
  BackupVerificationService,
  FileBackupVerificationHistory,
} from './backup-verification.service';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function target(): BackupTarget & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    async put(key, payload) {
      files.set(key, payload);
    },
    async get(key) {
      const payload = files.get(key);
      if (!payload) throw new Error('missing');
      return payload;
    },
    async list() {
      return [...files.keys()];
    },
    async delete(key) {
      files.delete(key);
    },
  };
}

describe('BackupVerificationService', () => {
  it('restores the newest backup and runs staging critical-query checks', async () => {
    const primary = target();
    const secondary = target();
    const backups = new BackupService([primary, secondary], Buffer.alloc(32, 9));
    await backups.create({ snapshot: async () => ({ version: 1 }) }, '2026-01-01');
    await backups.create({ snapshot: async () => ({ version: 2 }) }, '2026-01-02');
    let staged: unknown;
    let checked = false;
    const service = new BackupVerificationService(backups, undefined, {
      restoreToStaging: async (data) => {
        staged = data;
      },
      verifyCriticalQueries: async () => {
        checked = true;
      },
      now: () => new Date('2026-01-03T00:00:00.000Z'),
    });
    await expect(service.verifyLatest()).resolves.toMatchObject({
      status: 'passed',
      backupKey: '2026-01-02.backup',
      criticalQueriesVerified: true,
    });
    expect(staged).toEqual({ version: 2 });
    expect(checked).toBe(true);
  });

  it('records failed verification and enforces restore-time SLOs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backup-verification-'));
    const primary = target();
    const secondary = target();
    const backups = new BackupService([primary, secondary], Buffer.alloc(32, 4));
    await backups.create({ snapshot: async () => ({ ok: true }) }, 'slow');
    const history = new FileBackupVerificationHistory(join(root, 'history.jsonl'));
    const service = new BackupVerificationService(backups, history, { maxRestoreTimeMs: -1 });
    await expect(service.verifyLatest()).rejects.toThrow(/backup verification failed/);
    const saved = JSON.parse(
      await readFile(join(root, 'history.jsonl'), 'utf8').then((value) => value.trim())
    );
    expect(saved.status).toBe('failed');
    expect((await history.read()).successRate).toBe(0);
    await rm(root, { recursive: true, force: true });
  });
});
