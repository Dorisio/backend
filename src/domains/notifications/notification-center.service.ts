/**
 * Notification centre (issue #58).
 *
 * One service owns the lifecycle of a notification:
 *
 *   create  → render the template, write one row per enabled channel, deliver
 *             (in-app = the row itself, email = queued, push = provider seam)
 *   query   → filtered, searchable, cursor-paginated feed plus an unread count
 *   read    → mark one or all as read/unread
 *   prune   → retention sweep, per event type
 *   digest  → daily/weekly summary of what happened since the last one
 *
 * Delivery is best-effort per channel: a failed email does not roll back the
 * in-app notification, it marks that channel's row `failed` with a reason. The
 * row is the audit trail, so "why did I not get this email?" always has an
 * answer.
 */

import type { PrismaClient } from '@prisma/client';
import { logger } from '../../utils/logger';
import { BadRequestError, NotFoundError } from '../../utils/errors';
import { enqueueEmail } from './email';
import { NotificationPreferenceService } from './notification-preferences.service';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  NOTIFICATION_CHANNELS,
  channelsForEvent,
  retentionDaysForEvent,
  type DigestFrequency,
  type NotificationChannel,
  type NotificationEventType,
  type NotificationListQuery,
  type NotificationStatus,
} from './notification.types';
import { renderDigestEmail, renderNotification, summariseForDigest } from './notification.templates';

export interface NotificationView {
  id: string;
  type: string;
  channel: NotificationChannel;
  status: NotificationStatus;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read: boolean;
  readAt: string | null;
  sentAt: string | null;
  failureReason: string | null;
  createdAt: string;
}

export interface NotificationFeed {
  items: NotificationView[];
  unread: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface NotificationEmailSender {
  send(input: {
    to: string;
    userId: string;
    eventType: string;
    subject: string;
    body: string;
  }): Promise<{ jobId?: string }>;
}

export interface NotificationPushSender {
  /** Returns `skipped` when no push provider is configured for this deployment. */
  send(input: {
    userId: string;
    eventType: string;
    title: string;
    body: string;
  }): Promise<{ delivered: boolean; reason?: string }>;
}

/** Default email sender: queues the existing 'notification' email template. */
export const queuedEmailSender: NotificationEmailSender = {
  async send(input) {
    const jobId = await enqueueEmail({
      to: input.to,
      template: 'notification',
      userId: input.userId,
      eventType: input.eventType,
      data: { subject: input.subject, message: input.body },
    });
    return { jobId };
  },
};

/**
 * No push provider is wired in this repository, so the default sender reports
 * the channel as skipped rather than pretending it was delivered. Deployments
 * that have a provider pass their own sender to `createNotificationCenter`.
 */
export const unconfiguredPushSender: NotificationPushSender = {
  async send() {
    return { delivered: false, reason: 'push provider not configured' };
  },
};

export interface NotificationDispatchInput {
  userId: string;
  type: string;
  data?: Record<string, unknown>;
  /** Restrict delivery to these channels (still subject to preferences). */
  channels?: NotificationChannel[];
}

export interface NotificationDispatchResult {
  created: NotificationView[];
  delivered: NotificationChannel[];
  skipped: Array<{ channel: NotificationChannel; reason: string }>;
}

export interface NotificationCenterOptions {
  now?: () => number;
  email?: NotificationEmailSender;
  push?: NotificationPushSender;
  preferences?: NotificationPreferenceService;
}

interface NotificationRow {
  id: string;
  userId: string;
  type: string;
  channel: string;
  status: string;
  title: string;
  body: string;
  data: unknown;
  readAt: Date | null;
  sentAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
}

export class NotificationCenterService {
  private readonly now: () => number;
  private readonly email: NotificationEmailSender;
  private readonly push: NotificationPushSender;
  private readonly preferences: NotificationPreferenceService;

  constructor(
    private readonly prisma: PrismaClient,
    options: NotificationCenterOptions = {}
  ) {
    this.now = options.now ?? (() => Date.now());
    this.email = options.email ?? queuedEmailSender;
    this.push = options.push ?? unconfiguredPushSender;
    this.preferences = options.preferences ?? new NotificationPreferenceService(prisma, { now: this.now });
  }

  // ── Generation ─────────────────────────────────────────────────────────────

