import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const forbidden = /(?:^|[/@._-])(studio|pi-coding-agent|pi-agent-core|pi-tui|pi-components|beads|task-runtime|zellij)(?:$|[/@._-])/i;

// Inspect syntax, including type-only imports, rather than matching comments or source text.
function inspect(sources, dependencies = []) {
  const failures = [];
  const graph = new Map();
  for (const dependency of dependencies) {
    if (forbidden.test(dependency)) failures.push(`Forbidden host dependency: ${dependency}`);
  }
  for (const [filename, source] of sources) {
    const edges = [];
    graph.set(filename, edges);
    const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
    const record = (node) => {
      if (!node || !ts.isStringLiteralLike(node)) {
        failures.push(`${filename}: non-literal module dependency cannot establish independence`);
        return;
      }
      const specifier = node.text;
      if (forbidden.test(specifier)) failures.push(`${filename}: forbidden dependency ${specifier}`);
      if (path.isAbsolute(specifier)) {
        failures.push(`${filename}: absolute module dependency ${specifier}`);
      } else if (specifier.startsWith('.')) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(filename), specifier));
        if (!resolved.startsWith('src/')) {
          failures.push(`${filename}: module escapes the independent source root: ${specifier}`);
          return;
        }
        const stem = resolved.replace(/\.[cm]?js$/, '');
        const target = [resolved, `${stem}.ts`, `${stem}.mts`, `${stem}/index.ts`].find((candidate) => sources.has(candidate));
        if (target) edges.push(target);
        else failures.push(`${filename}: unresolved local module ${specifier}`);
      }
    };
    const visit = (node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) record(node.moduleSpecifier);
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        record(node.moduleReference.expression);
      } else if (ts.isImportTypeNode(node)) {
        record(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        record(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  const complete = new Set();
  const visiting = [];
  const walk = (filename) => {
    const cycleStart = visiting.indexOf(filename);
    if (cycleStart >= 0) {
      failures.push(`Source dependency cycle: ${[...visiting.slice(cycleStart), filename].join(' -> ')}`);
      return;
    }
    if (complete.has(filename)) return;
    visiting.push(filename);
    for (const target of graph.get(filename) ?? []) walk(target);
    visiting.pop();
    complete.add(filename);
  };
  for (const filename of sources.keys()) walk(filename);
  return [...new Set(failures)];
}

async function sourcesBelow(directory = 'src') {
  const sources = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Source symlink crosses the auditable boundary: ${filename}`);
    if (entry.isDirectory()) {
      for (const [name, text] of await sourcesBelow(filename)) sources.set(name, text);
    } else if (/\.[cm]?tsx?$/.test(entry.name)) {
      sources.set(filename, await readFile(filename, 'utf8'));
    }
  }
  return sources;
}

if (process.argv.includes('--self-test')) {
  const check = (entries, dependencies = []) => inspect(new Map(entries), dependencies);
  assert.deepEqual(check([['src/index.ts', 'export type { Port } from "./port.js"'], ['src/port.ts', 'export interface Port {}']]), []);
  for (const source of ['import type { Attempt } from "studio"', 'type X = import("@lanej/task-runtime").X', 'export { x } from "../../studio/host.ts"', 'const x = require("@mariozechner/pi-coding-agent")', 'await import(moduleName)', 'import "/private/tmp/host.ts"']) {
    assert.ok(check([['src/index.ts', source]]).length > 0, source);
  }
  assert.ok(check([['src/a.ts', 'import "./b.js"'], ['src/b.ts', 'import type { X } from "./a.js"']]).some((failure) => failure.includes('cycle')));
  assert.ok(check([['src/index.ts', 'export {};']], ['@lanej/studio']).length > 0);
  assert.deepEqual(check([['src/index.ts', '// Studio is a possible consumer.\nexport {};']], ['@connectrpc/connect']), []);
  process.stdout.write('Boundary sensitivity: 10 cases passed.\n');
} else {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const dependencies = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})];
  const sources = await sourcesBelow();
  const failures = inspect(sources, dependencies);
  if (failures.length) {
    process.stderr.write(`${failures.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Independent source boundary: ${sources.size} files; no forbidden imports or cycles.\n`);
  }
}
