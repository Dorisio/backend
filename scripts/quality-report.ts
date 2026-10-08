import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

interface CoverageSummary {
  lines?: { pct?: number };
  statements?: { pct?: number };
  functions?: { pct?: number };
  branches?: { pct?: number };
}
interface QualityReport {
  generatedAt: string;
  commit: string;
  metrics: {
    sloc: number;
    files: number;
    cyclomaticComplexity: { average: number; max: number };
    duplicationPercent: number;
    coveragePercent: number | null;
  };
  gates: Record<string, { threshold: string; value: number | null; passed: boolean | null }>;
  regressions: string[];
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules')
      files.push(...(await sourceFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
      files.push(path);
  }
  return files;
}

function complexities(source: string): number[] {
  const bodies = [
    ...source.matchAll(
      /(?:function\s+\w+|\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>|^\s*(?:async\s+)?\w+\s*\([^)]*\)\s*\{)[^\{]*\{([\s\S]*?)(?:\n\s*\}|$)/gm
    ),
  ].map((match) => match[1] ?? '');
  const units = bodies.length > 0 ? bodies : [source];
  return units.map(
    (unit) => 1 + (unit.match(/\b(if|for|while|case|catch)\b|&&|\|\||\?/g)?.length ?? 0)
  );
}

function duplicatePercent(sources: string[]): number {
  const lines = sources.flatMap((source) =>
    source
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.length >= 8 &&
          !line.startsWith('//') &&
          !line.startsWith('/*') &&
          line !== '}' &&
          line !== '});'
      )
  );
  if (lines.length < 20) return 0;
  const counts = new Map<string, number>();
  for (let i = 0; i + 3 < lines.length; i += 1) {
    const key = lines
      .slice(i, i + 4)
      .join('\n')
      .replace(/\s+/g, ' ');
    if (key.split('\n').filter((line) => line.length >= 15).length >= 3)
      counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const duplicatedWindows = [...counts.values()]
    .filter((count) => count > 1)
    .reduce((sum, count) => sum + count, 0);
  return Number(((duplicatedWindows * 4 * 100) / lines.length).toFixed(2));
}

async function coverage(): Promise<number | null> {
  try {
    const summary = JSON.parse(await readFile('coverage/coverage-summary.json', 'utf8')) as {
      total?: CoverageSummary;
    };
    const total = summary.total;
    return total?.lines?.pct ?? total?.statements?.pct ?? null;
  } catch {
    return null;
  }
}

function gate(value: number | null, threshold: number, direction: 'min' | 'max') {
  if (value === null) return { threshold: `${direction} ${threshold}`, value, passed: null };
  return {
    threshold: `${direction} ${threshold}`,
    value,
    passed: direction === 'min' ? value >= threshold : value <= threshold,
  };
}

async function main(): Promise<void> {
  const files = await sourceFiles('src');
  const sources = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  const complexityValues = sources.flatMap(complexities);
  const coveragePercent = await coverage();
  const metrics = {
    sloc: sources.reduce(
      (sum, source) =>
        sum +
        source.split('\n').filter((line) => line.trim() && !line.trim().startsWith('//')).length,
      0
    ),
    files: files.length,
    cyclomaticComplexity: {
      average: Number(
        (
          complexityValues.reduce((sum, value) => sum + value, 0) /
          Math.max(1, complexityValues.length)
        ).toFixed(2)
      ),
      max: Math.max(0, ...complexityValues),
    },
    duplicationPercent: duplicatePercent(sources),
    coveragePercent,
  };
  const gates = {
    coverage: gate(metrics.coveragePercent, Number(process.env.QUALITY_MIN_COVERAGE ?? 80), 'min'),
    duplication: gate(
      metrics.duplicationPercent,
      Number(process.env.QUALITY_MAX_DUPLICATION ?? 3),
      'max'
    ),
    complexity: gate(
      metrics.cyclomaticComplexity.max,
      Number(process.env.QUALITY_MAX_COMPLEXITY ?? 10),
      'max'
    ),
  };

  const historyPath = process.env.QUALITY_HISTORY_PATH ?? 'quality-reports/history.json';
  let history: QualityReport[] = [];
  try {
    history = JSON.parse(await readFile(historyPath, 'utf8')) as QualityReport[];
  } catch {
    /* first run */
  }
  const regressions: string[] = [];
  const previous = history.at(-1);
  if (previous) {
    if (
      metrics.coveragePercent !== null &&
      previous.metrics.coveragePercent !== null &&
      metrics.coveragePercent < previous.metrics.coveragePercent - 1
    )
      regressions.push('coverage dropped by more than 1 percentage point');
    if (metrics.duplicationPercent > previous.metrics.duplicationPercent + 1)
      regressions.push('duplication increased by more than 1 percentage point');
    if (metrics.cyclomaticComplexity.max > previous.metrics.cyclomaticComplexity.max + 2)
      regressions.push('maximum complexity increased by more than 2');
  }
  const report: QualityReport = {
    generatedAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? 'local',
    metrics,
    gates,
    regressions,
  };
  history.push(report);
  await mkdir('quality-reports', { recursive: true });
  await writeFile('quality-reports/current.json', `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`);
  await writeFile(
    'quality-reports/dashboard.md',
    `# Code Quality Dashboard\n\nGenerated: ${report.generatedAt}\n\n| Metric | Value | Gate |\n| --- | ---: | --- |\n| Source files | ${metrics.files} | — |\n| SLOC | ${metrics.sloc} | — |\n| Coverage | ${metrics.coveragePercent === null ? 'not available' : `${metrics.coveragePercent}%`} | ${gates.coverage.threshold} |\n| Duplication | ${metrics.duplicationPercent}% | ${gates.duplication.threshold} |\n| Max complexity | ${metrics.cyclomaticComplexity.max} | ${gates.complexity.threshold} |\n\n${regressions.length ? `## Regressions\n\n${regressions.map((item) => `- ${item}`).join('\\n')}` : 'No regressions detected.'}\n`
  );
  await writeFile(
    'quality-reports/index.html',
    `<!doctype html><meta charset="utf-8"><title>Code Quality Dashboard</title><h1>Code Quality Dashboard</h1><pre>${JSON.stringify(report, null, 2)}</pre>`
  );

  const failed =
    regressions.length > 0 ||
    (process.env.QUALITY_ALLOW_EXISTING_FAILURES !== 'true' &&
      Object.values(gates).some((result) => result.passed === false));
  if (process.env.QUALITY_ENFORCE === 'true' && failed) process.exitCode = 1;
  console.log(JSON.stringify(report, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
