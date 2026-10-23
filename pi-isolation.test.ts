// ---------------------------------------------------------------------------
// Behavioral tests for Pi process isolation in pi-isolation.ts.
//
// The help excerpt is a trimmed copy of `pi --offline --no-approve --help`
// captured from the installed Pi 1.0.4 CLI (every option line is unchanged in
// Pi 1.4.0), so capability parsing is exercised
// against real option text rather than a hand-written list.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  DEFAULT_PI_TOOLS,
  ISOLATION_FLAGS,
  buildIsolationArgs,
  parsePiCapabilities,
  validatePiContext,
  verifyIsolation,
} from './pi-isolation.ts';

const REAL_PI_HELP = `pi - AI coding assistant with read, bash, edit, write tools

Usage:
  pi [options] [--] [@files...] [messages...]

Options:
  --provider <name>              Provider to search for --model (requires --model)
  --model <pattern>              Model pattern or ID (supports "provider/id" and optional ":<thinking>")
  --system-prompt <text>         System prompt (default: coding assistant prompt)
  --append-system-prompt <text>  Append text or file contents to the system prompt (can be used multiple times)
  --mode <mode>                  Output mode: text (default), json, or rpc
  --print, -p                    Non-interactive mode: process prompt and exit
  --continue, -c                 Continue previous session
  --session <path|id>            Use specific session file or partial UUID
  --no-tools, -nt                Disable all tools by default (built-in and extension)
  --tools, -t <tools>            Comma-separated allowlist of tool names or patterns (*) to enable
  --thinking <level>             Set thinking level: off, minimal, low, medium, high, xhigh, max
  --extension, -e <path>         Load an extension file or builtin:<name> (can be used multiple times)
  --no-extensions, -ne           Disable extension discovery and built-in extensions (explicit -e paths still work)
  --no-mcp                       Disable built-in MCP support: no servers connect and no MCP tools
  --skill <path>                 Load a skill file or directory (can be used multiple times)
  --no-skills, -ns               Disable skills discovery and loading
  --prompt-template <path>       Load a prompt template file or directory (can be used multiple times)
  --no-prompt-templates, -np     Disable prompt template discovery and loading
  --no-context-files, -nc        Disable AGENTS.md and CLAUDE.md discovery and loading
  --approve, -a                  Trust project-local files for this run
  --no-approve, -na              Ignore project-local files for this run
  --offline                      Disable startup network operations (same as PI_OFFLINE=1)
  --help, -h                     Show this help
  --version, -v                  Show version number

Extensions can register additional flags (e.g., --plan from plan-mode extension).
`;

const FULL_CAPABILITIES = parsePiCapabilities(REAL_PI_HELP);

test('default context with full capabilities emits every isolation flag and default tools', () => {
  const result = buildIsolationArgs(undefined, FULL_CAPABILITIES);
  assert.deepEqual(result.args, [
    ...ISOLATION_FLAGS,
    '--tools',
    DEFAULT_PI_TOOLS.join(','),
  ]);
});

test('a capability set lacking --no-mcp omits it and reports it as missing', () => {
  const result = buildIsolationArgs(undefined, { flags: new Set(['--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-approve', '--tools']) });
  assert.deepEqual({ args: result.args.includes('--no-mcp'), missing: result.missing }, { args: false, missing: ['--no-mcp'] });
});

test('ambient context emits no isolation flags', () => {
  const result = buildIsolationArgs({ ambient: true }, FULL_CAPABILITIES);
  assert.deepEqual(result.args.filter((arg) => (ISOLATION_FLAGS as readonly string[]).includes(arg)), []);
});

test('explicit skills, context files and extensions are emitted in ambient mode', () => {
  const result = buildIsolationArgs({
    ambient: true,
    skills: ['/skills/review'],
    contextFiles: ['/context/AGENTS.md'],
    extensions: ['/ext/guard.ts'],
  }, FULL_CAPABILITIES);
  assert.deepEqual(result.args, [
    '--skill', '/skills/review',
    '--append-system-prompt', '/context/AGENTS.md',
    '-e', '/ext/guard.ts',
  ]);
});

