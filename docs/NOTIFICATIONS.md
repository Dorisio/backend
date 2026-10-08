# Notifications

Users are told about tips, payouts and account events through one notification
pipeline: an event is rendered from a template, delivered on the channels the
user allows, stored for the notification centre, and pruned when its retention
window ends.

| File | Purpose |
| --- | --- |
| `src/domains/notifications/notification.types.ts` | Event catalogue, channels, default opt-ins, retention windows, request schemas. **The only file you edit to add an event.** |
| `src/domains/notifications/notification.templates.ts` | Title/body/subject per event, placeholder rendering and digest summarising. |
| `src/domains/notifications/notification-preferences.service.ts` | Resolves and stores per-type/channel preferences plus digest settings. |
| `src/domains/notifications/notification-center.service.ts` | Lifecycle: create, feed queries, read tracking, retention sweep, digests. |
| `src/domains/notifications/notification.routes.ts` | The HTTP surface below. |
| `src/lib/workers/email-notification.worker.ts` | Existing email queue consumer; it re-checks the email preference before sending. |

## Channels

| Channel | How it is delivered |
| --- | --- |
| `in_app` | The stored `Notification` row is the delivery. |
| `email` | Queued through the existing `email-notifications` queue (`enqueueEmail`). A user without the email preference never gets a row, and the worker checks again as a second line of defence. |
| `push` | A provider seam (`NotificationPushSender`). This repository wires the `unconfiguredPushSender`, which records the attempt as `skipped` with `push provider not configured` instead of pretending it was delivered; a deployment with a push provider passes its own sender to `createNotificationCenter`. |

Delivery is best-effort per channel: a failed email does not roll back the in-app
notification. Each row keeps its own `status` (`queued`, `sent`, `skipped`,
`failed`), which is why "why did I not get this email?" always has an answer.

## Events and defaults

| Event | Channels | On by default | Retention |
| --- | --- | --- | --- |
| `tip.received` | in-app, email, push | in-app, email | 90 days |
| `tip.confirmed` | in-app, email, push | in-app | 90 days |
| `payout.completed` | in-app, email, push | in-app, email | 365 days |
| `creator.verified` | in-app, email, push | in-app, email | 365 days |
| `account.warning` | in-app, email, push | in-app, email | 365 days |
| `report.resolved` | in-app, email | in-app, email | 365 days |
| `digest.ready` | in-app, email | in-app | 30 days |

An event type that is not in the catalogue may only be delivered in-app: a new
event cannot email users before someone reviews its template.

## Preferences

A preference is resolved in this order:

1. a `NotificationPreference` row, when the user has configured that pair;
2. the legacy `User.notificationPreferences` JSONB value, when present;
3. the default from the table above.

Rows exist only for pairs a user actually changed, so the table stays
proportional to the overrides. Writes go to the table **and** are mirrored into
the JSONB column — the column is a projection the email worker still reads, and
the mirror is a union, so a value that only ever existed in the column survives a
write to an unrelated pair.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/notifications` | Feed. `status`, `channel`, `type`, `unreadOnly`, `search`, `page`/`pageSize`, `cursor`. |
| `GET` | `/api/v1/notifications/unread-count` | Badge count, optionally per channel. |
| `POST` | `/api/v1/notifications/read` | Mark all read, optionally filtered by `type`/`channel`. |
| `GET` | `/api/v1/notifications/:id` | One notification. |
| `PATCH` | `/api/v1/notifications/:id` | `{ read }` — mark read or unread. |
| `DELETE` | `/api/v1/notifications/:id` | Dismiss. |
| `GET` | `/api/v1/notifications/preferences` | Resolved matrix (`enabled` + `source`) plus digest settings and the event catalogue. |
| `PATCH` | `/api/v1/notifications/preferences` | `{ eventType, channel, enabled }` or `{ preferences: [...] }`. |
| `DELETE` | `/api/v1/notifications/preferences` | Back to the defaults. |
| `PATCH` | `/api/v1/notifications/preferences/digest` | `{ frequency, channel?, hourUtc? }`. |
| `POST` | `/api/v1/notifications/retention/prune` | Admin. Deletes rows past their retention window. |

The feed is paged newest-first with an opaque keyset cursor over
`(createdAt, id)`, so a page stays stable while new notifications arrive and a
deleted cursor row does not break the next request. `unread` is included with
every page so the client does not need a second call.

## Digests

`NotificationDigestSetting` stores one row per user: frequency (`off`, `daily`,
`weekly`), channel and `hourUtc`. `NotificationPreferenceService.dueDigests()`
returns the users whose window has elapsed and whose delivery hour has passed;
`NotificationCenterService.sendDueDigests()` then builds each summary, emits it
as a `digest.ready` notification (which respects the user's channels), and stamps
`lastSentAt`. An empty window is not sent — it still stamps `lastSentAt`, so an
idle account is not re-evaluated on every scheduler tick.

## Retention

Every notification is stored with an `expiresAt` derived from its event type.
`pruneExpired()` deletes what is past it, and an admin endpoint exposes the sweep
to the scheduler.
