# Secret management and rotation

Production Kubernetes secrets are synchronized from AWS Secrets Manager by
External Secrets Operator (ESO). The checked-in
[`ExternalSecret`](../../infra/kubernetes/external-secret.aws.yaml) maps the
JSON properties in `dorisio/production/backend` to the existing
`dorisio-backend-secrets` Kubernetes Secret consumed by the Deployment. The
[`ClusterSecretStore`](../../infra/kubernetes/secret-store.aws.yaml) uses
AWS web-identity credentials; no AWS access key or secret value belongs in
this repository.

## One-time platform setup

1. Install ESO and configure its `external-secrets` service account with an
   IRSA/web-identity role. Restrict `secretsmanager:GetSecretValue` and
   `secretsmanager:DescribeSecret` to the `dorisio/production/backend-*`
   secret ARN; grant `kms:Decrypt` only for the customer-managed key used by
   that secret, if applicable.
2. Create the JSON secret `dorisio/production/backend` in AWS Secrets Manager
   with `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, and the optional Stellar
   and Stripe keys used by the deployment.
3. Enable CloudTrail management/data-event auditing for Secrets Manager,
   retain the events in the organization’s protected audit account, and alert
   on denied reads, unexpected principals, and secret-version changes.
4. Apply the Kubernetes manifests and verify
   `kubectl -n dorisio get externalsecret dorisio-backend-secrets` reports
   `Ready=True`. Confirm the generated Secret contains the expected key names
   without printing or decoding any values.

The sample store currently uses `us-east-1`; set the region and remote secret
path for each environment before applying. Use a separate secret and IAM role
per environment. The legacy `secret.example.yaml` is a local/manual template
only and is deliberately not included in the Kustomize production resources.

## Rotation procedure

1. Create a new AWS Secrets Manager version. For database/Redis credentials,
   provision the new credential while the old credential remains valid.
2. Move the staging secret to the new version and verify ESO synchronization,
   readiness, database/cache connectivity, and error-rate/latency dashboards.
3. Promote the new version in production. ESO polls hourly; force a sync with
   `kubectl annotate es dorisio-backend-secrets -n dorisio force-sync=$(date +%s) --overwrite`
   when the change must be picked up immediately.
4. Restart the backend rollout after synchronization. The application pins
   connection credentials and JWT configuration at process startup; a restart
   is required for those values to take effect.
5. Verify the rollout and authentication/payment health before revoking the
   old credential. Keep the previous secret version available for rollback
   until the observation window closes.

JWT key rotation invalidates tokens signed only by the old key. Coordinate
the rollout with clients or use the application’s supported token lifetime
and re-authentication policy. Record the change ticket, secret version IDs
(never values), approver, rollout revision, and rollback decision. ESO and
CloudTrail logs must not include secret payloads; application configuration
audit output redacts keys classified as secrets.

## Incident response

If a secret may have leaked, create a replacement version immediately, verify
that ESO synced it, roll the workload, revoke the exposed credential, and
review CloudTrail access events. Follow [incident response](../INCIDENT_RESPONSE.md)
and do not paste secret values into tickets, logs, or chat.
