import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config/env'

type JsonRecord = Record<string, unknown>

function selectedFields(request: FastifyRequest): Set<string> | undefined {
  const raw = (request.query as { fields?: unknown } | undefined)?.fields
  if (typeof raw !== 'string') return undefined
  const fields = raw.split(',').map((field) => field.trim()).filter(Boolean)
  return fields.length > 0 ? new Set(fields) : undefined
}

function projectPayload(payload: unknown, fields: Set<string> | undefined): unknown {
  if (!fields || payload === null || typeof payload !== 'object') return payload
  if (Array.isArray(payload)) return payload.map((item) => projectPayload(item, fields))
  return Object.fromEntries(Object.entries(payload as JsonRecord)
    .filter(([key]) => fields.has(key))
    .map(([key, value]) => [key, projectPayload(value, fields)]))
}

/** Adds safe cache metadata and optional sparse fieldsets to JSON responses. */
export function registerResponseOptimization(app: FastifyInstance): void {
  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload) => {
    if (request.method === 'GET' && !reply.getHeader('cache-control')) {
      reply.header('cache-control', config.RESPONSE_CACHE_CONTROL)
    }

    const fields = selectedFields(request)
    if (!fields || typeof payload !== 'string' || !reply.getHeader('content-type')?.toString().includes('json')) {
      return payload
    }

    try {
      return JSON.stringify(projectPayload(JSON.parse(payload), fields))
    } catch {
      return payload
    }
  })
}
