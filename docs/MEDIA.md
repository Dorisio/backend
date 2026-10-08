# Tip message media

Tip messages can carry images and short videos (#64). A tip attaches media that
was uploaded **before** the tip was created, so the bytes are already verified,
scanned and (usually) processed by the time the tip is written.

```
POST /api/v1/media/uploads          reserve a slot, get an upload target
PUT  <upload target>                the bytes go to storage (S3, or the API in proxy mode)
POST /api/v1/media/uploads/:id/complete    verify type + size, scan, commit quota
POST /api/v1/transactions/tip       create the tip with `mediaIds: [...]`
GET  /api/v1/media/:id/content      serve the bytes (redirects to a signed URL on S3)
```

## Lifecycle

A row in `TipMedia` moves through a small, one-way state machine:

| Status | Meaning |
| --- | --- |
| `pending` | Slot reserved. Nothing stored, no quota committed. |
| `uploaded` | Bytes arrived (proxy mode) and are waiting for verification. |
| `scanning` | Being checked by the malware scanner. |
| `ready` | Verified, scanned clean, quota committed. **Attachable.** |
| `rejected` | Failed verification or the scan. Bytes were deleted. |
| `failed` | The upload never arrived, or the scanner could not run. |

Only `ready` media can be attached to a tip, and a tip can carry at most
`MAX_MEDIA_PER_TIP` (4) items. Read paths filter to `ready`, so a rejected or
in-flight upload is never visible to a reader even if its id is known.

`Derivative` production runs after `ready` and is tracked separately in
`processingStatus` (`pending` → `done` / `skipped` / `failed`). A processor that
is unavailable leaves the original in place and records why; it never blocks the
upload.

## What the bytes are, not what the client says

Both the declared `contentType` and the file name are attacker-controlled, so
`detectMimeType` sniffs the magic bytes and the result has to match the declared
type exactly. Supported: `image/jpeg`, `image/png`, `image/gif`, `image/webp`,
`video/mp4`, `video/webm`. Anything else is refused and removed.

Limits (`MEDIA_MAX_IMAGE_BYTES`, `MEDIA_MAX_VIDEO_BYTES`) are checked twice: at
reservation time, so an oversized upload is refused before any byte moves, and
again against what actually arrived in storage.

## Scanning

`MEDIA_SCANNER` selects the scanner:

- `clamav` — production. Talks the `INSTREAM` protocol to `CLAMAV_HOST:CLAMAV_PORT`.
- `eicar` — development. Recognises the EICAR test file and nothing else, and is
  recorded as `eicar` on the row so it can never be mistaken for a real engine.
- `none` — `FailClosedScanner`, which **refuses every upload**. It is what a
  misconfigured `clamav` deployment falls back to.

A scanner that cannot run is not a pass. The media is marked `failed` and the
error is surfaced, so an outage cannot silently turn into "everything is clean".

## Storage

`MEDIA_STORAGE=s3` presigns SigV4 query URLs — the browser PUTs straight to the
bucket and download endpoints redirect to a short-lived GET URL, so the API never
carries the bytes. `MEDIA_STORAGE=local` keeps files under `MEDIA_LOCAL_ROOT`,
resolved through a root guard that refuses any key escaping the directory.

`MEDIA_CDN_BASE_URL` switches every URL in a response over to the CDN. Without it
the API serves the bytes itself from `/api/v1/media/:id/content`.

`MEDIA_UPLOAD_MODE=proxy` accepts the file as base64 through
`PUT /api/v1/media/uploads/:id/content` for environments where clients cannot
reach the bucket directly.

## Quota

`MediaQuota` tracks committed bytes per user (`MEDIA_DEFAULT_QUOTA_BYTES`,
256 MiB by default). `usedBytes` only counts verified media; uploads that are
still in flight are reported separately as `reservedBytes`, and the reservation
is counted against the limit so a client cannot exceed the quota by starting many
uploads in parallel.

`GET /api/v1/media/quota` returns `usedBytes`, `reservedBytes`, `limitBytes`,
`fileCount` and `remainingBytes`.

Abandoned reservations are closed by `POST /api/v1/media/maintenance/prune`
(admin only), which deletes the bytes and marks the rows `failed` so the quota
they reserved is released.

## Serving and access control

`GET /api/v1/media/:id/content` serves the original or a derivative
(`?variant=preview|optimized|thumbnail`). A viewer may read media when they own
it, or when it is attached to a tip that is not moderated away — media whose tip
is `hidden` or `removed` stops being readable except by its owner.

## Tip responses

`TipResponse` carries a `media` array in attachment order:

```json
{
  "id": "tip_123",
  "message": "thanks!",
  "media": [
    {
      "id": "media_1",
      "kind": "image",
      "status": "ready",
      "mimeType": "image/png",
      "fileName": "photo.png",
      "sizeBytes": 2048,
      "width": 800,
      "height": 600,
      "url": "/api/v1/media/media_1/content",
      "previewUrl": "/api/v1/media/media_1/content?variant=preview",
      "thumbnailUrl": "/api/v1/media/media_1/content?variant=thumbnail",
      "processing": { "status": "done", "error": null },
      "attachedTipId": "tip_123"
    }
  ]
}
```

Media is attached once: an upload that belongs to another user, is not `ready`, or
is already on a tip makes the whole tip request fail with a `VALIDATION_ERROR`
listing every problem, so a tip never half-attaches.

## Deleting

`DELETE /api/v1/media/:id` removes the original and its derivatives and releases
the quota. Media that a tip is using cannot be deleted (409) — the tip would be
left pointing at nothing.
