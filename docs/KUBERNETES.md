# Kubernetes deployment

`infra/kubernetes` is a production deployment baseline for the backend. It
uses an Argo Rollouts blue-green strategy, three replicas, readiness/liveness
probes, CPU/memory requests and limits, an HPA, a disruption budget, a PVC for
application data, and a Prometheus Operator `ServiceMonitor`.

Create real secrets through the deployment platform, then render and inspect
the manifests before applying them:

```bash
kubectl apply -k infra/kubernetes
kubectl argo rollouts get rollout dorisio-backend -n dorisio
kubectl argo rollouts promote dorisio-backend -n dorisio
```

PostgreSQL and Redis should use managed, replicated services in production;
the application PVC is for backend-owned durable data and is not a substitute
for database backups. The rollout's preview service is the blue/green test
target. Promote only after smoke tests and metrics show healthy traffic.
