import { describe, it, expect } from 'vitest';
import { FakeNotificationPrisma, asPrisma } from './fake-notification-prisma';
import { NotificationPreferenceService } from '../notification-preferences.service';
import { NOTIFICATION_EVENTS, channelsForEvent } from '../notification.types';

const DAY_MS = 24 * 60 * 60 * 1000;

function build(nowMs = Date.UTC(2026, 8, 27, 9, 0, 0)) {
  const fake = new FakeNotificationPrisma();
  const user = fake.seedUser();
  const service = new NotificationPreferenceService(asPrisma(fake), { now: () => nowMs });
  return { fake, user, service, nowMs };
}

describe('NotificationPreferenceService', () => {
  it('resolves every event/channel pair from the defaults', async () => {
    const { service } = build();

    const views = await service.list('user_1');

    const expectedPairs = NOTIFICATION_EVENTS.flatMap((type) =>
      channelsForEvent(type).map((channel) => `${type}:${channel}`)
    );
    expect(views.map((view) => `${view.eventType}:${view.channel}`)).toEqual(expectedPairs);
    expect(views.every((view) => view.source === 'default')).toBe(true);

    // Defaults are per type: tips email by default, push never does.
    const tipEmail = views.find((view) => view.eventType === 'tip.received' && view.channel === 'email');
    expect(tipEmail?.enabled).toBe(true);
    const tipPush = views.find((view) => view.eventType === 'tip.received' && view.channel === 'push');
    expect(tipPush?.enabled).toBe(false);
  });

  it('reports whether a channel is enabled and which ones an event may use', async () => {
    const { service } = build();

    expect(await service.isEnabled('user_1', 'tip.received', 'email')).toBe(true);
    expect(await service.isEnabled('user_1', 'tip.received', 'push')).toBe(false);
    // A channel the event never uses is always off, even if a row says otherwise.
    expect(await service.isEnabled('user_1', 'report.resolved', 'push')).toBe(false);
    expect(await service.enabledChannels('user_1', 'report.resolved')).toEqual(['in_app', 'email']);
  });

  it('lets a stored override win and mirrors it into the legacy column', async () => {
    const { fake, service } = build();

    await service.update('user_1', [{ eventType: 'tip.received', channel: 'email', enabled: false }]);

    expect(await service.isEnabled('user_1', 'tip.received', 'email')).toBe(false);
    expect(await service.enabledChannels('user_1', 'tip.received')).toEqual(['in_app']);
    // The email worker reads the JSONB column, so it must agree with the table.
    expect(fake.users[0].notificationPreferences).toEqual({ 'tip.received': { email: false } });

    const views = await service.list('user_1');
    const overridden = views.find((view) => view.eventType === 'tip.received' && view.channel === 'email');
    expect(overridden).toMatchObject({ enabled: false, source: 'stored' });
  });

  it('ignores a preference for a channel the event never uses', async () => {
    const { fake, service } = build();

    await service.update('user_1', [{ eventType: 'report.resolved', channel: 'push', enabled: true }]);

    expect(fake.preferenceRows).toHaveLength(0);
    expect(await service.isEnabled('user_1', 'report.resolved', 'push')).toBe(false);
  });

  it('honours a legacy JSONB value when the table has no row', async () => {
    const fake = new FakeNotificationPrisma();
    fake.seedUser({ notificationPreferences: { 'tip.received': { email: false } } });
    const service = new NotificationPreferenceService(asPrisma(fake));

    expect(await service.isEnabled('user_1', 'tip.received', 'email')).toBe(false);
    // Unknown channels in the legacy column are ignored instead of stored.
    const views = await service.list('user_1');
    expect(views.find((view) => view.eventType === 'tip.received' && view.channel === 'email')).toMatchObject({
      enabled: false,
      source: 'legacy',
    });
  });

  it('resets every override back to the defaults', async () => {
    const { fake, service } = build();
    await service.update('user_1', [{ eventType: 'tip.received', channel: 'email', enabled: false }]);

    const views = await service.reset('user_1');

    expect(fake.preferenceRows).toHaveLength(0);
    expect(fake.users[0].notificationPreferences).toEqual({});
    expect(views.every((view) => view.source === 'default')).toBe(true);
  });

  it('rejects preferences for a missing user', async () => {
    const { service } = build();

    await expect(
      service.update('user_missing', [{ eventType: 'tip.received', channel: 'email', enabled: true }])
    ).rejects.toThrow(/not found/i);
  });

  it('stores digest settings and defaults to off', async () => {
    const { service } = build();

    expect(await service.getDigest('user_1')).toEqual({
      frequency: 'off',
      channel: 'email',
      hourUtc: 8,
      lastSentAt: null,
    });

    const updated = await service.setDigest('user_1', { frequency: 'weekly', hourUtc: 18 });
    expect(updated).toMatchObject({ frequency: 'weekly', channel: 'email', hourUtc: 18 });
    expect(await service.getDigest('user_1')).toMatchObject({ frequency: 'weekly' });
  });

  it('selects the digests that are due by frequency and delivery hour', async () => {
    const nowMs = Date.UTC(2026, 8, 27, 9, 0, 0);
    const { fake, service } = build(nowMs);

    const daily = fake.seedUser({ id: 'daily_user' });
    const weekly = fake.seedUser({ id: 'weekly_user' });
    fake.seedUser({ id: 'off_user' });
    fake.seedUser({ id: 'late_user' });

    await service.setDigest(daily.id, { frequency: 'daily', hourUtc: 8 });
    await service.setDigest(weekly.id, { frequency: 'weekly', hourUtc: 8 });
    await service.setDigest('off_user', { frequency: 'off' });
    await service.setDigest('late_user', { frequency: 'daily', hourUtc: 22 });

    expect(await service.dueDigests(new Date(nowMs))).toEqual([
      { userId: 'daily_user', frequency: 'daily' },
      { userId: 'weekly_user', frequency: 'weekly' },
    ]);

    // A digest already sent inside the window is not due again.
    const weeklyRow = fake.digestRows.find((row) => row.userId === 'weekly_user');
    weeklyRow.lastSentAt = new Date(nowMs - 2 * DAY_MS);
    expect(await service.dueDigests(new Date(nowMs))).toEqual([{ userId: 'daily_user', frequency: 'daily' }]);

    // A daily digest sent a day ago is not due yet; a weekly one from last week is.
    fake.digestRows.find((row) => row.userId === 'daily_user').lastSentAt = new Date(nowMs - DAY_MS - 1000);
    weeklyRow.lastSentAt = new Date(nowMs - 8 * DAY_MS);
    expect(await service.dueDigests(new Date(nowMs))).toEqual([{ userId: 'weekly_user', frequency: 'weekly' }]);
  });
});