  /**
   * Renders and delivers one event. Returns the rows it wrote, so a caller can
   * assert on delivery without re-querying.
   */
  async create(input: NotificationDispatchInput): Promise<NotificationDispatchResult> {
    const rendered = renderNotification(input.type as NotificationEventType, { data: input.data ?? {} });

    const allowed = channelsForEvent(input.type);
    const requested = (input.channels ?? allowed).filter((channel) =>
      NOTIFICATION_CHANNELS.includes(channel)
    );
    const invalid = requested.filter((channel) => !allowed.includes(channel));
    if (invalid.length > 0) {
      throw new BadRequestError(`${input.type} cannot be delivered on ${invalid.join(', ')}`);
    }

    const enabled = await this.preferences.enabledChannels(input.userId, input.type);
    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, email: true, name: true },
    });
    if (!user) throw new NotFoundError('User');

    const created: NotificationView[] = [];
    const delivered: NotificationChannel[] = [];
    const skipped: Array<{ channel: NotificationChannel; reason: string }> = [];

    for (const channel of requested) {
      if (!enabled.includes(channel)) {
        skipped.push({ channel, reason: 'disabled by user preference' });
        continue;
      }

      const row = await this.prisma.notification.create({
        data: {
          userId: input.userId,
          type: input.type,
          channel,
          status: 'queued',
          title: rendered.title,
          body: rendered.body,
          data: (input.data ?? {}) as object,
          expiresAt: this.expiryFor(input.type),
        },
      });

      const settled = await this.deliver(channel, row, {
        email: user.email,
        name: user.name,
        subject: rendered.subject,
        body: rendered.body,
      });

      if (settled.delivered) delivered.push(channel);
      else skipped.push({ channel, reason: settled.reason ?? 'not delivered' });

      created.push(this.toView(settled.row ?? row));
    }

    return { created, delivered, skipped };
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  async list(userId: string, query: NotificationListQuery = {}): Promise<NotificationFeed> {
    const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const where: Record<string, unknown> = { userId };
    if (query.status) where.status = query.status;
    if (query.channel) where.channel = query.channel;
    if (query.type) where.type = query.type;
    if (query.unreadOnly) where.readAt = null;
    if (query.search) {
      const search = query.search;
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { body: { contains: search, mode: 'insensitive' } },
        { type: { contains: search, mode: 'insensitive' } },
      ];
    }

    // Keyset paging on (createdAt, id): rows are ordered newest-first, so a page
    // stays stable while new notifications arrive and a deleted cursor row does
    // not break the next request the way Prisma's `cursor` lookup would.
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cursor) throw new BadRequestError('Invalid pagination cursor');

    if (cursor) {
      where.AND = [
        {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        },
      ];
    }

    const skip = cursor ? 0 : (Math.max(query.page ?? 1, 1) - 1) * pageSize;
    const rows = (await this.prisma.notification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: pageSize + 1,
      skip,
    })) as NotificationRow[];

    const hasMore = rows.length > pageSize;
    const page = hasMore ? rows.slice(0, pageSize) : rows;

    return {
      items: page.map((row) => this.toView(row)),
      unread: await this.unreadCount(userId),
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
      hasMore,
    };
  }

  async unreadCount(userId: string, channel?: NotificationChannel): Promise<number> {
    return this.prisma.notification.count({
      where: { userId, readAt: null, ...(channel ? { channel } : {}) },
    });
  }

  async get(userId: string, id: string): Promise<NotificationView> {
    const row = (await this.prisma.notification.findFirst({ where: { id, userId } })) as NotificationRow | null;
    if (!row) throw new NotFoundError('Notification');
    return this.toView(row);
  }

  // ── Read tracking ──────────────────────────────────────────────────────────

  async markRead(userId: string, id: string, read = true): Promise<NotificationView> {
    const row = (await this.prisma.notification.findFirst({ where: { id, userId } })) as NotificationRow | null;
    if (!row) throw new NotFoundError('Notification');

    const updated = (await this.prisma.notification.update({
      where: { id },
      // Re-reading a notification must not move the timestamp the UI shows.
      data: { readAt: read ? row.readAt ?? new Date(this.now()) : null },
    })) as NotificationRow;

    return this.toView(updated);
  }

  async markAllRead(
    userId: string,
    filters: { type?: string; channel?: NotificationChannel } = {}
  ): Promise<{ updated: number; unread: number }> {
    const result = await this.prisma.notification.updateMany({
      where: { userId, readAt: null, ...filters },
      data: { readAt: new Date(this.now()) },
    });

    return { updated: result.count, unread: await this.unreadCount(userId) };
  }

  async remove(userId: string, id: string): Promise<void> {
    const result = await this.prisma.notification.deleteMany({ where: { id, userId } });
    if (result.count === 0) throw new NotFoundError('Notification');
  }

  // ── Retention ──────────────────────────────────────────────────────────────

  /**
   * Deletes notifications past their event type's retention window. Rows never
   * get an `expiresAt` of their own, so a row without one is left alone.
   */
  async pruneExpired(now: Date = new Date(this.now())): Promise<{ deleted: number }> {
    const result = await this.prisma.notification.deleteMany({
      where: { expiresAt: { not: null, lte: now } },
    });

    if (result.count > 0) {
      logger.info({ deleted: result.count }, 'Pruned expired notifications');
    }

    return { deleted: result.count };
  }

  // ── Digests ────────────────────────────────────────────────────────────────

  /** Builds the digest for a user without sending it. */
  async buildDigest(
    userId: string,
    frequency: Exclude<DigestFrequency, 'off'>,
    now: Date = new Date(this.now())
  ): Promise<{ entries: NotificationView[]; subject: string; body: string }> {
    const windowMs = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 }[frequency];
    const since = new Date(now.getTime() - windowMs);

    const rows = (await this.prisma.notification.findMany({
      where: { userId, createdAt: { gte: since } },
      orderBy: [{ createdAt: 'desc' }],
      take: 200,
    })) as NotificationRow[];

    const entries = rows.map((row) => this.toView(row));
    const digest = renderDigestEmail(
      frequency,
      entries.map((entry) => ({ type: entry.type, title: entry.title, body: entry.body }))
    );

    return { entries, ...digest };
  }

  /**
   * Sends every digest that is due, and stamps `lastSentAt`. A digest with
   * nothing in it is skipped: an empty summary is noise.
   */
  async sendDueDigests(
    now: Date = new Date(this.now())
  ): Promise<{ sent: number; empty: number; failed: number }> {
    const due = await this.preferences.dueDigests(now);
    let sent = 0;
    let empty = 0;
    let failed = 0;

    for (const { userId, frequency } of due) {
      try {
        const digest = await this.buildDigest(userId, frequency, now);
        if (digest.entries.length === 0) {
          empty += 1;
        } else {
          await this.create({
            userId,
            type: 'digest.ready',
            data: { summary: summariseForDigest(digest.entries) },
          });
          sent += 1;
        }

        await this.prisma.notificationDigestSetting.update({
          where: { userId },
          data: { lastSentAt: now },
        });
      } catch (error) {
        failed += 1;
        logger.error({ err: error, userId, frequency }, 'Digest delivery failed');
      }
    }

    return { sent, empty, failed };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async deliver(
    channel: NotificationChannel,
    row: NotificationRow,
    content: { email: string; name: string | null; subject: string; body: string }
  ): Promise<{ delivered: boolean; reason?: string; row: NotificationRow }> {
    const at = new Date(this.now());

    try {
      if (channel === 'in_app') {
        // The stored row *is* the in-app delivery.
        return {
          delivered: true,
          row: (await this.prisma.notification.update({
            where: { id: row.id },
            data: { status: 'sent', sentAt: at },
          })) as NotificationRow,
        };
      }

      if (channel === 'email') {
        await this.email.send({
          to: content.email,
          userId: row.userId,
          eventType: row.type,
          subject: content.subject,
          body: content.body,
        });
        return {
          delivered: true,
          row: (await this.prisma.notification.update({
            where: { id: row.id },
            data: { status: 'sent', sentAt: at },
          })) as NotificationRow,
        };
      }

      const push = await this.push.send({
        userId: row.userId,
        eventType: row.type,
        title: row.title,
        body: row.body,
      });

      if (!push.delivered) {
        return {
          delivered: false,
          reason: push.reason ?? 'push not delivered',
          row: (await this.prisma.notification.update({
            where: { id: row.id },
            data: { status: 'skipped', failureReason: push.reason ?? 'push not delivered' },
          })) as NotificationRow,
        };
      }

      return {
        delivered: true,
        row: (await this.prisma.notification.update({
          where: { id: row.id },
          data: { status: 'sent', sentAt: at },
        })) as NotificationRow,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'delivery failed';
      return {
        delivered: false,
        reason,
        row: (await this.prisma.notification.update({
          where: { id: row.id },
          data: { status: 'failed', failedAt: at, failureReason: reason },
        })) as NotificationRow,
      };
    }
  }

  private expiryFor(type: string): Date {
    return new Date(this.now() + retentionDaysForEvent(type) * 24 * 60 * 60 * 1000);
  }

  private toView(row: NotificationRow): NotificationView {
    const channel = NOTIFICATION_CHANNELS.includes(row.channel as NotificationChannel)
      ? (row.channel as NotificationChannel)
      : 'in_app';

    return {
      id: row.id,
      type: row.type,
      channel,
      status: (row.status as NotificationStatus) ?? 'queued',
      title: row.title,
      body: row.body,
      data: (row.data as Record<string, unknown>) ?? {},
      read: row.readAt !== null,
      readAt: row.readAt ? row.readAt.toISOString() : null,
      sentAt: row.sentAt ? row.sentAt.toISOString() : null,
      failureReason: row.failureReason ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/** Opaque keyset cursor: the last row's (createdAt, id) pair. */
export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const createdAt = new Date(iso);
    if (!id || Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/** Convenience factory used by the routes and by worker entry points. */
export function createNotificationCenter(
  prisma: PrismaClient,
  options: NotificationCenterOptions = {}
): { center: NotificationCenterService; preferences: NotificationPreferenceService } {
  const preferences = options.preferences ?? new NotificationPreferenceService(prisma, { now: options.now });
  return {
    preferences,
    center: new NotificationCenterService(prisma, { ...options, preferences }),
  };
}
