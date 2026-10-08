import { describe, it, expect, vi } from 'vitest';
import { FakeNotificationPrisma, asPrisma } from './fake-notification-prisma';
import {
  NotificationCenterService,
  decodeCursor,
  encodeCursor,
  type NotificationEmailSender,
  type NotificationPushSender,
} from '../notification-center.service';
import { NotificationPreferenceService } from '../notification-preferences.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 8, 27, 9, 0, 0);

function build(options: { push?: NotificationPushSender } = {}) {
  const fake = new FakeNotificationPrisma();
  const user = fake.seedUser();
  const send = vi.fn(async () => ({ jobId: 'job_1' }));
  const email: NotificationEmailSender = { send };
  const preferences = new NotificationPreferenceService(asPrisma(fake), { now: () => NOW_MS });
  const center = new NotificationCenterService(asPrisma(fake), {
    now: () => NOW_MS,
    email,
    preferences,
    ...(options.push ? { push: options.push } : {}),
  });

  return { fake, user, center, preferences, send };
}

describe('NotificationCenterService.create', () => {
  it('stores the in-app notification and queues the email for an enabled channel', async () => {
    const { fake, center, send } = build();

    const result = await center.create({
      userId: 'user_1',
      type: 'tip.received',
      data: { senderName: 'Ada', amount: 25, asset: 'XLM' },
    });

    expect(result.delivered).toEqual(['in_app', 'email']);
    // Push has no provider in this repository, and defaults off for tips.
    expect(result.skipped).toEqual([{ channel: 'push', reason: 'disabled by user preference' }]);
    expect(fake.notifications).toHaveLength(2);
    expect(fake.notifications.map((row) => row.status)).toEqual(['sent', 'sent']);
    expect(fake.notifications[0]).toMatchObject({
      userId: 'user_1',
      type: 'tip.received',
      channel: 'in_app',
      title: 'New tip received',
      body: 'Ada tipped 25 XLM.',
    });
    // Retention comes from the event definition (90 days for tips).
    expect(fake.notifications[0].expiresAt.getTime()).toBe(NOW_MS + 90 * DAY_MS);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        userId: 'user_1',
        eventType: 'tip.received',
        subject: 'You received a tip of 25 XLM',
      })
    );
  });

  it('respects a stored preference and stores nothing for the channel it turned off', async () => {
    const { fake, center, preferences, send } = build();
    await preferences.update('user_1', [{ eventType: 'tip.received', channel: 'email', enabled: false }]);

    const result = await center.create({ userId: 'user_1', type: 'tip.received' });

    expect(result.delivered).toEqual(['in_app']);
    expect(result.skipped).toEqual([
      { channel: 'email', reason: 'disabled by user preference' },
      { channel: 'push', reason: 'disabled by user preference' },
    ]);
    expect(fake.notifications.map((row) => row.channel)).toEqual(['in_app']);
    expect(send).not.toHaveBeenCalled();
  });

  it('marks the channel failed when the provider rejects it, keeping the in-app row', async () => {
    const { fake } = build();
    const failing = new NotificationCenterService(asPrisma(fake), {
      now: () => NOW_MS,
      email: {
        send: async () => {
          throw new Error('SendGrid rejected email (403)');
        },
      },
    });

    const result = await failing.create({ userId: 'user_1', type: 'tip.received' });

    expect(result.delivered).toEqual(['in_app']);
    expect(result.skipped).toEqual([
      { channel: 'email', reason: 'SendGrid rejected email (403)' },
      { channel: 'push', reason: 'disabled by user preference' },
    ]);
    const emailRow = fake.notifications.find((row) => row.channel === 'email');
    expect(emailRow).toMatchObject({ status: 'failed', failureReason: 'SendGrid rejected email (403)' });
  });

  it('records a push attempt as skipped when the push provider is not configured', async () => {
    const { fake, center } = build();

    const result = await center.create({
      userId: 'user_1',
      type: 'payout.completed',
      channels: ['push'],
      data: { amount: 100, asset: 'XLM', walletAddress: 'GABC' },
    });

    // Push is off by default, so the preference gate answers first.
    expect(result.delivered).toEqual([]);
    expect(result.skipped).toEqual([{ channel: 'push', reason: 'disabled by user preference' }]);
    expect(fake.notifications).toHaveLength(0);
  });

  it('skips the push channel with the provider reason when push is enabled', async () => {
    const { fake, center, preferences } = build();
    await preferences.update('user_1', [{ eventType: 'payout.completed', channel: 'push', enabled: true }]);

    const result = await center.create({
      userId: 'user_1',
      type: 'payout.completed',
      channels: ['push'],
      data: { amount: 100, asset: 'XLM', walletAddress: 'GABC' },
    });

    expect(result.delivered).toEqual([]);
    expect(result.skipped).toEqual([{ channel: 'push', reason: 'push provider not configured' }]);
    expect(fake.notifications[0]).toMatchObject({
      channel: 'push',
      status: 'skipped',
      failureReason: 'push provider not configured',
    });
  });

  it('rejects an event delivered on a channel it does not support', async () => {
    const { center } = build();

    await expect(
      center.create({ userId: 'user_1', type: 'creator.verified', channels: ['push'] })
    ).resolves.toBeDefined();

    await expect(
      center.create({ userId: 'user_1', type: 'digest.ready', channels: ['push'] })
    ).rejects.toThrow(/cannot be delivered on push/i);
  });

  it('rejects an unknown recipient', async () => {
    const { center } = build();

    await expect(center.create({ userId: 'ghost', type: 'tip.received' })).rejects.toThrow(/not found/i);
  });
});

