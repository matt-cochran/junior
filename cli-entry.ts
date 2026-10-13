// ---------------------------------------------------------------------------
// Robust "is this module the process entry point?" guard shared by the CLI
// modules.
//
// The CLI entry can be reached in several ways:
//   • `node junior.ts` from a source checkout,
//   • `node dist/junior.js` from a build or a direct invocation,
//   • the npm-installed `junior` shim, which on Unix is a symlink under
//     `node_modules/.bin` and on Windows is a generated `.cmd` that invokes the
//     real `dist/junior.js`.
//
// Comparing the raw `process.argv[1]` string against `import.meta.url` fails for
// the Unix symlink shim (the module URL is the resolved real path while argv[1]
// is the symlink) and is brittle across path spellings. Resolving both sides
// with `realpathSync` makes the guard work for source, compiled, and symlinked
// entry points, while importing any of these modules as a library never runs the
// CLI.
// ---------------------------------------------------------------------------

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** True only when this module is the process entry point. */
export function isDirectEntry(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

/** Resolve the package version from the package.json beside the module (source
 * checkout) or its parent (compiled `dist/`), with no runtime dependency. */
export function readPackageVersion(moduleUrl: string): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  for (const candidate of [join(moduleDir, 'package.json'), join(moduleDir, '..', 'package.json')]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
      if (typeof parsed?.version === 'string' && parsed.version) return parsed.version;
    } catch {
      /* try the next layout */
    }
  }
  return '0.0.0';
}

/** How to spawn `command` with argv on `platform`. On Windows, npm and npx are
 * `.cmd` shims, and companion CLIs installed by npm resolve to `.cmd` shims too;
 * Node refuses to spawn a `.cmd`/`.bat` without a shell, so those run through
 * the shell with every argument quoted when it contains spaces or quotes.
 * Native executables and every other platform keep argv with no shell. */
export function spawnSpec(command: string, args: string[], platform: NodeJS.Platform = process.platform): { command: string; args: string[]; shell: boolean } {
  if (platform !== 'win32') return { command, args, shell: false };
  const resolved = command === 'npm' || command === 'npx' ? `${command}.cmd` : command;
  if (!/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, args, shell: false };
  const quote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  return { command: quote(resolved), args: args.map(quote), shell: true };
}
