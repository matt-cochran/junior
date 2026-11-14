// ---------------------------------------------------------------------------
// Claude Code permission-rule grammar.
//
// Junior writes Claude Code deny rules for the Crossmatrix store. A rule that
// is misspelled, uses a literal `*` where Claude Code expects a prefix, or
// targets Write (which Claude Code checks against Edit rules) silently fails
// to block anything. This module is a pure lint and matcher for the rule forms
// Junior writes, so tests can assert both validity and actual coverage.
// ---------------------------------------------------------------------------

/** One tool call to test a permission rule against. */
export type PermissionCall =
  | { tool: 'Bash'; command: string }
  | { tool: 'Read' | 'Edit'; path: string };

type ParsedRule = { tool: string; spec: string };

function parseRule(rule: string): ParsedRule | null {
  const open = rule.indexOf('(');
  const close = rule.lastIndexOf(')');
  if (open <= 0 || close !== rule.length - 1 || close <= open) return null;
  return { tool: rule.slice(0, open), spec: rule.slice(open + 1, close) };
}

function pathProblem(rule: string, path: string): string | null {
  if (path.startsWith('./') || path.startsWith('/') || path.startsWith('~/') || path.startsWith('//')) {
    return null;
  }
  return `${rule}: path must start with './', '/', '~/' or '//'`;
}

/**
 * Report the problems that make a rule invalid or ineffective. An empty array
 * means the rule is valid and can block the calls it targets.
 */
export function lintPermissionRule(rule: string, all: readonly string[]): string[] {
  const parsed = parseRule(rule);
  if (!parsed) return [`${rule}: expected a Tool(spec) rule`];

  const { tool, spec } = parsed;

  // One problem per offending rule keeps a lint report actionable.
  if (tool === 'Bash' && spec.endsWith(':*')) {
    const prefix = spec.slice(0, -2);
    if (prefix.includes('*')) {
      return [
        `${rule}: '*' before the trailing ':*' is literal; use the mid-pattern form 'cmd * path*'`,
      ];
    }
  }

  if (tool === 'Write' && all.includes(`Edit(${spec})`)) {
    return [`${rule}: Write rules are checked against Edit rules, so this rule never matches`];
  }

  if (tool === 'Read' || tool === 'Edit' || tool === 'Write') {
    const problem = pathProblem(rule, spec);
    if (problem) return [problem];
  }

  return [];
}

function normalizePath(path: string): string {
  let normalized = path;
  while (normalized.startsWith('./') && normalized !== './') normalized = normalized.slice(2);
  return normalized;
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 's').test(value);
}

function bashMatches(spec: string, command: string): boolean {
  if (spec.endsWith(':*')) {
    const prefix = spec.slice(0, -2);
    // A ':*' rule is a word prefix: the command equals it or continues after a space.
    return command === prefix || command.startsWith(`${prefix} `);
  }
  return globMatches(spec, command);
}

function pathMatches(spec: string, path: string): boolean {
  const normalizedPath = normalizePath(path);
  if (spec.endsWith('/**')) {
    const base = normalizePath(spec.slice(0, -3));
    return normalizedPath === base || normalizedPath.startsWith(`${base}/`);
  }
  return normalizedPath === normalizePath(spec);
}

/** Whether a permission rule blocks the given tool call. */
export function ruleMatches(rule: string, call: PermissionCall): boolean {
  const parsed = parseRule(rule);
  if (!parsed || parsed.tool !== call.tool) return false;

  if (call.tool === 'Bash') return bashMatches(parsed.spec, call.command);
  return pathMatches(parsed.spec, call.path);
}
