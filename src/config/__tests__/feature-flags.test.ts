import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FeatureEvaluationMetrics,
  FeatureFlagService,
  InMemoryFeatureFlagStore,
  createFeatureFlagSnapshot,
  requireFeature,
  stablePercentageBucket,
} from '../feature-flags';

const snapshot = createFeatureFlagSnapshot(
  {
    disabled: { enabled: false, allowUsers: ['u1'] },
    targeted: {
      enabled: true,
      allow: { users: ['u1'], roles: ['admin'] },
      deny: { users: ['u1'], roles: ['suspended'] },
    },
    rollout: { percentage: 50 },
    booleanOff: { enabled: false },
  },
  'v1',
  '2026-01-01T00:00:00.000Z'
);

describe('FeatureFlagService', () => {
  let metrics: FeatureEvaluationMetrics;
  let service: FeatureFlagService;

  beforeEach(() => {
    metrics = new FeatureEvaluationMetrics();
    service = new FeatureFlagService(snapshot, { metrics });
  });

  it('preserves the stable bucket for the same user and flag', () => {
    expect(stablePercentageBucket('rollout', 'user-1')).toBe(
      stablePercentageBucket('rollout', 'user-1')
    );
    expect(stablePercentageBucket('rollout', 'user-1')).toBeGreaterThanOrEqual(0);
    expect(stablePercentageBucket('rollout', 'user-1')).toBeLessThan(100);
  });

  it('applies emergency disable before allow targeting', () => {
    expect(service.evaluate('disabled', { userId: 'u1' })).toMatchObject({
      enabled: false,
      reason: 'disabled',
      snapshotVersion: 'v1',
    });
  });

  it('gives deny precedence over allow for users and roles', () => {
    expect(service.evaluate('targeted', { userId: 'u1' })).toMatchObject({
      enabled: false,
      reason: 'deny_user',
    });
    expect(service.evaluate('targeted', { role: 'suspended' })).toMatchObject({
      enabled: false,
      reason: 'deny_role',
    });
    expect(service.evaluate('targeted', { role: 'admin' })).toMatchObject({
      enabled: true,
      reason: 'allow_role',
    });
  });

  it('fails percentage evaluation closed without a user context', () => {
    expect(service.evaluate('rollout')).toMatchObject({
      enabled: false,
      reason: 'missing_context',
    });
  });

  it('records low-cardinality evaluation metrics without identifiers', () => {
    service.evaluate('rollout', { userId: 'private-user-id' });
    service.evaluate('booleanOff');
    const result = metrics.snapshot();
    expect(result.total).toBe(2);
    expect(result.byFlag.rollout.evaluations).toBe(1);
    expect(JSON.stringify(result)).not.toContain('private-user-id');
  });

  it('atomically replaces a snapshot for instant rollback', () => {
    const store = new InMemoryFeatureFlagStore(snapshot);
    const stored = new FeatureFlagService(store);
    expect(stored.isEnabled('booleanOff')).toBe(false);
    stored.replace(createFeatureFlagSnapshot({ booleanOff: { enabled: true } }, 'rollback-v2'));
    expect(stored.evaluate('booleanOff')).toMatchObject({
      enabled: true,
      snapshotVersion: 'rollback-v2',
    });
  });
});

describe('requireFeature Fastify helper', () => {
  let app: ReturnType<typeof Fastify>;
  afterEach(async () => {
    await app?.close();
  });

  it('protects a route with a standard forbidden response', async () => {
    const service = new FeatureFlagService(createFeatureFlagSnapshot({ beta: { enabled: false } }));
    app = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) => {
      reply
        .code((error as { statusCode?: number }).statusCode ?? 500)
        .send({ code: (error as { code?: string }).code });
    });
    app.get('/beta', { preHandler: requireFeature(service, 'beta') }, async () => ({ ok: true }));
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/beta' });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: 'FORBIDDEN' });
  });
});
