/**
 * Notification types, channels, defaults and payload schemas (issue #58).
 *
 * Everything the notification centre, the preference service and the digest job
 * need to agree on lives here: the event catalogue, which channels a type may
 * use, the default opt-in for each (channel, type) pair, how long a row is kept,
 * and the shape of the `data` payload a template renders from.
 */

import { z } from 'zod';

export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'push'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_STATUSES = ['queued', 'sent', 'skipped', 'failed'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const DIGEST_FREQUENCIES = ['off', 'daily', 'weekly'] as const;
export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];

/**
 * Event catalogue. The keys are the `type` stored on a Notification and the
 * `eventType` a preference row overrides, so they are part of the API contract.
 */
export const NOTIFICATION_EVENTS = [
  'tip.received',
  'tip.confirmed',
  'payout.completed',
  'creator.verified',
  'account.warning',
  'report.resolved',
  'digest.ready',
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENTS)[number];

export interface NotificationEventDefinition {
  type: NotificationEventType;
  /** Channels this event may be delivered on. */
  channels: NotificationChannel[];
  /** Channels that default to on when the user has no preference row. */
  defaultEnabled: NotificationChannel[];
  /** Rows older than this are pruned by the retention sweep. */
  retentionDays: number;
  /** Whether the event is worth including in a digest. */
  digest: boolean;
}

const ALL_CHANNELS: NotificationChannel[] = ['in_app', 'email', 'push'];

export const NOTIFICATION_EVENT_DEFINITIONS: Record<NotificationEventType, NotificationEventDefinition> = {
  'tip.received': {
    type: 'tip.received',
    channels: ALL_CHANNELS,
    defaultEnabled: ['in_app', 'email'],
    retentionDays: 90,
    digest: true,
  },
  'tip.confirmed': {
    type: 'tip.confirmed',
    channels: ALL_CHANNELS,
    defaultEnabled: ['in_app'],
    retentionDays: 90,
    digest: true,
  },
  'payout.completed': {
    type: 'payout.completed',
    channels: ALL_CHANNELS,
    defaultEnabled: ['in_app', 'email'],
    retentionDays: 365,
    digest: true,
  },
  'creator.verified': {
    type: 'creator.verified',
    channels: ALL_CHANNELS,
    defaultEnabled: ['in_app', 'email'],
    retentionDays: 365,
    digest: false,
  },
  'account.warning': {
    type: 'account.warning',
    // Security-relevant: always stored in-app, never silently emailed off.
    channels: ALL_CHANNELS,
    defaultEnabled: ['in_app', 'email'],
    retentionDays: 365,
    digest: false,
  },
  'report.resolved': {
    type: 'report.resolved',
    channels: ['in_app', 'email'],
    defaultEnabled: ['in_app', 'email'],
    retentionDays: 365,
    digest: false,
  },
  'digest.ready': {
    type: 'digest.ready',
    channels: ['in_app', 'email'],
    defaultEnabled: ['in_app'],
    retentionDays: 30,
    digest: false,
  },
};

export function isNotificationChannel(value: unknown): value is NotificationChannel {
  return typeof value === 'string' && (NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}

export function isNotificationEventType(value: unknown): value is NotificationEventType {
  return typeof value === 'string' && (NOTIFICATION_EVENTS as readonly string[]).includes(value);
}

export function getNotificationEvent(type: string): NotificationEventDefinition | undefined {
  return NOTIFICATION_EVENT_DEFINITIONS[type as NotificationEventType];
}

/**
 * Default opt-in for a (type, channel) pair. An unknown type defaults to in-app
 * only: refusing to store an event is worse than storing it quietly, and it
 * keeps a new event type from emailing users before someone reviews it.
 */
export function defaultChannelEnabled(type: string, channel: NotificationChannel): boolean {
  const definition = getNotificationEvent(type);
  if (!definition) return channel === 'in_app';
  if (!definition.channels.includes(channel)) return false;
  return definition.defaultEnabled.includes(channel);
}

export function channelsForEvent(type: string): NotificationChannel[] {
  return getNotificationEvent(type)?.channels ?? ['in_app'];
}

export function retentionDaysForEvent(type: string): number {
  return getNotificationEvent(type)?.retentionDays ?? 90;
}

export const DEFAULT_DIGEST_FREQUENCY: DigestFrequency = 'off';
export const DEFAULT_DIGEST_HOUR_UTC = 8;

/** Digest windows, in milliseconds, keyed by frequency. */
export const DIGEST_WINDOW_MS: Record<Exclude<DigestFrequency, 'off'>, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

// ── Request schemas ─────────────────────────────────────────────────────────

export const PreferencePatchSchema = z.object({
  eventType: z.enum(NOTIFICATION_EVENTS),
  channel: z.enum(NOTIFICATION_CHANNELS),
  enabled: z.boolean(),
});

export const PreferenceBulkSchema = z.object({
  preferences: z
    .array(PreferencePatchSchema)
    .min(1, 'At least one preference is required')
    .max(200, 'At most 200 preferences can be updated at once'),
});

export const DigestSettingsSchema = z.object({
  frequency: z.enum(DIGEST_FREQUENCIES),
  channel: z.enum(NOTIFICATION_CHANNELS).optional(),
  hourUtc: z.number().int().min(0).max(23).optional(),
});

export const NotificationListQuerySchema = z.object({
  status: z.enum(NOTIFICATION_STATUSES).optional(),
  channel: z.enum(NOTIFICATION_CHANNELS).optional(),
  type: z.enum(NOTIFICATION_EVENTS).optional(),
  unreadOnly: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .optional()
    .transform((value) => value === true || value === 'true' || value === '1'),
  search: z.string().trim().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).max(1000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
});

export type PreferencePatch = z.infer<typeof PreferencePatchSchema>;
export type NotificationListQuery = z.infer<typeof NotificationListQuerySchema>;

export interface NotificationPreferenceView {
  eventType: NotificationEventType;
  channel: NotificationChannel;
  enabled: boolean;
  /** Where the effective value came from, for a settings screen. */
  source: 'default' | 'stored' | 'legacy';
}

export interface DigestSettingsView {
  frequency: DigestFrequency;
  channel: NotificationChannel;
  hourUtc: number;
  lastSentAt: string | null;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
