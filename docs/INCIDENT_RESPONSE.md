# Incident response

This runbook applies to outages, suspected security incidents, data
integrity problems, and payment or Stellar settlement failures. The incident
commander owns coordination; the technical lead owns mitigation; the
communications lead keeps stakeholders informed. One person may hold more than
one role for a small incident.

## Severity and response targets

| Severity | Example | Acknowledge | Update cadence |
| --- | --- | ---: | ---: |
| SEV-1 | Payments unavailable, suspected key exposure, or data loss | 15 min | 30 min |
| SEV-2 | Major feature degraded or repeated settlement failures | 30 min | 60 min |
| SEV-3 | Limited customer impact or workaround available | 1 business hour | Daily |

## First 15 minutes

1. Open an incident record from `docs/incident-template.md` and assign an
   incident commander.
2. Record the UTC start time, affected service/route, symptoms, and the last
   known good deployment. Do not put credentials, wallet secrets, or personal
   data in the record.
3. Check `/health`, `/metrics`, application logs, PostgreSQL, Redis, queue
   depth, and Stellar Horizon/RPC status. Capture links and timestamps.
4. If payments or credentials may be affected, pause the affected worker or
   feature flag and notify the security contact in `SECURITY.md`.
5. Choose the smallest reversible mitigation: rollback, disable a feature,
   drain a queue, or fail over to the documented dependency.
6. Publish a short stakeholder update with impact, mitigation, and next update
   time. Avoid speculation and never share secrets.

## Escalation and communication

- The incident commander pages the on-call engineer first, then the service
  owner, database/operations owner, and security contact as applicable.
- SEV-1 incidents are escalated to the maintainer immediately and remain open
  until customer impact and security risk are understood.
- Keep a timestamped log of decisions, commands, dashboards, and deploys.
- Customer-facing messages state what is affected, what users should do, and
  when the next update will be available.

## Recovery and closure

1. Verify the service with health checks and a safe end-to-end transaction in
   the appropriate environment.
2. Confirm queues, database consistency, webhook retries, and Stellar
   settlement state have recovered.
3. Announce recovery and continue monitoring for at least one normal traffic
   window.
4. Close the incident only after the commander records impact, duration,
   detection, mitigation, and follow-up owners.

## Post-incident review and metrics

Within five business days, complete a blameless review. Include a timeline,
root and contributing causes, what went well, what failed, and concrete
actions with owners and due dates. Track mean time to acknowledge (MTTA), mean
time to mitigate (MTTM), mean time to recover (MTTR), incident count by
severity, and repeat incidents (MTBF between incidents). Follow-up work must
link to an issue and be reviewed like production code.

Common procedures are in `docs/runbooks/`:

- `database.md` — database saturation, failed migrations, and rollback safety
- `redis.md` — cache/queue degradation and worker recovery
