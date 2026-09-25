# Pagination & Cursor-Based Navigation API Guide

This document outlines the architecture, usage, and best practices for pagination across the Dorisio backend API.

---

## 1. Overview

To prevent memory exhaustion and reduce response times on large datasets, all listing endpoints support standardized pagination, sorting, and filtering:

- **Offset/Limit Pagination:** Ideal for user interfaces with explicit page numbers and jumping to specific pages.
- **Cursor-Based (Keyset) Pagination:** Recommended for high-volume datasets, infinite scrolling, real-time feeds, and large result sets to avoid `OFFSET` performance degradation.

---

## 2. Limits & Defaults

| Parameter | Type | Default | Minimum | Maximum | Description |
|---|---|---|---|---|---|
| `page` | Integer | `1` | `1` | - | Page number (offset pagination) |
| `pageSize` / `limit` | Integer | `20` | `1` | `100` | Number of items per page |
| `first` | Integer | `20` | `1` | `100` | Number of items to fetch after cursor |
| `last` | Integer | `20` | `1` | `100` | Number of items to fetch before cursor |
| `cursor` / `after` | String | - | - | - | Opaque Base64 URL-safe keyset cursor |
| `before` | String | - | - | - | Opaque Base64 URL-safe keyset cursor |
| `sortBy` | String | `createdAt` | - | - | Single or comma-separated column names (supports `+` / `-`) |
| `sortOrder` | Enum | `desc` | - | - | Direction: `asc` or `desc` |

Any request specifying negative values, `page < 1`, `pageSize > 100`, invalid base64 cursor strings, or conflicting options (e.g. `first` + `last`) will be rejected with HTTP 400 (`VALIDATION_ERROR`).

---

## 3. Offset Pagination

### Request Example
```http
GET /api/v1/transactions/history?page=2&pageSize=20&sortBy=amount&sortOrder=desc HTTP/1.1
Host: api.dorisio.com
Authorization: Bearer <jwt_token>
```

### Response Format
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "tip_clh4x8901",
        "amount": 50.0,
        "status": "completed",
        "createdAt": "2026-06-15T12:00:00.000Z"
      }
    ],
    "total": 85,
    "page": 2,
    "pageSize": 20,
    "totalPages": 5,
    "hasNext": true,
    "hasPrev": true
  },
  "timestamp": "2026-06-15T12:05:00.000Z"
}
```

---

## 4. Cursor-Based Pagination

Cursor-based pagination encodes database keyset coordinates into an opaque, URL-safe Base64 token. This eliminates `OFFSET` full-table scans in PostgreSQL and avoids exposing internal database primary key structures.

### Request Example (Initial Page)
```http
GET /api/v1/transactions/creator/creator_123?first=20&sortBy=createdAt&sortOrder=desc HTTP/1.1
Host: api.dorisio.com
```

### Response Format
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "tip_clh4x8901",
        "amount": 100.0,
        "status": "completed",
        "createdAt": "2026-06-15T12:00:00.000Z"
      }
    ],
    "cursor": "eyJpZCI6InRpcF9jbGg0eDg5MDEiLCJ2YWx1ZXMiOnt9fQ",
    "nextCursor": "eyJpZCI6InRpcF9jbGg0eDg5MDEiLCJ2YWx1ZXMiOnt9fQ",
    "prevCursor": null,
    "hasMore": true,
    "pageInfo": {
      "hasNextPage": true,
      "hasPreviousPage": false,
      "startCursor": "eyJpZCI6InRpcF9jbGg0eDg5MDAiLCJ2YWx1ZXMiOnt9fQ",
      "endCursor": "eyJpZCI6InRpcF9jbGg0eDg5MDEiLCJ2YWx1ZXMiOnt9fQ",
      "totalCount": 15000
    }
  },
  "timestamp": "2026-06-15T12:05:00.000Z"
}
```

### Request Example (Next Page with Cursor)
```http
GET /api/v1/transactions/creator/creator_123?first=20&after=eyJpZCI6InRpcF9jbGg0eDg5MDEiLCJ2YWx1ZXMiOnt9fQ HTTP/1.1
Host: api.dorisio.com
```

---

## 5. Sorting & Multi-Column Ordering

Sorting can be specified via query parameters using standard or prefix notations:

- `sortBy=createdAt&sortOrder=desc`
- `sortBy=-amount,+createdAt` (Prefix `-` = descending, `+` = ascending)
- Secondary ordering by `id` is automatically appended to ensure deterministic cursor positioning.

---

## 6. Filtering

Endpoints support domain-specific filtering:
- `status`: Filter by transaction or webhook status (e.g. `pending`, `completed`, `failed`).
- `search`: Case-insensitive text search (e.g. `username` / `displayName`).
- `verifiedOnly`: Boolean flag for verified creators.

Example:
```http
GET /api/v1/transactions/history?status=completed&page=1&pageSize=20 HTTP/1.1
```

---

## 7. Error Handling

Invalid pagination parameters return standard error payloads:

```json
{
  "success": false,
  "error": {
    "message": "Page size / limit must be an integer between 1 and 100",
    "code": "VALIDATION_ERROR"
  },
  "timestamp": "2026-06-15T12:00:00.000Z"
}
```
