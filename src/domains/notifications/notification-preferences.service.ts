/**
 * Notification preferences (issue #58).
 *
 * Resolution order for a (eventType, channel) pair:
 *
 *   1. a `NotificationPreference` row, if the user ever touched that pair;
 *   2. the legacy `User.notificationPreferences` JSONB value, if present;
 *   3. the default from `notification.types.ts`.
 *
 * Writes go to the table **and** are mirrored into the legacy JSONB column,
 * which the email worker still reads. The table is the source of truth and the
 * column is a projection kept in sync, so the two cannot disagree about an
 * event the user has configured.
 */

import type { PrismaClient } from '@prisma/client';
import { NotFoundError } from '../../utils/errors';
import {
  DEFAULT_DIGEST_FREQUENCY,
  DEFAULT_DIGEST_HOUR_UTC,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  channelsForEvent,
  defaultChannelEnabled,
  isNotificationChannel,
  type DigestFrequency,
  type DigestSettingsView,
  type NotificationChannel,
  type NotificationPreferenceView,
  type PreferencePatch,
} from './notification.types';

export interface NotificationPreferenceServiceOptions {
  now?: () => number;
}

interface StoredPreference {
  eventType: string;
  channel: string;
  enabled: boolean;
}

export class NotificationPreferenceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: NotificationPreferenceServiceOptions = {}
  ) {}

  /**
   * Every (event, channel) pair the API can render, with the effective value and
   * where it came from.
   */
  async list(userId: string): Promise<NotificationPreferenceView[]> {
    const rows = await this.storedRows(userId);
    const legacy = await this.legacyPreferences(userId);
    const stored = new Map(rows.map((row) => [`${row.eventType}:${row.channel}`, row.enabled]));

    const views: NotificationPreferenceView[] = [];
    for (const eventType of NOTIFICATION_EVENTS) {
      for (const channel of channelsForEvent(eventType)) {
        const key = `${eventType}:${channel}`;
        const storedValue = stored.get(key);
        const legacyValue = legacy[eventType]?.[channel];

        if (typeof storedValue === 'boolean') {
          views.push({ eventType, channel, enabled: storedValue, source: 'stored' });
        } else if (typeof legacyValue === 'boolean') {
          views.push({ eventType, channel, enabled: legacyValue, source: 'legacy' });
        } else {
          views.push({
            eventType,
            channel,
            enabled: defaultChannelEnabled(eventType, channel),
            source: 'default',
          });
        }
      }
    }

    return views;
  }

  /** Whether `channel` may be used for `eventType` right now. */
  async isEnabled(userId: string, eventType: string, channel: NotificationChannel): Promise<boolean> {
    if (!channelsForEvent(eventType).includes(channel)) return false;

    const rows = await this.storedRows(userId, eventType);
    const stored = rows.find((row) => row.channel === channel);
    if (stored) return stored.enabled;

    const legacy = await this.legacyPreferences(userId);
    const legacyValue = legacy[eventType]?.[channel];
    if (typeof legacyValue === 'boolean') return legacyValue;

    return defaultChannelEnabled(eventType, channel);
  }

  /** The channels an event may go out on for this user, in preference order. */
  async enabledChannels(userId: string, eventType: string): Promise<NotificationChannel[]> {
    const channels = channelsForEvent(eventType);
    const rows = await this.storedRows(userId, eventType);
    const stored = new Map(rows.map((row) => [row.channel, row.enabled]));
    const legacy = await this.legacyPreferences(userId);

    return channels.filter((channel) => {
      const storedValue = stored.get(channel);
      if (typeof storedValue === 'boolean') return storedValue;
      const legacyValue = legacy[eventType]?.[channel];
      if (typeof legacyValue === 'boolean') return legacyValue;
      return defaultChannelEnabled(eventType, channel);
    });
  }

  /** Upserts one or more overrides and mirrors them into the legacy column. */
  async update(userId: string, patches: PreferencePatch[]): Promise<NotificationPreferenceView[]> {
    await this.requireUser(userId);
    if (patches.length === 0) return this.list(userId);

    for (const patch of patches) {
      if (!channelsForEvent(patch.eventType).includes(patch.channel)) {
        // Storing a preference for a channel the event never uses would be a
        // setting that silently does nothing.
        continue;
      }
      await this.prisma.notificationPreference.upsert({
        where: {
          userId_eventType_channel: {
            userId,
            eventType: patch.eventType,
            channel: patch.channel,
          },
        },
        create: {
          userId,
          eventType: patch.eventType,
          channel: patch.channel,
          enabled: patch.enabled,
        },
        update: { enabled: patch.enabled },
      });
    }

    await this.mirrorLegacy(userId);
    return this.list(userId);
  }

  /** Drops every override, returning the user to the defaults. */
  async reset(userId: string): Promise<NotificationPreferenceView[]> {
    await this.requireUser(userId);
    await this.prisma.notificationPreference.deleteMany({ where: { userId } });
    await this.prisma.user.update({ where: { id: userId }, data: { notificationPreferences: {} } });
    return this.list(userId);
  }

  async getDigest(userId: string): Promise<DigestSettingsView> {
    const row = await this.prisma.notificationDigestSetting.findUnique({ where: { userId } });
    if (!row) {
      return {
        frequency: DEFAULT_DIGEST_FREQUENCY,
        channel: 'email',
        hourUtc: DEFAULT_DIGEST_HOUR_UTC,
        lastSentAt: null,
      };
    }

    return {
      frequency: row.frequency as DigestFrequency,
      channel: row.channel as NotificationChannel,
      hourUtc: row.hourUtc,
      lastSentAt: row.lastSentAt ? row.lastSentAt.toISOString() : null,
    };
  }

  async setDigest(
    userId: string,
    input: { frequency: DigestFrequency; channel?: NotificationChannel; hourUtc?: number }
  ): Promise<DigestSettingsView> {
    await this.requireUser(userId);

    const row = await this.prisma.notificationDigestSetting.upsert({
      where: { userId },
      create: {
        userId,
        frequency: input.frequency,
        channel: input.channel ?? 'email',
        hourUtc: input.hourUtc ?? DEFAULT_DIGEST_HOUR_UTC,
      },
      update: {
        frequency: input.frequency,
        ...(input.channel ? { channel: input.channel } : {}),
        ...(input.hourUtc !== undefined ? { hourUtc: input.hourUtc } : {}),
      },
    });

    return {
      frequency: row.frequency as DigestFrequency,
      channel: row.channel as NotificationChannel,
      hourUtc: row.hourUtc,
      lastSentAt: row.lastSentAt ? row.lastSentAt.toISOString() : null,
    };
  }

  /**
   * Users whose digest is due at `now`: the frequency selects the window and
   * `hourUtc` the delivery hour, so a daily digest goes out once a day.
   */
  async dueDigests(now: Date = new Date(this.options.now?.() ?? Date.now())): Promise<
    Array<{ userId: string; frequency: Exclude<DigestFrequency, 'off'> }>
  > {
    const rows = await this.prisma.notificationDigestSetting.findMany({
      where: { frequency: { in: ['daily', 'weekly'] } },
      take: 1000,
    });

    const windowMs = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 };

    return rows
      .filter((row) => {
        const frequency = row.frequency as Exclude<DigestFrequency, 'off'>;
        if (row.hourUtc > now.getUTCHours()) return false;
        if (!row.lastSentAt) return true;
        return now.getTime() - row.lastSentAt.getTime() >= windowMs[frequency];
      })
      .map((row) => ({ userId: row.userId, frequency: row.frequency as Exclude<DigestFrequency, 'off'> }));
  }

  private async requireUser(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundError('User');
  }

  private async storedRows(userId: string, eventType?: string): Promise<StoredPreference[]> {
    return this.prisma.notificationPreference.findMany({
      where: { userId, ...(eventType ? { eventType } : {}) },
    });
  }

  private async legacyPreferences(
    userId: string
  ): Promise<Record<string, Partial<Record<NotificationChannel, boolean>>>> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { notificationPreferences: true },
    });
    if (!user) return {};

    const raw = user.notificationPreferences as Record<string, unknown> | null;
    const out: Record<string, Partial<Record<NotificationChannel, boolean>>> = {};

    for (const [eventType, value] of Object.entries(raw ?? {})) {
      if (!value || typeof value !== 'object') continue;
      for (const [channel, enabled] of Object.entries(value as Record<string, unknown>)) {
        if (!isNotificationChannel(channel)) continue;
        if (typeof enabled !== 'boolean') continue;
        out[eventType] = { ...out[eventType], [channel]: enabled };
      }
    }

    return out;
  }

  /**
   * Rewrites the legacy column from the table so the email worker agrees. Values
   * that only ever existed in the column are kept: the projection is the union
   * of both stores, with the table winning for pairs it defines.
   */
  private async mirrorLegacy(userId: string): Promise<void> {
    const rows = await this.storedRows(userId);
    const legacy = await this.legacyPreferences(userId);
    const projection: Record<string, Record<string, boolean>> = {};

    for (const [eventType, channels] of Object.entries(legacy)) {
      for (const channel of NOTIFICATION_CHANNELS) {
        const value = channels[channel];
        if (typeof value !== 'boolean') continue;
        projection[eventType] = { ...projection[eventType], [channel]: value };
      }
    }

    for (const row of rows) {
      if (!NOTIFICATION_CHANNELS.includes(row.channel as NotificationChannel)) continue;
      projection[row.eventType] = { ...projection[row.eventType], [row.channel]: row.enabled };
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { notificationPreferences: projection },
    });
  }
}
