import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const temporary = mkdtempSync(join(tmpdir(), 'copydesk-generated-'));
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}
try {
  const output = join(temporary, 'generated');
  const template = JSON.stringify({ version: 'v2', plugins: [{ local: ['bun', '--bun', 'node_modules/.bin/protoc-gen-es'], include_imports: true, out: output, opt: ['target=ts', 'import_extension=js'] }] });
  execFileSync('bun', ['--bun', 'node_modules/.bin/buf', 'generate', '--template', template], { stdio: 'inherit' });
  const expected = files(output).map((file) => relative(output, file)).sort();
  const actual = files('src/generated').map((file) => relative('src/generated', file)).sort();
  assert.deepEqual(actual, expected, 'Generated file inventory differs; run bun run generate');
  for (const file of expected) assert.equal(readFileSync(resolve('src/generated', file), 'utf8'), readFileSync(join(output, file), 'utf8'), `Stale generated binding: ${file}`);
  console.log(`Generated protocol is current (${expected.length} files).`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
