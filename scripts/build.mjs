#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Transpile the production TypeScript modules to ESM JavaScript under dist/.
//
// This is a transpile-only build: it runs the TypeScript 7 native `tsc` once
// over every production module with `--noCheck --isolatedModules --noResolve`
// and makes **no typecheck claim**. The file list and compiler options go in a
// generated tsconfig in an OS temp dir (no command-line length limit), and tsc
// is launched as `node <typescript/bin/tsc>` so no PATH or `.bin` shim is
// involved. Legacy modules are emitted as-is; only relative `.ts` import
// specifiers are rewritten to the emitted `.js` files so the compiled runtime
// resolves its own module graph without any raw TypeScript or runtime
// compilation. (`--rewriteRelativeImportExtensions` is not used: it wraps the
// non-literal `import()` in worker-gates.ts with a runtime helper.)
//
// The canonical skill is copied into `dist/skills` so the published package can
// install it, and the CLI entry is marked executable for direct invocation.
//
// Run in CI and local development only (`npm run build`, `pretest`, `prepack`).
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Compiler options for the transpile-only emit (paths are set per build). */
const COMPILER_OPTIONS = {
  noCheck: true,
  isolatedModules: true,
  module: 'esnext',
  target: 'es2022',
  moduleResolution: 'bundler',
  noResolve: true,
  newLine: 'lf',
  types: [],
  sourceMap: false,
  removeComments: false,
};

/**
 * Emit every file through the native tsc into a fresh temp dir and return each
 * emitted `.js` as `{ rel, code }` (its path relative to the repo), removing the
 * temp dir afterwards. Throws with tsc's output if tsc exits non-zero.
 */
function emitWithTsc(files) {
  // `typescript/bin/tsc` is not in the package's exports map, so locate it
  // through the exported package.json and its `bin.tsc` entry.
  const pkgJson = createRequire(import.meta.url).resolve('typescript/package.json');
  const tsc = join(dirname(pkgJson), JSON.parse(readFileSync(pkgJson, 'utf8')).bin.tsc);
  const tmp = mkdtempSync(join(tmpdir(), 'junior-build-'));
  try {
    const emitDir = join(tmp, 'out');
    const tsconfig = join(tmp, 'tsconfig.json');
    // A tsconfig resolves its paths relative to itself, so every path is absolute.
    writeFileSync(
      tsconfig,
      JSON.stringify({
        compilerOptions: { ...COMPILER_OPTIONS, rootDir: root, outDir: emitDir },
        files,
      }),
    );
    try {
      execFileSync(process.execPath, [tsc, '--project', tsconfig], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const output = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
      throw new Error(`tsc failed (exit ${error.status ?? error.signal ?? 'unknown'}):\n${output || error.message}`);
    }
    return files.map((file) => {
      const rel = relative(root, file).replace(/\.ts$/, '.js');
      return { rel, code: readFileSync(join(emitDir, rel), 'utf8') };
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Build `dist/` from the production sources. Returns the emitted file list. */
export function build() {
  // Every production module is collected, so a new module can never be left
  // out of the published package (tests, declarations and tooling excluded).
  const files = collect(root).sort();
  // Compile first, so a tsc failure leaves the previous dist/ in place.
  const outputs = emitWithTsc(files);
  rmSync(outDir, { recursive: true, force: true });
  const emitted = [];
  for (const { rel, code } of outputs) {
    const dest = join(outDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, rewriteTsImports(code));
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
