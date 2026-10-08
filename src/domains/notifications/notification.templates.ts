/**
 * Notification templates (issue #58).
 *
 * A template turns an event payload into the title/body stored on a
 * Notification (and, for email/push, the subject sent to the provider). Values
 * are escaped on render: notification payloads carry user-generated content
 * (a tipper's name, a tip message) and both the notification centre and the
 * email are HTML surfaces.
 */

import type { NotificationEventType } from './notification.types';

export interface NotificationTemplateContext {
  /** Values referenced by `{{placeholder}}` in the template. */
  data: Record<string, unknown>;
  /** Recipient locale, reserved for localised templates. */
  locale?: string;
}

export interface RenderedNotification {
  title: string;
  body: string;
  /** Email subject; falls back to the title. */
  subject: string;
}

export interface NotificationTemplate {
  type: NotificationEventType;
  title: string;
  body: string;
  subject?: string;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string
  );
}

/** Renders `{{key}}` placeholders; unknown or empty keys collapse to ''. */
export function renderTemplateString(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, key: string) => {
    const value = key.split('.').reduce<unknown>((acc, part) => {
      if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[part];
      return undefined;
    }, data);

    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return escapeHtml(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  });
}

export const NOTIFICATION_TEMPLATES: Record<NotificationEventType, NotificationTemplate> = {
  'tip.received': {
    type: 'tip.received',
    title: 'New tip received',
    body: '{{senderName}} tipped {{amount}} {{asset}}.',
    subject: 'You received a tip of {{amount}} {{asset}}',
  },
  'tip.confirmed': {
    type: 'tip.confirmed',
    title: 'Tip confirmed',
    body: 'Your tip of {{amount}} {{asset}} to {{creatorName}} is confirmed on-chain.',
    subject: 'Your tip is confirmed',
  },
  'payout.completed': {
    type: 'payout.completed',
    title: 'Payout completed',
    body: 'Your payout of {{amount}} {{asset}} was sent to {{walletAddress}}.',
    subject: 'Your payout has been sent',
  },
  'creator.verified': {
    type: 'creator.verified',
    title: 'Creator profile verified',
    body: 'Your creator profile {{username}} is now verified.',
    subject: 'Your creator profile is verified',
  },
  'account.warning': {
    type: 'account.warning',
    title: 'Account warning',
    body: '{{message}}',
    subject: 'Important notice about your account',
  },
  'report.resolved': {
    type: 'report.resolved',
    title: 'Your report was reviewed',
    body: 'A report you filed was {{decision}}: {{notes}}',
    subject: 'Update on your report',
  },
  'digest.ready': {
    type: 'digest.ready',
    title: 'Your activity summary is ready',
    body: '{{summary}}',
    subject: 'Your Dorisio activity summary',
  },
};

export function renderNotification(
  type: NotificationEventType,
  context: NotificationTemplateContext
): RenderedNotification {
  const template = NOTIFICATION_TEMPLATES[type];
  if (!template) throw new Error(`No notification template registered for ${type}`);

  const title = renderTemplateString(template.title, context.data);
  const body = renderTemplateString(template.body, context.data);

  return {
    title,
    body: body.trim() || title,
    subject: renderTemplateString(template.subject ?? template.title, context.data) || title,
  };
}

/**
 * One line per event for a digest, so a user can scan a summary without opening
 * the notification centre.
 */
export function summariseForDigest(
  entries: Array<{ type: string; title: string; body: string }>
): string {
  if (entries.length === 0) return '';
  if (entries.length === 1) return entries[0].body || entries[0].title;

  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1);
  }

  const parts = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, count]) => `${count} × ${type}`);

  return `${entries.length} updates: ${parts.join(', ')}`;
}

/** Subject/body for the digest email itself. */
export function renderDigestEmail(
  frequency: 'daily' | 'weekly',
  entries: Array<{ type: string; title: string; body: string }>
): { subject: string; body: string } {
  const label = frequency === 'weekly' ? 'Weekly' : 'Daily';
  const summary = summariseForDigest(entries);
  const bullets = entries.map((entry) => `- ${entry.title}: ${entry.body}`).join('\n');

  return {
    subject: `Your ${label.toLowerCase()} Dorisio summary`,
    body: `${label} summary: ${summary}\n\n${bullets}`,
  };
}
