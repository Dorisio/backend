import { PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import { ValidationError, NotFoundError } from '../../utils/errors';
import { webhookDispatchQueue } from '../../lib/queue';
import { logger } from '../../utils/logger';
import crypto from 'crypto';
import {
  DEFAULT_PAGE_SIZE,
  sanitizePageNumber,
  sanitizePageSize,
} from '../../utils/pagination';

/** Columns required to build a `WebhookResponse`. */
const WEBHOOK_RESPONSE_SELECT = {
  id: true,
  creatorId: true,
  url: true,
  events: true,
  secret: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Columns required to build a delivery-history entry (payload excluded). */
const WEBHOOK_EVENT_SELECT = {
  id: true,
  eventType: true,
  status: true,
  attempts: true,
  lastError: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Upper bound on dispatch fan-out per event. Prevents a pathological
 * subscription list from turning one transaction into thousands of queue jobs.
 */
const MAX_DISPATCH_TARGETS = 50;

export interface CreateWebhookRequest {
  url: string;
  events: string[];
}

export interface WebhookResponse {
  id: string;
  creatorId: string;
  url: string;
  events: string[];
  secret: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export class WebhookService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  /**
   * Register a new webhook for a creator
   */
  async registerWebhook(creatorId: string, data: CreateWebhookRequest): Promise<WebhookResponse> {
    return this.executeWithLogging('webhook.register', async () => {
      // Validate URL
      try {
        new URL(data.url);
      } catch {
        throw new ValidationError('Invalid webhook URL');
      }

      // Validate events
      const validEvents = ['tip.created', 'tip.confirmed', 'tip.failed', 'payout.completed'];
      for (const event of data.events) {
        if (!validEvents.includes(event)) {
          throw new ValidationError(`Invalid event type: ${event}`);
        }
      }

      // Generate secret for HMAC signing
      const secret = crypto.randomBytes(32).toString('hex');

      const webhook = await this.prisma.webhook.create({
        data: {
          creatorId,
          url: data.url,
          events: data.events,
          secret,
          active: true,
        },
      });

      logger.info(`Webhook registered for creator ${creatorId}: ${webhook.id}`);
      return this.formatWebhookResponse(webhook);
    });
  }

  /**
   * List webhooks for a creator (paginated, newest first).
   *
   * Bounded so a creator with many endpoints can never pull an unbounded
   * result set into the request path.
   */
  async listWebhooks(
    creatorId: string,
    page: number = 1,
    pageSize: number = DEFAULT_PAGE_SIZE
  ): Promise<{
    webhooks: WebhookResponse[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  }> {
    return this.executeWithLogging('webhook.list', async () => {
      const safePage = sanitizePageNumber(page);
      const safePageSize = sanitizePageSize(pageSize, DEFAULT_PAGE_SIZE);
      const where = { creatorId };

      const [webhooks, total] = await Promise.all([
        this.prisma.webhook.findMany({
          where,
          select: WEBHOOK_RESPONSE_SELECT,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (safePage - 1) * safePageSize,
          take: safePageSize,
        }),
        this.prisma.webhook.count({ where }),
      ]);

      const totalPages = Math.ceil(total / safePageSize);

      return {
        webhooks: webhooks.map((w) => this.formatWebhookResponse(w)),
        total,
        page: safePage,
        pageSize: safePageSize,
        totalPages,
        hasNext: safePage < totalPages,
        hasPrev: safePage > 1,
      };
    });
  }

  /**
   * Delete a webhook
   */
  async deleteWebhook(webhookId: string, creatorId: string): Promise<void> {
    return this.executeWithLogging('webhook.delete', async () => {
      const webhook = await this.prisma.webhook.findUnique({
        where: { id: webhookId },
        select: { id: true, creatorId: true },
      });

      if (!webhook) {
        throw new NotFoundError('Webhook');
      }

      if (webhook.creatorId !== creatorId) {
        throw new ValidationError('Unauthorized');
      }

      await this.prisma.webhook.delete({
        where: { id: webhookId },
      });

      logger.info(`Webhook deleted: ${webhookId}`);
    });
  }

  /**
   * Dispatch a webhook event
   */
  async dispatchEvent(
    creatorId: string,
    transactionId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    return this.executeWithLogging('webhook.dispatch', async () => {
      // Find active webhooks for this creator that subscribe to this event.
      // Only the columns the queue job needs are selected.
      const webhooks = await this.prisma.webhook.findMany({
        where: {
          creatorId,
          active: true,
          events: {
            has: eventType,
          },
        },
        select: { id: true, url: true },
        take: MAX_DISPATCH_TARGETS,
        orderBy: { createdAt: 'asc' },
      });

      // Queue dispatch jobs for each webhook
      await Promise.all(
        webhooks.map((webhook) =>
          webhookDispatchQueue.add(
            'dispatch-event',
            {
              webhookId: webhook.id,
              transactionId,
              eventType,
              payload,
            },
            {
              attempts: 5,
              backoff: { type: 'exponential', delay: 2000 },
            }
          )
        )
      );

      logger.info(
        { creatorId, eventType, queued: webhooks.length },
        'Queued webhook dispatches'
      );
    });
  }

  /**
   * Get webhook delivery history
   */
  /**
   * Get webhook delivery history with pagination and status filtering
   */
  async getDeliveryHistory(
    webhookId: string,
    creatorId: string,
    page: number = 1,
    pageSize: number = 20,
    status?: string
  ): Promise<{
    events: {
      id: string;
      eventType: string;
      status: string;
      attempts: number;
      lastError?: string;
      createdAt: string;
      updatedAt: string;
    }[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  }> {
    return this.executeWithLogging('webhook.history', async () => {
      const webhook = await this.prisma.webhook.findUnique({
        where: { id: webhookId },
        select: { id: true, creatorId: true },
      });

      if (!webhook || webhook.creatorId !== creatorId) {
        throw new ValidationError('Unauthorized');
      }

      const safePage = sanitizePageNumber(page);
      const safePageSize = sanitizePageSize(pageSize, DEFAULT_PAGE_SIZE);
      const skip = (safePage - 1) * safePageSize;

      const where: any = { webhookId };
      if (status) {
        where.status = status;
      }

      const [events, total] = await Promise.all([
        this.prisma.webhookEvent.findMany({
          where,
          select: WEBHOOK_EVENT_SELECT,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
          take: safePageSize,
        }),
        this.prisma.webhookEvent.count({ where }),
      ]);

      const formattedEvents = events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        status: e.status,
        attempts: e.attempts,
        lastError: e.lastError || undefined,
        createdAt: e.createdAt.toISOString(),
        updatedAt: e.updatedAt.toISOString(),
      }));

      const totalPages = Math.ceil(total / safePageSize);

      return {
        events: formattedEvents,
        total,
        page: safePage,
        pageSize: safePageSize,
        totalPages,
        hasNext: safePage < totalPages,
        hasPrev: safePage > 1,
      };
    });
  }

  private formatWebhookResponse(webhook: any): WebhookResponse {
    return {
      id: webhook.id,
      creatorId: webhook.creatorId,
      url: webhook.url,
      events: webhook.events,
      secret: webhook.secret,
      active: webhook.active,
      createdAt: webhook.createdAt.toISOString(),
      updatedAt: webhook.updatedAt.toISOString(),
    };
  }
}
