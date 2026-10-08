import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface BackupTarget {
  put(key: string, payload: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  list(): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export class FileBackupTarget implements BackupTarget {
  constructor(private readonly directory: string) {}

  async put(key: string, payload: Buffer): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.${key}.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(temporary, payload, { mode: 0o600 });
    await rename(temporary, join(this.directory, key));
  }

  async get(key: string): Promise<Buffer> {
    return readFile(join(this.directory, key));
  }
  async list(): Promise<string[]> {
    return readdir(this.directory).catch(() => []);
  }
  async delete(key: string): Promise<void> {
    await unlink(join(this.directory, key)).catch(() => undefined);
  }
}

export interface BackupSource {
  snapshot(): Promise<unknown>;
}
export interface BackupManifest {
  id: string;
  createdAt: string;
  sha256: string;
  bytes: number;
}

/** Encrypted, integrity-checked backups with multiple independent targets. */
export class BackupService {
  constructor(
    private readonly targets: BackupTarget[],
    private readonly encryptionKey: Buffer
  ) {
    if (targets.length < 2) throw new Error('at least two backup targets are required');
    if (encryptionKey.length !== 32) throw new Error('encryptionKey must be 32 bytes for AES-256');
  }

  async create(
    source: BackupSource,
    id = new Date().toISOString().split(':').join('-')
  ): Promise<BackupManifest> {
    const plaintext = Buffer.from(JSON.stringify(await source.snapshot()));
    const sha256 = createHash('sha256').update(plaintext).digest('hex');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    const manifest = { id, createdAt: new Date().toISOString(), sha256, bytes: plaintext.length };
    const record = Buffer.from(JSON.stringify({ manifest, payload: payload.toString('base64') }));
    await Promise.all(this.targets.map((target) => target.put(`${id}.backup`, record)));
    return manifest;
  }

  async restore(key: string): Promise<{ manifest: BackupManifest; data: unknown }> {
    let lastError: unknown;
    for (const target of this.targets) {
      try {
        const record = await target.get(key);
        const parsed = JSON.parse(record.toString()) as {
          manifest: BackupManifest;
          payload: string;
        };
        const encrypted = Buffer.from(parsed.payload, 'base64');
        const decipher = createDecipheriv(
          'aes-256-gcm',
          this.encryptionKey,
          encrypted.subarray(0, 12)
        );
        decipher.setAuthTag(encrypted.subarray(12, 28));
        const plaintext = Buffer.concat([
          decipher.update(encrypted.subarray(28)),
          decipher.final(),
        ]);
        const digest = createHash('sha256').update(plaintext).digest('hex');
        if (digest !== parsed.manifest.sha256) throw new Error('backup integrity check failed');
        return { manifest: parsed.manifest, data: JSON.parse(plaintext.toString()) };
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      `backup restore failed for ${key}: ${lastError instanceof Error ? lastError.message : 'backup not found'}`
    );
  }

  /** Return the newest backup key across all configured targets. */
  async latestKey(): Promise<string> {
    const keys = [
      ...new Set((await Promise.all(this.targets.map((target) => target.list()))).flat()),
    ]
      .filter((key) => key.endsWith('.backup'))
      .sort()
      .reverse();
    const latest = keys[0];
    if (!latest) throw new Error('no backups available for verification');
    return latest;
  }

  async prune(retain: number): Promise<number> {
    if (!Number.isInteger(retain) || retain < 1)
      throw new Error('retain must be a positive integer');
    const keys = [
      ...new Set((await Promise.all(this.targets.map((target) => target.list()))).flat()),
    ]
      .filter((key) => key.endsWith('.backup'))
      .sort()
      .reverse();
    const stale = keys.slice(retain);
    await Promise.all(stale.flatMap((key) => this.targets.map((target) => target.delete(key))));
    return stale.length;
  }
}
