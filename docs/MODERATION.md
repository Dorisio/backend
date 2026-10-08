# Content moderation and abuse reporting

Anything a user can write in Dorisio — a tip message, a profile, a creator — can
be reported, triaged automatically, reviewed by a moderator, resolved with a
recorded decision, and appealed once. Every step lands in an append-only audit
trail, so "why was this taken down?" always has an answer.

## The lifecycle

```
reported ──claim──▶ investigating ──resolve──▶ resolved
    │                     │                       │
    └─────────────────────┴──dismiss──────────▶ dismissed
                                                  │
                                       appeal ────┘ (once, by the author)
```

`reported → investigating → resolved` is the workflow from the issue; `dismissed`
covers duplicates and withdrawn reports. Transitions are declared in
`REPORT_TRANSITIONS` and enforced in the service, so an invalid step is a `409`
rather than a silent state change.

## Report targets and types

A report points at a typed target, not just a user id:

| `targetType` | Target | Who can appeal |
| --- | --- | --- |
| `tip` | A tip message (the `Tip` row) | The tip's sender |
| `user` | A user account | That user |
| `creator` | A creator profile | The user behind the profile |

`reportType` is one of `spam`, `harassment`, `inappropriate`, `fraud`,
`copyright`. The type sets the priority floor: `fraud` is `urgent`, `harassment`
`high`, `inappropriate`/`copyright` `normal` and `spam` `low` — a harassment
report is never queued behind spam because the message happened to look ordinary.

## Automatic triage

`spam-filter.ts` scores the reason and details with additive rules (bait phrases,
link counts, contact details, shouting, repeated characters, one-word repetition)
and explains itself in `reasons`, which is what a moderator sees:

| Score | Effect |
| --- | --- |
| `< 40` | Stays `reported` at its type's priority. |
| `>= 40` | Moves to `investigating` at `high`. |
| `>= 80` | Same, and the content is **hidden** while it is reviewed. |

The hiding rule does not apply to `copyright` reports: a takedown notice
legitimately quotes the material it complains about, so its wording must not
hide anything on its own. The score, the signals and the fact that the content
was hidden automatically are all stored on the report and written to the audit
trail with actor `system`.

There is no way to re-report the same content for the same reason while a report
is open: the service checks first and answers `409`, and a partial unique index
on `(reporterId, targetType, targetId, reportType)` for open reports makes it
airtight under concurrency.

## Hiding content

`Tip.moderationState` is `visible` (default), `hidden` or `removed`:

* **Lists never serve hidden or removed tips.** `PaymentService` filters every
  tip list (offset, cursor, and both GraphQL connections) on `visible`.
* **A direct lookup by id 404s for removed content** — it is gone — while a
  hidden tip stays readable so its sender and creator can still see what they
  wrote while the report is open.

## Audit trail

`ModerationAction` is append-only: `report.created`, `report.auto_triaged`,
`report.claimed`, `report.resolved`, `report.dismissed`, `content.hidden`,
`content.restored`, `content.removed`, `appeal.filed`, `appeal.resolved`. Each
row records the actor (`system` for automatic actions), the reason and a small
metadata object. Reading the trail for a target:

```
GET /api/v1/admin/moderation/audit?targetType=tip&targetId=<id>
```

## Notifications

When a report is resolved, the reporter is told the outcome through the existing
`email-notifications` queue (`template: notification`, `eventType:
report.resolved`), so the notification preference matrix applies to it like any
other event. A notification that cannot be queued is logged and the decision
still stands — the queue is not the record of the decision, the report row is.

## API

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/moderation/reports` | any user | File a report (returns the triage result) |
| `GET` | `/api/v1/moderation/reports/mine` | any user | Reports I filed |
| `POST` | `/api/v1/moderation/reports/:reportId/appeal` | content author | Appeal a resolved decision |
| `GET` | `/api/v1/admin/moderation/queue` | admin | Triage queue (filters, paging, counts) |
| `GET` | `/api/v1/admin/moderation/reports/:reportId` | admin | One report + audit trail + appeals |
| `POST` | `/api/v1/admin/moderation/reports/:reportId/claim` | admin | Pick it up (optionally re-prioritise) |
| `POST` | `/api/v1/admin/moderation/reports/:reportId/resolve` | admin | Close with `approved`/`denied` + action |
| `POST` | `/api/v1/admin/moderation/reports/:reportId/dismiss` | admin | Close as no-action |
| `POST` | `/api/v1/admin/moderation/content` | admin | Hide / restore / remove a target |
| `GET` | `/api/v1/admin/moderation/appeals` | admin | Appeal queue (`?status=pending`) |
| `POST` | `/api/v1/admin/moderation/appeals/:appealId/review` | admin | Accept or reject an appeal |
| `GET` | `/api/v1/admin/moderation/audit` | admin | Audit trail + content state for a target |

The queue is ordered by urgency and then oldest first, and reports the counts for
every status over the whole queue rather than just the current page. Claiming a
report assigns it to that moderator so two people do not review the same one.

## Appeals

One appeal per report, filed by the author of the reported content, and only once
the report is resolved. Accepting an appeal restores the content and records the
reversal; rejecting it leaves the decision in place. Either way the original
decision stays visible in the audit trail.
