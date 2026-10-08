import { FileBackupTarget, BackupService } from '../src/services/backup.service';
import {
  BackupVerificationService,
  FileBackupVerificationHistory,
} from '../src/services/backup-verification.service';
import { config } from '../src/config';
import { logger } from '../src/utils/logger';

function encryptionKey(): Buffer {
  const raw = config.BACKUP_ENCRYPTION_KEY;
  if (!raw) throw new Error('BACKUP_ENCRYPTION_KEY is required for backup verification');
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY must decode to exactly 32 bytes');
  return key;
}

async function main(): Promise<void> {
  if (!config.BACKUP_VERIFICATION_ENABLED) {
    logger.info(
      'Backup verification is disabled; set BACKUP_VERIFICATION_ENABLED=true in the worker environment.'
    );
    return;
  }

  const service = new BackupVerificationService(
    new BackupService(
      [
        new FileBackupTarget(config.BACKUP_DIRECTORY),
        new FileBackupTarget(config.BACKUP_SECONDARY_DIRECTORY),
      ],
      encryptionKey()
    ),
    new FileBackupVerificationHistory(config.BACKUP_VERIFICATION_HISTORY_PATH),
    {
      maxRestoreTimeMs: config.BACKUP_VERIFICATION_MAX_RESTORE_MS,
      verifyCriticalQueries: async (data) => {
        if (data === null || typeof data !== 'object') {
          throw new Error('restored snapshot is not a structured object');
        }
      },
    }
  );

  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`backup verification exceeded ${config.BACKUP_VERIFICATION_TIMEOUT_MS}ms`)
        ),
      config.BACKUP_VERIFICATION_TIMEOUT_MS
    );
    timer.unref();
  });
  const result = await Promise.race([service.verifyLatest(), timeout]);
  logger.info(result, 'Backup verification passed');
}

main().catch((error) => {
  logger.error({ error }, 'Backup verification failed; alerting through job/CI failure');
  process.exitCode = 1;
});
