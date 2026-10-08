import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BackupManifest, BackupService } from './backup.service';

export interface BackupVerificationOptions {
  /** Optional callback that restores the verified snapshot into staging. */
  restoreToStaging?: (data: unknown, manifest: BackupManifest) => Promise<void>;
  /** Optional callback for critical-query/data-integrity checks in staging. */
  verifyCriticalQueries?: (data: unknown, manifest: BackupManifest) => Promise<void>;
  maxRestoreTimeMs?: number;
  now?: () => Date;
}

export interface BackupVerificationResult {
  status: 'passed' | 'failed';
  backupKey: string;
  checkedAt: string;
  restoreTimeMs: number;
  checksum: string;
  criticalQueriesVerified: boolean;
  error?: string;
}

export interface BackupVerificationHistory {
  results: BackupVerificationResult[];
  successRate: number;
}

/** Small JSONL history store suitable for a mounted operations volume. */
export class FileBackupVerificationHistory {
  constructor(private readonly filePath: string) {}

  async append(result: BackupVerificationResult): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  }

  async read(): Promise<BackupVerificationHistory> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const results = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as BackupVerificationResult);
      const passed = results.filter((result) => result.status === 'passed').length;
      return { results, successRate: results.length === 0 ? 1 : passed / results.length };
    } catch {
      return { results: [], successRate: 1 };
    }
  }
}

/**
 * Runs a non-destructive restore test against the newest encrypted backup.
 * The restore callback is where a deployment can load the snapshot into an
 * isolated staging database; production data is never touched by this class.
 */
export class BackupVerificationService {
  constructor(
    private readonly backups: BackupService,
    private readonly history?: FileBackupVerificationHistory,
    private readonly options: BackupVerificationOptions = {}
  ) {}

  async verifyLatest(): Promise<BackupVerificationResult> {
    const checkedAt = (this.options.now ?? (() => new Date()))().toISOString();
    const backupKey = await this.backups.latestKey();
    const started = Date.now();

    try {
      const restored = await this.backups.restore(backupKey);
      const restoreTimeMs = Date.now() - started;
      if (
        this.options.maxRestoreTimeMs !== undefined &&
        restoreTimeMs > this.options.maxRestoreTimeMs
      ) {
        throw new Error(
          `restore exceeded ${this.options.maxRestoreTimeMs}ms (took ${restoreTimeMs}ms)`
        );
      }

      if (this.options.restoreToStaging) {
        await this.options.restoreToStaging(restored.data, restored.manifest);
      }
      if (this.options.verifyCriticalQueries) {
        await this.options.verifyCriticalQueries(restored.data, restored.manifest);
      }

      const result: BackupVerificationResult = {
        status: 'passed',
        backupKey,
        checkedAt,
        restoreTimeMs,
        checksum: restored.manifest.sha256,
        criticalQueriesVerified: Boolean(this.options.verifyCriticalQueries),
      };
      await this.history?.append(result);
      return result;
    } catch (error) {
      const result: BackupVerificationResult = {
        status: 'failed',
        backupKey,
        checkedAt,
        restoreTimeMs: Date.now() - started,
        checksum: '',
        criticalQueriesVerified: false,
        error: error instanceof Error ? error.message : String(error),
      };
      await this.history?.append(result);
      throw Object.assign(new Error(`backup verification failed: ${result.error}`), { result });
    }
  }
}
