# Monitoring and alerting

The backend already exports Prometheus application, HTTP, Redis/database-pool,
and Prisma query metrics at `/metrics`; the Kubernetes
[`ServiceMonitor`](../infra/kubernetes/servicemonitor.yaml) scrapes that
endpoint. The optional Compose `monitoring` profile adds Prometheus,
Alertmanager, Grafana, Node Exporter, and PostgreSQL Exporter for an
end-to-end reference stack.

## Start the stack

```sh
cp .env.example .env
# Set real, private values for the webhook, PagerDuty routing key, Grafana
# password, and (for non-development databases) exporter DSN in .env.
docker compose --profile monitoring up --build
```

- Prometheus: <http://localhost:9090>
- Alertmanager: <http://localhost:9093>
- Grafana: <http://localhost:3001> (dashboard: **Dorisio Operations Overview**)
- App metrics: <http://localhost:3000/metrics>

Prometheus scrapes the application every 15 seconds, plus Node Exporter host
CPU/memory/filesystem/network counters and PostgreSQL connection/transaction
metrics. App histogram data provides request rate, 5xx rate, p95/p99 HTTP
latency, and Prisma/pool query latency. Do not expose exporter ports publicly;
restrict Prometheus, Grafana, and Alertmanager to the operations network.

The Compose defaults are local-development placeholders, not production
credentials or working alert destinations. Set `ALERTMANAGER_SLACK_WEBHOOK_URL`
and `PAGERDUTY_ROUTING_KEY` to real values in an untracked `.env` or secret
injector. Critical alerts route to PagerDuty and Slack; warning alerts route
to Slack. Set `GRAFANA_ADMIN_PASSWORD` to a strong private value and set
`PG_EXPORTER_DATA_SOURCE_NAME` to a monitoring-only PostgreSQL account with
read access to the statistics views. Never commit any of these values.

## Rules and response

`infra/monitoring/alerts.yml` includes alerts for an unavailable backend or
database exporter, sustained HTTP 5xx rate, high p99 request latency, waiting
database-pool clients, host CPU/memory/filesystem pressure, and network
interface errors. Rules use `for`, minimum traffic, grouping, and repeat
intervals to reduce alert fatigue. Each service alert links to the relevant
incident/database runbook. Tune thresholds against production baselines
before paging; host metrics require a Linux host with proc/sys/root mounts
available to Node Exporter.

For Kubernetes/Prometheus Operator deployments, retain the ServiceMonitor
and import the rule expressions into a `PrometheusRule` managed by the
platform’s monitoring stack. Configure equivalent Slack/PagerDuty receivers
in the operator-managed Alertmanager rather than deploying a second
Alertmanager. See [incident response](INCIDENT_RESPONSE.md) for triage and
escalation.
