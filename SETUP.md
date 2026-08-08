# TipForge Backend Setup Guide

## Prerequisites

- Node.js 20+
- pnpm 9+
- PostgreSQL 16+
- Redis 7+

## Quick Start with Docker Compose

The easiest way to get started is using Docker Compose:

```bash
# Start all services
docker-compose up -d

# Run migrations
docker-compose exec backend pnpm prisma migrate deploy

# Verify it's running
curl http://localhost:3000/health
```

## Manual Setup

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Environment Configuration

Copy the example environment file:

```bash
cp .env.example .env.local
```

Configure the following variables:

- `DATABASE_URL`: PostgreSQL connection string
- `REDIS_URL`: Redis connection string
- `STELLAR_NETWORK`: Set to `testnet` for development
- `STELLAR_HORIZON_URL`: Stellar horizon endpoint
- `STELLAR_SERVER_SECRET_KEY`: Your server's Stellar secret key
- `JWT_SECRET`: JWT signing secret (change in production)

### 3. Database Setup

Initialize Prisma:

```bash
pnpm prisma:generate
```

Run migrations:

```bash
pnpm prisma:migrate dev
```

### 4. Start Development Server

```bash
pnpm dev
```

The server will start on http://localhost:3000

## Testing

### Run Unit Tests

```bash
pnpm test
```

### Run Tests in Watch Mode

```bash
pnpm test:watch
```

### Run Integration Tests

```bash
pnpm test -- integration
```

### Generate Coverage Report

```bash
pnpm test -- --coverage
```

## Linting and Formatting

### Lint Code

```bash
pnpm lint
```

### Fix Linting Issues

```bash
pnpm lint -- --fix
```

### Format Code

```bash
pnpm format
```

## Building for Production

### Build TypeScript

```bash
pnpm build
```

### Start Production Build

```bash
pnpm start
```

## Docker Setup

### Build Docker Image

```bash
docker build -t tipforge-backend:latest .
```

### Run Docker Container

```bash
docker run -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:pass@host:5432/db" \
  -e REDIS_URL="redis://host:6379" \
  tipforge-backend:latest
```

## Database Migrations

### Create New Migration

```bash
pnpm prisma migrate dev --name migration_name
```

### Reset Database (Development Only)

```bash
pnpm prisma migrate reset
```

### View Database in Prisma Studio

```bash
pnpm prisma:studio
```

## Stellar Integration

### Set Up Stellar Testnet Account

1. Visit https://laboratory.stellar.org
2. Create a new account or use your existing keypair
3. Add your secret key to `.env.local`:

```
STELLAR_SERVER_SECRET_KEY=your_secret_key_here
```

4. Get testnet lumens from https://friendbot.stellar.org

### Test Wallet Linking

```bash
curl -X POST http://localhost:3000/api/v1/wallet/nonce \
  -H "Authorization: Bearer your_jwt_token" \
  -H "Content-Type: application/json" \
  -d '{"publicKey":"GBBD47AB2EB00E041B61C1B7AD184E687E24658D52EDFFDD118F5E6221D60EFF"}'
```

## API Documentation

See [API.md](./API.md) for endpoint documentation.

## Troubleshooting

### Database Connection Error

Ensure PostgreSQL is running and the `DATABASE_URL` is correct:

```bash
psql $DATABASE_URL
```

### Redis Connection Error

Ensure Redis is running on the configured port:

```bash
redis-cli ping
```

### Prisma Client Error

Regenerate the Prisma client:

```bash
pnpm prisma:generate
```

### Port Already in Use

Change the PORT in `.env.local`:

```
PORT=3001
```

## Development Workflow

1. Create a feature branch
2. Make your changes
3. Run tests: `pnpm test`
4. Run linter: `pnpm lint`
5. Commit with descriptive messages
6. Push and create a pull request

## Performance Tips

- Use database indexes for frequently queried fields
- Enable Redis caching for read-heavy operations
- Monitor query performance with `EXPLAIN ANALYZE`
- Use pagination for large result sets
- Keep environment variables in `.env.local` (never committed)

## Security Checklist

- [ ] Change JWT_SECRET in production
- [ ] Use strong database passwords
- [ ] Enable HTTPS in production
- [ ] Rotate API keys regularly
- [ ] Use environment variables for secrets
- [ ] Enable rate limiting
- [ ] Validate all user inputs
- [ ] Use CORS carefully
- [ ] Keep dependencies updated
- [ ] Monitor error logs for suspicious activity

## Support

For issues or questions:

1. Check existing documentation
2. Review error logs
3. Check GitHub issues
4. Contact the development team
