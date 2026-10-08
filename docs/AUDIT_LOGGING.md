# Audit logging

`AuditService` is the append-only boundary for compliance events. Mutation
services should call `record()` after a successful transaction and include the
actor, resource, old/new field values, request ID, and client IP. Payment,
payout, webhook, admin, user, creator, and wallet mutations should use the
same service so exports have one consistent shape.

The `AuditLog` table intentionally has no application update/delete method.
Retention is a controlled `purgeExpired()` sweep (365 days by default); run it
from a protected scheduler. `query()` supports actor/resource/action/time
filters and `export()` produces JSON or CSV with escaped fields.

For production deployments, restrict database permissions so the application
role can insert and read audit rows but cannot update or delete them. Run the
retention job with a separate maintenance role and retain database backups for
the compliance period.
