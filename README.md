# Dorisio Backend

Production-ready payment orchestration engine for Dorisio, built with Fastify, Stellar integration, and enterprise-grade infrastructure for managing tips, payouts, and creator analytics.

## Architecture Overview

### Core Components

- **Payment Engine**: Handles tip creation, Stellar transaction submission, and payout orchestration
- **Background Job Queues**: BullMQ + Redis for async processing (Stellar confirmation polling, webhook dispatch)
- **Webhook System**: Event-driven architecture with HMAC-SHA256 signing and exponential backoff retries
- **Analytics Layer**: Real-time creator earnings, supporter tracking, and tip frequency analysis
- **Admin/Moderation**: Wallet flagging, account freezing, and compliance controls
- **Metrics & Monitoring**: Prometheus endpoints for production observability

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 14+
- Redis 6+

### Installation

```bash
# Install dependencies (use pnpm as specified in package.json)
pnpm install

# Set up environment variables
cp .env.example .env

# Run database migrations
pnpm run prisma:migrate

# Start development server
pnpm run dev
```

Server runs on `http://localhost:3000`

## Development

### Build & Test

```bash
pnpm run build        # Compile TypeScript
pnpm run test         # Run test suite
pnpm run test:watch   # Run tests in watch mode
pnpm run lint         # Check code style
pnpm run format       # Format code with Prettier
```

### Database

```bash
pnpm run prisma:migrate   # Run pending migrations
pnpm run prisma:generate  # Generate Prisma client
pnpm run prisma:studio    # Open Prisma Studio UI
```

## Production Infrastructure

### 1. Background Job Queues (BullMQ + Redis)

Asynchronous job processing for long-running operations:

- **Stellar Confirmation Polling**: Polls blockchain for transaction confirmation with exponential backoff (5 retries, 2-32s delays)
- **Webhook Dispatch**: Delivers webhook events with retry logic and delivery tracking

**Files:** `src/lib/queue.ts`, `src/lib/workers/*`

### 2. Webhook System

Event-driven integration for creators' external systems:

**Features:**

- Event filtering (tip.created, tip.confirmed, tip.failed, payout.completed)
- HMAC-SHA256 signature verification
- Exponential backoff retries (max 5 attempts)
- Delivery history tracking

**Endpoints:**

- `POST /api/v1/webhooks` - Register webhook
- `GET /api/v1/webhooks` - List webhooks
- `DELETE /api/v1/webhooks/:id` - Delete webhook
- `GET /api/v1/webhooks/:id/history` - Delivery history

**Files:** `src/domains/webhooks/*`

### 3. Analytics Endpoints

Real-time insights into creator earnings and supporter engagement:

**Endpoints:**

- `GET /api/v1/analytics/summary` - Total earnings, tip count, unique supporters, average tip
- `GET /api/v1/analytics/earnings?days=30` - Daily earnings breakdown (customizable period)
- `GET /api/v1/analytics/supporters?limit=10` - Top supporters by amount (max 100)
- `GET /api/v1/analytics/frequency?days=30` - Tip frequency statistics (avg/min/max/daily)

**Features:**

- Queries use Prisma aggregations (no raw SQL)
- Per-creator data isolation
- Configurable time windows (1-365 days)

**Files:** `src/domains/analytics/*`

### 4. Admin & Moderation Layer

Compliance and fraud prevention controls:

**Endpoints:**

- `POST /api/v1/admin/wallets/:address/flag` - Flag wallet as suspicious (severity: low/medium/high/critical)
- `POST /api/v1/admin/wallets/flags/:flagId/resolve` - Resolve wallet flag
- `POST /api/v1/admin/creators/:creatorId/freeze` - Freeze account pending review (optional duration in hours)
- `POST /api/v1/admin/creators/freezes/:freezeId/resolve` - Unfreeze account
- `GET /api/v1/admin/moderation` - View moderation queue (active flags and freezes)

**Features:**

- Admin-only access (role='ADMIN')
- Flagged wallets prevent payment processing
- Frozen accounts block tip intake
- Severity levels and reason tracking

**Files:** `src/domains/admin/*`

### 5. Metrics & Monitoring

Prometheus-compatible metrics for production monitoring:

**Endpoints:**

- `GET /metrics` - Prometheus text format (scrape this for monitoring)
- `GET /metrics/json` - JSON format for alternative tooling

**Tracked Metrics:**

- **Counters**: Total tips, payments, webhooks, auth attempts
- **Gauges**: Active tips, confirmed tips, total users, total creators, queue length, total earnings
- **Histograms**: Request latency, database query latency, webhook delivery latency

**Files:** `src/lib/metrics.ts`, `src/routes/metrics.routes.ts`

### 6. Rate Limiting

Every route is rate limited by class (`public` 100/min, `authenticated` 300/min
per user, `sensitive` 10/min). Health probes are exempt. Classes, limits and
exemptions are configured centrally in `src/config/rate-limit.ts`, and 429
responses carry `X-RateLimit-*` and `Retry-After` headers. Set `TRUST_PROXY`
when running behind a reverse proxy.

