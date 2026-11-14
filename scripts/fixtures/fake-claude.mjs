#!/usr/bin/env node
// Offline Claude Code stand-in for scripts/claude-smoke.mjs --self-test.
//
// It accepts the same argv shape as `claude -p ... --output-format json` and
// prints one JSON result. Prompts that ask for a .crossmatrix command get a
// matching permission_denials entry; FAKE_CLAUDE_WARN=1 adds the permission
// warning the smoke must reject.

import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const promptIndex = argv.indexOf('-p');
const prompt = promptIndex >= 0 ? (argv[promptIndex + 1] ?? '') : '';

const COMMANDS = [
  'grep -r x .crossmatrix',
  'jq . .crossmatrix/state/a.json',
];

function commandFrom(prompt) {
  const known = COMMANDS.find((command) => prompt.includes(command));
  if (known) return known;
  const requested = prompt.match(/(?:exactly this command and nothing else:|run:)\s*([^\n]+)/i);
  if (requested?.[1]?.includes('.crossmatrix')) return requested[1].trim();
  return prompt.includes('.crossmatrix') ? '.crossmatrix' : null;
}

const warn = process.env.FAKE_CLAUDE_WARN === '1';
const command = commandFrom(prompt);
const permissionDenials = command && !warn
  ? [{ tool_name: 'Bash', tool_input: { command } }]
  : [];

if (warn) {
  // Real Claude Code reports rule problems in its debug log, not on stderr.
  const debugIndex = argv.indexOf('--debug-file');
  const debugFile = debugIndex >= 0 ? argv[debugIndex + 1] : null;
  const line = '[WARN] [permissions] Permission deny rule (.claude/settings.json): Write(./.crossmatrix/**) is not matched by file permission checks\n';
  if (debugFile) writeFileSync(debugFile, line);
}

process.stdout.write(`${JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: command ? 'denied' : 'allowed',
  permission_denials: permissionDenials,
})}\n`);