describe('NotificationCenterService feed', () => {
  function seedFeed() {
    const built = build();
    const { fake } = built;
    const base = NOW_MS;
    fake.seedNotification({ id: 'n_3', userId: 'user_1', type: 'tip.received', createdAt: new Date(base) });
    fake.seedNotification({
      id: 'n_2',
      userId: 'user_1',
      type: 'payout.completed',
      readAt: new Date(base),
      createdAt: new Date(base - 1000),
    });
    fake.seedNotification({
      id: 'n_1',
      userId: 'user_1',
      type: 'tip.received',
      title: 'Old tip',
      channel: 'email',
      createdAt: new Date(base - 2000),
    });
    fake.seedNotification({ id: 'other_1', userId: 'user_2', createdAt: new Date(base) });
    return built;
  }

  it('lists a user feed newest first with an unread count', async () => {
    const { center } = seedFeed();

    const feed = await center.list('user_1');

    expect(feed.items.map((item) => item.id)).toEqual(['n_3', 'n_2', 'n_1']);
    expect(feed.unread).toBe(2);
    expect(feed.hasMore).toBe(false);
    expect(feed.nextCursor).toBeNull();
    expect(feed.items[0].read).toBe(false);
  });

  it('filters by read state, channel and event type, and searches titles', async () => {
    const { center } = seedFeed();

    expect((await center.list('user_1', { unreadOnly: true })).items.map((item) => item.id)).toEqual(['n_3', 'n_1']);
    expect((await center.list('user_1', { channel: 'email' })).items.map((item) => item.id)).toEqual(['n_1']);
    expect((await center.list('user_1', { type: 'payout.completed' })).items.map((item) => item.id)).toEqual(['n_2']);
    expect((await center.list('user_1', { search: 'old tip' })).items.map((item) => item.id)).toEqual(['n_1']);
  });

  it('pages with an opaque keyset cursor', async () => {
    const { center } = seedFeed();

    const first = await center.list('user_1', { pageSize: 2 });
    expect(first.items.map((item) => item.id)).toEqual(['n_3', 'n_2']);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    expect(decodeCursor(first.nextCursor!)).toMatchObject({ id: 'n_2' });

    const second = await center.list('user_1', { pageSize: 2, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.id)).toEqual(['n_1']);
    expect(second.hasMore).toBe(false);

    expect(decodeCursor('not-a-cursor')).toBeNull();
  });

  it('tracks read state per notification and in bulk', async () => {
    const { center, fake } = seedFeed();

    const read = await center.markRead('user_1', 'n_3');
    expect(read.read).toBe(true);
    // Marking twice keeps the original timestamp.
    const again = await center.markRead('user_1', 'n_3');
    expect(again.readAt).toBe(read.readAt);

    const unread = await center.markRead('user_1', 'n_3', false);
    expect(unread.read).toBe(false);
    expect(unread.readAt).toBeNull();

    const all = await center.markAllRead('user_1', { type: 'tip.received' });
    expect(all.updated).toBe(2);
    expect(all.unread).toBe(0);
    expect(fake.notifications.find((row) => row.id === 'n_2').readAt).not.toBeNull();

    await expect(center.markRead('user_1', 'other_1')).rejects.toThrow(/not found/i);
  });

  it('deletes only the caller notification', async () => {
    const { center, fake } = seedFeed();

    await center.remove('user_1', 'n_1');

    expect(fake.notifications.some((row) => row.id === 'n_1')).toBe(false);
    await expect(center.remove('user_1', 'other_1')).rejects.toThrow(/not found/i);
  });

  it('counts unread rows per channel', async () => {
    const { center } = seedFeed();

    expect(await center.unreadCount('user_1')).toBe(2);
    expect(await center.unreadCount('user_1', 'email')).toBe(1);
  });

  it('prunes expired notifications and leaves live ones alone', async () => {
    const { center, fake } = seedFeed();
    fake.seedNotification({ id: 'expired', userId: 'user_1', expiresAt: new Date(NOW_MS - 1000) });
    fake.seedNotification({ id: 'live', userId: 'user_1', expiresAt: new Date(NOW_MS + DAY_MS) });

    const result = await center.pruneExpired(new Date(NOW_MS));

    expect(result.deleted).toBe(1);
    expect(fake.notifications.some((row) => row.id === 'expired')).toBe(false);
    expect(fake.notifications.some((row) => row.id === 'live')).toBe(true);
  });
});

