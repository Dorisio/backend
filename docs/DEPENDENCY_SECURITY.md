# Dependency security and SBOM

Dependency security is enforced in `.github/workflows/security.yml` and is
also available as a local check:

```bash
pnpm install --frozen-lockfile
pnpm audit --prod --audit-level high
```

The workflow runs on pushes and pull requests, and every Monday from the
scheduled workflow. Pull requests that introduce a high or critical advisory
are rejected by both `pnpm audit` and GitHub's dependency review. Dependabot
opens weekly update pull requests for the versions recorded in
`pnpm-lock.yaml`; production and development updates are grouped separately
so security updates remain easy to review.

Every workflow run publishes a CycloneDX JSON SBOM as the `dependency-sbom`
artifact. The artifact is retained for 30 days and is generated from the
checked-out dependency tree, so it can be tied to the exact commit being
deployed.

## Update policy

- Keep direct dependency ranges and `pnpm-lock.yaml` in the same change.
- Review major-version updates manually for API, migration, and runtime
  compatibility.
- Do not suppress an advisory without a documented reason, affected package,
  mitigation, and planned removal date.
- A failing scheduled audit is an actionable security alert: triage it in the
  dependency update PR or open a security issue using the private reporting
  process in `SECURITY.md`.
