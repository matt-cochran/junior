#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Transpile the production TypeScript modules to ESM JavaScript under dist/.
//
// This is a transpile-only build: it calls the TypeScript compiler's
// `transpileModule` API with `isolatedModules` and makes **no typecheck claim**.
// Legacy modules are emitted as-is; only relative `.ts` import specifiers are
// rewritten to the emitted `.js` files so the compiled runtime resolves its own
// module graph without any raw TypeScript or runtime compilation.
//
// The canonical skill is copied into `dist/skills` so the published package can
// install it, and the CLI entry is marked executable for direct invocation.
//
// Run in CI and local development only (`npm run build`, `pretest`, `prepack`).
// ---------------------------------------------------------------------------

import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist');

/** Directories that hold no production runtime modules. */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.delivery',
  '.github',
  '.artifacts',
  'tasks',
  'scripts',
]);

/** Collect production `.ts` modules (never tests or ambient declarations). */
function collect(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) collect(full, acc);
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.test.ts')
    ) {
      acc.push(full);
    }
  }
  return acc;
}

/** Rewrite relative TypeScript import specifiers to the emitted JavaScript. */
export function rewriteTsImports(code) {
  return code
    .replace(/(\bfrom\s*['"])(\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1$2.js$3')
    .replace(/(\bimport\s*\(\s*['"])(\.{1,2}\/[^'"]+)\.ts(['"]\s*\))/g, '$1$2.js$3');
}

export function transpile(file, source) {
  const { outputText, diagnostics } = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      isolatedModules: true,
      sourceMap: false,
      removeComments: false,
      newLine: ts.NewLineKind.LineFeed,
    },
  });
  const errors = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    const text = ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    });
    throw new Error(`Transpile failed for ${relative(root, file)}:\n${text}`);
  }
  return rewriteTsImports(outputText);
}

/** Build `dist/` from the production sources. Returns the emitted file list. */
export function build() {
  const files = ['junior.ts','worker.ts','setup.ts','runtime.ts','evidence.ts','isolation.ts','retention.ts','handoff.ts','hop-context.ts','installer.ts','cli-entry.ts','tools/tools.ts'].map((file) => join(root, file));
  rmSync(outDir, { recursive: true, force: true });
  const emitted = [];
  for (const file of files) {
    const dest = join(outDir, relative(root, file).replace(/\.ts$/, '.js'));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, transpile(file, readFileSync(file, 'utf8')));
    emitted.push(relative(root, dest));
  }

  // The published package must carry the canonical skill beside the compiled
  // setup module that resolves it (`dist/skills/junior/SKILL.md`).
  const skillSrc = join(root, 'skills', 'junior', 'SKILL.md');
  const skillDest = join(outDir, 'skills', 'junior', 'SKILL.md');
  mkdirSync(dirname(skillDest), { recursive: true });
  copyFileSync(skillSrc, skillDest);
  emitted.push(relative(root, skillDest));

  // npm sets the executable bit on bin shims, but a direct `node dist/junior.js`
  // or a copied checkout benefits from an executable entry.
  chmodSync(join(outDir, 'junior.js'), 0o755);
  return emitted;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const emitted = build();
  console.log(`Built ${emitted.length} files into ${relative(root, outDir)}/`);
}