test('an explicit tool list replaces the default tool list', () => {
  const result = buildIsolationArgs({ tools: ['read', 'bash'] }, FULL_CAPABILITIES);
  assert.deepEqual(result.args.slice(-2), ['--tools', 'read,bash']);
});

test('null capabilities assume every isolation flag is supported', () => {
  const result = buildIsolationArgs(undefined, null);
  assert.deepEqual(result.missing, []);
});

test('a capability set lacking --tools omits the tool allowlist and reports it as missing', () => {
  const result = buildIsolationArgs(undefined, { flags: new Set(ISOLATION_FLAGS) });
  assert.deepEqual(result.missing, ['--tools']);
});

test('parsePiCapabilities recognises flags from real pi help text', () => {
  assert.equal(FULL_CAPABILITIES.flags.has('--no-mcp'), true);
});

test('parsePiCapabilities recognises long flags containing multiple hyphens', () => {
  assert.equal(FULL_CAPABILITIES.flags.has('--append-system-prompt'), true);
});

test('validatePiContext accepts an undefined context', () => {
  assert.equal(validatePiContext(undefined), null);
});

test('validatePiContext accepts a fully populated context', () => {
  assert.equal(validatePiContext({
    ambient: true,
    tools: ['read'],
    skills: ['/skills/review'],
    contextFiles: ['/context/AGENTS.md'],
    extensions: ['/ext/guard.ts'],
  }), null);
});

test('validatePiContext rejects a non-array tools field with a field-specific message', () => {
  assert.equal(validatePiContext({ tools: 'read' }), 'Invalid piContext.tools (expected an array of non-empty strings)');
});

test('validatePiContext rejects an empty string in skills with a field-specific message', () => {
  assert.equal(validatePiContext({ skills: [''] }), 'Invalid piContext.skills (expected an array of non-empty strings)');
});

test('validatePiContext rejects a non-boolean ambient field with a field-specific message', () => {
  assert.equal(validatePiContext({ ambient: 'yes' }), 'Invalid piContext.ambient (expected a boolean)');
});

test('validatePiContext rejects an unknown field', () => {
  assert.equal(validatePiContext({ tools: ['read'], sandbox: true }), 'Invalid piContext.sandbox (unknown field)');
});

test('validatePiContext rejects a non-object context', () => {
  assert.equal(validatePiContext(null), 'Invalid piContext (expected an object)');
});

test('ambient context without an explicit tool list emits no tool allowlist', () => {
  assert.equal(buildIsolationArgs({ ambient: true }, FULL_CAPABILITIES).args.includes('--tools'), false);
});

test('ambient context with an explicit tool list still emits it', () => {
  assert.deepEqual(buildIsolationArgs({ ambient: true, tools: ['read'] }, FULL_CAPABILITIES).args, ['--tools', 'read']);
});

const systemEvent = (sections: Record<string, string>): string =>
  JSON.stringify({ type: 'message_start', message: { role: 'system', content: '', sections } });

test('verifyIsolation passes an isolated system message with only allowlisted tools', () => {
  const events = systemEvent({ skills: '', tools: '<tools>\n- read: Read\n- bash: Run\n</tools>' });
  assert.equal(verifyIsolation(events, { applied: ['--no-skills', '--tools'], tools: ['read', 'bash'] }).honored, true);
});

test('verifyIsolation flags ambient skills when --no-skills was applied', () => {
  const events = systemEvent({ skills: '<skills><name>wrangler</name></skills>', tools: '' });
  assert.deepEqual(verifyIsolation(events, { applied: ['--no-skills'], tools: [] }).problems, ['ambient skills present despite --no-skills']);
});

test('verifyIsolation flags a tool outside the allowlist', () => {
  const events = systemEvent({ skills: '', tools: '<tools>\n- read: Read\n- codemode: Run JS\n</tools>' });
  assert.deepEqual(verifyIsolation(events, { applied: ['--tools'], tools: ['read'] }).problems, ['tools outside the allowlist: codemode']);
});

test('verifyIsolation reports unchecked when the stream has no system message', () => {
  assert.equal(verifyIsolation('{"type":"agent_start"}\n', { applied: ['--no-skills'], tools: [] }).checked, false);
});
