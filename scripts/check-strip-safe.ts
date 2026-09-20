/**
 * Guards against TypeScript that `tsc` accepts but Node refuses to run.
 *
 * We execute TypeScript directly under Node's type stripping, which is
 * *strip-only*: it erases types but performs no code generation. Parameter
 * properties, enums and namespaces all need emitted code, so Node throws
 * ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at import time — and `tsc` never warns,
 * because the syntax is perfectly valid TypeScript.
 *
 * This runs Node's own stripper over every source file, so the check is exact
 * rather than a regex guess at the same rules.
 *
 * Run: node scripts/check-strip-safe.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Only code Node runs directly. The client is bundled by Vite, which does
 *  full TypeScript compilation and has no strip-only restrictions. */
const ROOTS = ['packages/shared', 'packages/server', 'scripts'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const failures: { file: string; message: string }[] = [];
let checked = 0;

for (const root of ROOTS) {
  for (const file of walk(join(ROOT, root))) {
    checked++;
    try {
      stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' });
    } catch (err) {
      failures.push({
        file: relative(ROOT, file),
        message: err instanceof Error ? err.message.split('\n')[0]! : String(err),
      });
    }
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} file(s) use TypeScript syntax Node cannot run:\n`);
  for (const { file, message } of failures) console.error(`  ${file}\n    ${message}\n`);
  console.error('Rewrite parameter properties longhand; replace enums with const objects.\n');
  process.exit(1);
}

console.log(`strip-safe: ${checked} files OK`);