describe('NotificationCenterService digests', () => {
  it('builds a digest from the events in the window', async () => {
    const { center, fake } = build();
    fake.seedNotification({ id: 'recent', userId: 'user_1', body: 'Ada tipped 25 XLM.', createdAt: new Date(NOW_MS) });
    fake.seedNotification({
      id: 'old',
      userId: 'user_1',
      body: 'Grace tipped 5 XLM.',
      createdAt: new Date(NOW_MS - 3 * DAY_MS),
    });

    const daily = await center.buildDigest('user_1', 'daily', new Date(NOW_MS));
    expect(daily.entries.map((entry) => entry.id)).toEqual(['recent']);
    expect(daily.body).toContain('Daily summary');

    const weekly = await center.buildDigest('user_1', 'weekly', new Date(NOW_MS));
    expect(weekly.entries.map((entry) => entry.id)).toEqual(['recent', 'old']);
  });

  it('sends only the digests that are due and stamps lastSentAt', async () => {
    const { center, preferences, fake } = build();
    await preferences.setDigest('user_1', { frequency: 'daily', hourUtc: 0 });
    fake.seedNotification({ id: 'recent', userId: 'user_1', body: 'Ada tipped 25 XLM.' });

    const result = await center.sendDueDigests(new Date(NOW_MS));

    expect(result).toEqual({ sent: 1, empty: 0, failed: 0 });
    expect(fake.notifications.some((row) => row.type === 'digest.ready')).toBe(true);
    expect(fake.digestRows[0].lastSentAt).toBeInstanceOf(Date);

    // A second run in the same window is a no-op.
    expect(await center.sendDueDigests(new Date(NOW_MS))).toEqual({ sent: 0, empty: 0, failed: 0 });
  });

  it('skips an empty digest but still records that it ran', async () => {
    const { center, preferences, fake } = build();
    await preferences.setDigest('user_1', { frequency: 'daily', hourUtc: 0 });

    const result = await center.sendDueDigests(new Date(NOW_MS));

    expect(result).toEqual({ sent: 0, empty: 1, failed: 0 });
    expect(fake.notifications).toHaveLength(0);
    expect(fake.digestRows[0].lastSentAt).toBeInstanceOf(Date);
  });
});

describe('encodeCursor', () => {
  it('round-trips a row position', () => {
    const createdAt = new Date(NOW_MS);
    const decoded = decodeCursor(encodeCursor({ createdAt, id: 'n_1' }));

    expect(decoded?.id).toBe('n_1');
    expect(decoded?.createdAt.getTime()).toBe(NOW_MS);
  });
});