See [docs/RATE_LIMITING.md](docs/RATE_LIMITING.md).

**Files:** `src/config/rate-limit.ts`, `src/plugins/rateLimit.ts`

## API Routes

### Authentication

- `POST /api/v1/auth/register` - Create account
- `POST /api/v1/auth/login` - Get JWT token
- `POST /api/v1/auth/refresh` - Refresh token
- `POST /api/v1/auth/wallet` - Wallet authentication

### Payments

- `POST /api/v1/tips` - Create tip (async → Stellar submission → confirmation polling)
- `GET /api/v1/tips/:id` - Get tip status
- `POST /api/v1/payments/confirm` - Confirm payment via hash

### Creators

- `POST /api/v1/creators` - Register creator
- `GET /api/v1/creators/:id` - Get creator profile
- `POST /api/v1/creators/payout` - Request payout
- `GET /api/v1/creators/payout/history` - View past payouts

### Webhooks

- See **Webhook System** section above

### Analytics

- See **Analytics Endpoints** section above

### Admin

- See **Admin & Moderation Layer** section above

### Monitoring

- `GET /health` - Enhanced health check (DB status, uptime, memory usage, Node.js version)
- `GET /metrics` - Prometheus metrics
- `GET /metrics/json` - JSON metrics

## Testing

Comprehensive test suite included. See `INFRASTRUCTURE_TEST_PLAN.md` for detailed test scenarios covering:

- BullMQ queue initialization and job processing
- Stellar confirmation polling with retry logic
- Webhook dispatch and delivery retries
- Analytics query accuracy and data isolation
- Admin operations and access control
- Metrics endpoint format validation

Run tests with:

```bash
npm run test
```

## Environment Variables

See `.env.example` for complete configuration. Key variables:

```
# Server
NODE_ENV=development|staging|production
LOG_LEVEL=debug|info|warn|error
PORT=3000

# Database
DATABASE_URL=postgresql://user:pass@host:5432/dorisio

# Stellar
STELLAR_NETWORK=testnet|mainnet
HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_SECRET_KEY=...

# Redis (for BullMQ queues)
REDIS_URL=redis://localhost:6379

# JWT
JWT_SECRET=...
JWT_EXPIRE=24h

# Admin
ADMIN_WALLET_ADDRESS=...

# Reverse proxy / rate limiting (see docs/RATE_LIMITING.md)
TRUST_PROXY=false|<hop count>|<proxy IPs/CIDRs>
RATE_LIMIT_ENABLED=true
RATE_LIMIT_STORE=memory|redis
```

## Deployment

### Docker

```bash
docker build -t dorisio-backend .
docker run -p 3000:3000 --env-file .env dorisio-backend
```

### Docker Compose

```bash
docker-compose up -d
```

Includes PostgreSQL and Redis services.

## Monitoring in Production

### Prometheus Scrape Config

```yaml
scrape_configs:
  - job_name: 'dorisio-backend'
    static_configs:
      - targets: ['localhost:3000']
    metrics_path: '/metrics'
    scrape_interval: 30s
```

### Key Metrics to Alert On

- `dorisio_queue_length > 1000` - Job queue backlog
- `dorisio_active_tips > 10000` - High pending confirmation load
- `dorisio_request_duration_seconds (p99) > 5` - Slow requests
- `dorisio_webhooks_total{status="failed"} increasing` - Webhook failures

## Troubleshooting

### Tips stuck in "pending" status

- Check Redis connection and BullMQ worker logs
- Verify Stellar network connectivity and RPC endpoint
- Inspect `stellar-confirmation` queue in BullMQ UI

### Webhooks not delivering

- Check webhook URL is reachable and returning 2xx status
- Verify HMAC-SHA256 signature validation on receiver end
- Review delivery history: `GET /api/v1/webhooks/:id/history`
- Check `webhook-dispatch` queue status

### High memory usage

- Monitor `/metrics/json` memory_usage_mb gauge
- Check for long-running queries in analytics endpoints
- Review number of active database connections

## Contributing

See `CONTRIBUTING.md` for guidelines on:

- Branch naming conventions
- Commit message format
- Pull request process
- Code review checklist

## Security

See `SECURITY.md` for:

- Vulnerability reporting process
- Security best practices
- Wallet key management
- Payment processing security

## License

MIT. See `LICENSE` for details.


## Platform additions (Issues #27–#30)

- **Jobs / workers** — see [`docs/JOBS.md`](docs/JOBS.md)
- **CORS & security headers** — see [`docs/CORS.md`](docs/CORS.md)
- **Database indexes** — see [`docs/INDEXING.md`](docs/INDEXING.md)
- **Query performance** — see [`docs/QUERY_PERFORMANCE.md`](docs/QUERY_PERFORMANCE.md)
  (`GET /diagnostics/queries/performance`, `POST /diagnostics/queries/explain`)
- **GraphQL** — see [`docs/GRAPHQL.md`](docs/GRAPHQL.md) (`POST /graphql`)
