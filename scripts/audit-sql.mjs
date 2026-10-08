import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const forbidden = /\$(?:queryRaw|executeRaw)Unsafe\s*\(/g;
async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await collect(file)));
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) result.push(file);
  }
  return result;
}

const files = await collect('src');

const violations = [];
for (const file of files) {
  const source = await readFile(file, 'utf8');
  if (forbidden.test(source)) {
    violations.push(`${file}: unsafe Prisma raw-query API`);
  }
  forbidden.lastIndex = 0;
}

if (violations.length > 0) {
  console.error('Unsafe SQL APIs are not permitted in application code:');
  console.error(violations.join('\n'));
  process.exit(1);
}

console.log(`SQL safety audit passed (${files.length} application files checked).`);
