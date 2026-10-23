// ---------------------------------------------------------------------------
// Build the Pi argv that isolates a run from ambient project configuration.
//
// Older Pi releases reject flags they do not know, so callers parse the
// installed CLI's help text and pass only supported options. Explicit skills,
// context files and extensions are always forwarded because they are user
// intent rather than ambient discovery.
// ---------------------------------------------------------------------------

/** Flags that disable ambient extensions, skills, context files, prompt
 * templates, project trust and MCP servers, in stable emission order. */
export const ISOLATION_FLAGS = ['--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-approve', '--no-mcp'] as const;

/** Built-in tools enabled when a run does not request an explicit allowlist. */
export const DEFAULT_PI_TOOLS = ['read', 'bash', 'edit', 'write'] as const;

/** Long options advertised by the installed Pi CLI. */
export type PiCapabilities = { flags: ReadonlySet<string> };

/** Collect every long option token (`--name`) from Pi's help output. */
export function parsePiCapabilities(helpText: string): PiCapabilities {
  const flags = new Set<string>();
  for (const match of helpText.matchAll(/--[a-z][a-z-]*/g)) flags.add(match[0]);
  return { flags };
}

/** Per-run Pi configuration supplied by the task author. */
export type PiContext = {
  ambient?: boolean;
  tools?: string[];
  skills?: string[];
  contextFiles?: string[];
  extensions?: string[];
};

const PI_CONTEXT_FIELDS = new Set(['ambient', 'tools', 'skills', 'contextFiles', 'extensions']);
const LIST_FIELDS = ['tools', 'skills', 'contextFiles', 'extensions'] as const;

/** Validate a task's `piContext` at the boundary. Returns null when the value
 * is absent or valid, otherwise a message naming the offending field. */
export function validatePiContext(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'Invalid piContext (expected an object)';
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PI_CONTEXT_FIELDS.has(key)) return `Invalid piContext.${key} (unknown field)`;
  }
  if (record.ambient !== undefined && typeof record.ambient !== 'boolean') return 'Invalid piContext.ambient (expected a boolean)';
  for (const field of LIST_FIELDS) {
    const list = record[field];
    if (list === undefined) continue;
    const valid = Array.isArray(list) && list.every((entry) => typeof entry === 'string' && entry.trim().length > 0);
    if (!valid) return `Invalid piContext.${field} (expected an array of non-empty strings)`;
  }
  return null;
}

/** Build isolated Pi arguments for the supported capability set. A null set
 * means no help text was available, so every flag is assumed to work. */
export function buildIsolationArgs(
  piContext: PiContext | undefined,
  capabilities: PiCapabilities | null,
): { args: string[]; applied: string[]; missing: string[]; ambient: boolean } {
  const args: string[] = [];
  const applied: string[] = [];
  const missing: string[] = [];
  const ambient = piContext?.ambient === true;
  const supports = (flag: string): boolean => capabilities === null || capabilities.flags.has(flag);

  if (!ambient) {
    for (const flag of ISOLATION_FLAGS) {
      if (supports(flag)) {
        args.push(flag);
        applied.push(flag);
      } else {
        missing.push(flag);
      }
    }
  }

  // Ambient runs keep Pi's own tool set unless the task names one explicitly.
  const tools = piContext?.tools ?? (ambient ? undefined : DEFAULT_PI_TOOLS);
  if (tools) {
    if (supports('--tools')) {
      args.push('--tools', tools.join(','));
      applied.push('--tools');
    } else {
      missing.push('--tools');
    }
  }

  for (const skill of piContext?.skills ?? []) args.push('--skill', skill);
  for (const contextFile of piContext?.contextFiles ?? []) args.push('--append-system-prompt', contextFile);
  for (const extension of piContext?.extensions ?? []) args.push('-e', extension);

  return { args, applied, missing, ambient };
}

/** Whether a run's Pi system message reflects the isolation that was applied. */
export type IsolationVerdict = { checked: boolean; honored: boolean; problems: string[] };

/** Read the first system message in a Pi JSON event stream and check that the
 * applied isolation took effect: no skills section under `--no-skills`, and
 * no built-in tool outside the `--tools` allowlist. `checked` is false when
 * the stream holds no system message with sections (nothing to verify). */
export function verifyIsolation(eventsText: string, plan: { applied: readonly string[]; tools: readonly string[] }): IsolationVerdict {
  let sections: Record<string, unknown> | null = null;
  for (const line of eventsText.split('\n')) {
    if (!line.trim()) continue;
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }
    const message = event?.type === 'message_start' ? event.message : null;
    if (message?.role === 'system' && message.sections && typeof message.sections === 'object') {
      sections = message.sections as Record<string, unknown>;
      break;
    }
  }
  if (!sections) return { checked: false, honored: true, problems: [] };
  const problems: string[] = [];
  const skills = typeof sections.skills === 'string' ? sections.skills.trim() : '';
  if (plan.applied.includes('--no-skills') && skills) problems.push('ambient skills present despite --no-skills');
  if (plan.applied.includes('--tools') && typeof sections.tools === 'string') {
    const listed = [...sections.tools.matchAll(/^- ([A-Za-z_][\w-]*):/gm)].map((match) => match[1]);
    const extra = listed.filter((tool) => !plan.tools.includes(tool));
    if (extra.length > 0) problems.push(`tools outside the allowlist: ${extra.join(', ')}`);
  }
  return { checked: true, honored: problems.length === 0, problems };
}
