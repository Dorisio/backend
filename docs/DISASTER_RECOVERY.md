# Backup and disaster recovery

`BackupService` creates an encrypted AES-256-GCM snapshot, records a SHA-256
digest, and writes the same immutable backup record to at least two independent
`BackupTarget`s. `FileBackupTarget` uses restrictive permissions and atomic
rename; production deployments should provide primary and secondary-region
object-storage targets with server-side retention and key rotation.

Schedule a daily full snapshot and hourly incremental snapshot source. Retain
daily backups for 30 days and monthly backups for 12 months. Run `restore()` in
a staging environment monthly, verify the digest, and alert on any failed
target write. A restore must never overwrite production without an explicit
operator approval.

Target objectives are RPO ≤ 1 hour and RTO ≤ 4 hours. Keep the encryption key
in a KMS/secret manager, rotate it by version, and retain old key versions for
the lifetime of backups that still need to be restored. The service falls back
to the next target if the primary is unavailable and `prune()` removes records
outside the configured retention window.
