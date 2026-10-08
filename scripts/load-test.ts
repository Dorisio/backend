import { performance } from 'node:perf_hooks'

export interface LoadTestResult {
  concurrency: number
  requests: number
  successful: number
  failed: number
  throughput: number
  latencyMs: { p50: number; p95: number; p99: number; max: number }
}

const target = process.env.LOAD_TEST_URL ?? 'http://127.0.0.1:3000/health'
const durationMs = Number(process.env.LOAD_TEST_DURATION_MS ?? 10_000)
const levels = (process.env.LOAD_TEST_CONCURRENCY ?? '100,1000,10000')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0)

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const index = Math.min(values.length - 1, Math.ceil(values.length * p) - 1)
  return values[index]!
}

export async function runLoadTest(concurrency: number, url = target): Promise<LoadTestResult> {
  const latencies: number[] = []
  let successful = 0
  let failed = 0
  const started = performance.now()
  const deadline = started + durationMs

  async function worker(): Promise<void> {
    while (performance.now() < deadline) {
      const requestStarted = performance.now()
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(1000, durationMs)) })
        const latency = performance.now() - requestStarted
        latencies.push(latency)
        if (response.ok) successful += 1
        else failed += 1
      } catch {
        failed += 1
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  const elapsedSeconds = (performance.now() - started) / 1000
  latencies.sort((a, b) => a - b)
  return {
    concurrency,
    requests: successful + failed,
    successful,
    failed,
    throughput: (successful + failed) / elapsedSeconds,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: latencies.at(-1) ?? 0,
    },
  }
}

async function main(): Promise<void> {
  if (levels.length === 0) throw new Error('LOAD_TEST_CONCURRENCY must contain a positive integer')
  console.error(`Load testing ${target} for ${durationMs}ms at ${levels.join(', ')} concurrent users`)
  const results: LoadTestResult[] = []
  for (const concurrency of levels) {
    const result = await runLoadTest(concurrency)
    results.push(result)
    console.log(JSON.stringify(result))
  }
  if (process.env.LOAD_TEST_OUTPUT) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(process.env.LOAD_TEST_OUTPUT, `${JSON.stringify({ target, durationMs, results }, null, 2)}\n`)
  }
}

if (process.argv[1]?.endsWith('load-test.ts')) void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
