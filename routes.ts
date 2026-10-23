// ---------------------------------------------------------------------------
// routes.ts — the one machine-readable map of manager jobs to Junior routes.
//
// An agent that wakes up after a compaction has lost the conversation but still
// has to route the next user request to the right command. This module is the
// single source of truth for that routing:
//
//   • `ROUTES` lists every route once: its id, the job it does, the user
//     phrasings that trigger it, the first command to run, the follow-up
//     commands, the companion skill and the `junior tools call` form for its
//     companion methods.
//   • `rankRoutes(query)` scores the routes against a free-text query by
//     deterministic keyword/phrase overlap (lowercase, no network, no LLM) and
//     returns them best first, so `junior routes "<query>"` recovers the right
//     route in one call.
//   • `main(argv)` is the `junior routes [--json] [<query>]` entry point.
//
// ── Stable `--json` contract ────────────────────────────────────────────────
// `junior routes --json` prints a JSON array of the full `ROUTES` objects, in
// declaration order, one object per route, with these keys:
//
//   {
//     "id":       "plan",                       // stable route id
//     "job":      "Author and lint a CPM plan", // one-sentence description
//     "triggers": ["create a cpm plan", ...],   // user phrasings, lowercase
//     "first":    "junior plan check main.json",
//     "then":     ["junior tools call cpm plan.submit request.json", ...],
//     "skill":    "cpm-plan",                   // optional companion skill
//     "toolsCall":["junior tools call cpm plan.status plan_id=<id>", ...]
//   }
//
// `junior routes <query>` prints the top three ranked routes as a compact text
// table (rank, id, first command, job), best first. Without a query it prints
// every route in declaration order. The JSON shape and the text columns are
// stable; only the route set grows.
//
// ── Companion methods ───────────────────────────────────────────────────────
// `COMPANION_METHODS` is the command allowlist for `junior tools call`: the
// read methods are the wrapper's `READ_TOOLS` set in tools/tools.ts (classified
// by `isReadTool`), and the entries here are the state-mutating commands
// documented in tools/README.md. Read tools are snapshotted; every method named
// by a route is either a read in that set or a command in this list.
// ---------------------------------------------------------------------------

import type { ToolName } from './tools/tools.ts';

export interface Route {
  /** Stable id used by tests, docs and future crossmatrix labels. */
  id: string;
  /** The manager job in one sentence. */
  job: string;
  /** User phrasings that route here; lowercase, used by rankRoutes. */
  triggers: string[];
  /** The first command to run for this job. */
  first: string;
  /** Follow-up commands, in order. */
  then: string[];
  /** Companion skill that owns the deep procedure, when one exists. */
  skill?: string;
  /** `junior tools call` forms for this route's companion methods. */
  toolsCall?: string[];
}

/**
 * State-mutating companion commands that `junior tools call` may invoke.
 * Grounded in the "Commands" column of tools/README.md and skills/junior.
 * Read methods are deliberately absent: tools/tools.ts classifies those with
 * `isReadTool` and snapshots them.
 */
export const COMPANION_METHODS: Record<ToolName, readonly string[]> = {
  cpm: [
    'plan.submit',
    'plan.sync',
    'plan.export',
    'plan.snapshot',
    'plan.baseline',
    'plan.acquire_cohort',
    'plan.heartbeat',
    'plan.mark_status',
    'plan.accept',
    'plan.force_release',
    'plan.fork',
    'plan.select',
    'plan.archive',
    'plan.revise',
  ],
  fmeca: ['session.open', 'append'],
  crossmatrix: ['crossmatrix.command'],
  'scientific-process': ['session.open', 'append'],
  elicitation: ['session.open', 'append'],
};

export const ROUTES: readonly Route[] = [
  {
    id: 'delegate',
    job: 'Hand off one bounded coding deliverable: validate the contract, run it in an isolated worktree and apply the reviewed handoff.',
    triggers: [
      'implement this function',
      'implement this function with junior',
      'delegate this coding task',
      'hand off a bounded deliverable',
      'make this code change',
      'write this code for me',
      'fix this bug in the code',
    ],
    first: 'junior validate <task.json>',
    then: [
      'junior handoff <task.json>',
      'junior status <result.json>',
      'junior apply <id>',
    ],
  },
  {
    id: 'plan',
    job: 'Author and lint a CPM plan: write the deliverable graph with owned_files and prerequisites, then lint and sync it.',
    triggers: [
      'create a cpm plan',
      'use junior to create a cpm plan',
      'plan a project',
      'write a cpm plan',
      'author a plan with owned files',
      'critical path plan',
      'plan the deliverables with prerequisites',
    ],
    first: 'write .cpm-planner/plans/<name>/main.json',
    then: [
      'junior tools call cpm plan.lint path=.cpm-planner/plans/<name>/main.json',
      'junior tools call cpm plan.sync path=.cpm-planner/plans/<name>/main.json',
      'junior tools call cpm plan.status plan_id=<id>',
      'junior tools call cpm plan.schedule plan_id=<id> \'capacities={"agent":3}\'',
    ],
    skill: 'cpm-plan',
    toolsCall: [
      'junior tools call cpm plan.status plan_id=<id>',
      'echo <json> | junior tools call cpm -',
      'junior tools call cpm request.json',
    ],
  },
  {
    id: 'plan-for-junior',
    job: 'Shape a plan so each deliverable is a handoff-sized Junior contract, with safe parallel cohorts and generated skeletons.',
    triggers: [
      'shape a plan for junior',
      'make the plan handoff sized',
      'check the plan for junior',
      'generate contracts from the plan',
      'split the plan into cohorts',
    ],
    first: 'junior plan check <plan.json>',
    then: ['junior plan contracts <plan.json> --out <dir>'],
  },
  {
    id: 'run-plan',
    job: 'Run and track a plan: lease deliverables, hand them off with a plan lease and mark each one complete or failed.',
    triggers: [
      'run the plan',
      'execute the plan',
      'lease the next deliverable',
      'work through the plan',
      'track the running plan',
    ],
    first: 'junior tools call cpm plan.acquire_cohort caller_id=<id> plan_id=<id>',
    then: [
      'junior handoff <task.json>',
      'junior tools call cpm plan.mark_status caller_id=<id> plan_id=<id> deliverable_id=<id> \'status={"status":"complete"}\'',
    ],
    skill: 'cpm-run',
    toolsCall: [
      'junior tools call cpm plan.acquire_cohort caller_id=<id> plan_id=<id>',
      'junior tools call cpm plan.mark_status caller_id=<id> plan_id=<id> deliverable_id=<id> \'status={"status":"complete"}\'',
    ],
  },
  {
    id: 'improve-plan',
    job: 'Improve a plan: fork variants, simulate them, compare the scorecards and select the best one.',
    triggers: [
      'improve the plan',
      'make the plan faster',
      'parallelize the plan',
      'compare plan variants',
      'select the best plan variant',
      'crash or fast-track the schedule',
    ],
    first: 'junior tools call cpm plan.fork request.json',
    then: [
      'junior tools call cpm plan.simulate request.json',
      'junior tools call cpm plan.compare request.json',
      'junior tools call cpm plan.select request.json',
    ],
    skill: 'cpm-improve',
    toolsCall: [
      'junior tools call cpm plan.fork request.json',
      'echo <json> | junior tools call cpm -',
      'junior tools call cpm request.json',
    ],
  },
  {
    id: 'track-plan',
    job: 'Track plan execution with a baseline, earned value and snapshots for long-running work.',
    triggers: [
      'track earned value',
      'baseline the plan',
      'snapshot the plan',
      'report plan progress and variance',
      'measure plan performance',
    ],
    first: 'junior tools call cpm plan.baseline plan_id=<id> reason=<text>',
    then: [
      'junior tools call cpm plan.ev plan_id=<id>',
      'junior tools call cpm plan.snapshot request.json',
    ],
    skill: 'cpm-ev',
    toolsCall: [
      'junior tools call cpm plan.ev plan_id=<id>',
      'echo <json> | junior tools call cpm -',
      'junior tools call cpm request.json',
    ],
  },
  {
    id: 'risk',
    job: 'Assess risk with FMECA: open a session, score failure modes, then read the next risk and readiness.',
    triggers: [
      'what could go wrong',
      'what could go wrong with this migration',
      'assess the failure modes',
      'risk analysis before this change',
      'fmeca the risky change',
      'readiness check before release',
    ],
    first: 'junior tools call fmeca session.open request.json',
    then: [
      'junior tools call fmeca append request.json',
      'junior tools call fmeca risk.next session_id=<id>',
      'junior tools call fmeca readiness.assess session_id=<id>',
    ],
    skill: 'fmeca',
    toolsCall: [
      'junior tools call fmeca session.open request.json',
      'echo <json> | junior tools call fmeca -',
      'junior tools call fmeca request.json',
    ],
  },
  {
    id: 'matrix',
    job: 'Build traceability with crossmatrix: initialize and sync the graph, bootstrap links, walk it and audit quality.',
    triggers: [
      'traceability between requirements and tests',
      'trace requirements to tests',
      'link features to tests and code',
      'build the traceability matrix',
      'query the crossmatrix graph',
      'audit link quality',
    ],
    first: 'junior matrix init',
    then: [
      'junior matrix sync --hop <hop.json> --source code --source tests',
      'junior matrix bootstrap',
      'junior matrix graph --seed <dimensionId>:<memberId>',
      'junior matrix qc',
    ],
    skill: 'crossmatrix',
  },
  {
    id: 'discover',
    job: 'Discover requirements: run the discover handoff workflow and capture acceptance criteria through elicitation.',
    triggers: [
      'discover the requirements',
      'the request is vague',
      'turn this idea into acceptance criteria',
      'interview me about the requirements',
      'clarify what to build',
    ],
    first: 'junior handoff <task.json>  # contract workflow: discover',
    then: [
      'junior tools call elicitation append request.json',
      'junior tools call elicitation question.next session_id=<id>',
      'junior tools call elicitation readiness.assess session_id=<id>',
    ],
    toolsCall: [
      'junior tools call elicitation session.open request.json',
      'echo <json> | junior tools call elicitation -',
      'junior tools call elicitation request.json',
    ],
  },
  {
    id: 'investigate',
    job: 'Investigate a question: run the investigate handoff workflow and frame a scientific-process experiment.',
    triggers: [
      'investigate this problem',
      'find the root cause',
      'run an experiment to decide',
      'why is this happening',
      'test a hypothesis',
    ],
    first: 'junior handoff <task.json>  # contract workflow: investigate',
    then: [
      'junior tools call scientific-process append request.json',
      'junior tools call scientific-process state.get session_id=<id>',
    ],
    toolsCall: [
      'junior tools call scientific-process append request.json',
      'echo <json> | junior tools call scientific-process -',
      'junior tools call scientific-process request.json',
    ],
  },
  {
    id: 'triz',
    job: 'Resolve a real technical contradiction with TRIZ; use it only for a genuine trade-off, never to brainstorm.',
    triggers: [
      'resolve a technical contradiction',
      'triz contradiction',
      'two requirements conflict',
      'improving one thing breaks another',
      'trade-off analysis with triz',
    ],
    first: 'triz analyze <request.json> --out <result.json>',
    then: ['triz catalog'],
  },
  {
    id: 'browser-test',
    job: 'Verify a user journey in a real browser with jevitate.',
    triggers: [
      'browser test the app',
      'check the journey in a browser',
      'verify the ui in a real browser',
      'run the jevitate suite',
      'browser acceptance check',
    ],
    first: 'jevitate check --suite <file>',
    then: [],
    skill: 'jevitate-getting-started',
  },
  {
    id: 'report-issue',
    job: 'Draft and file a redacted upstream bug report when a companion or managed tool misbehaves.',
    triggers: [
      'report a bug in the tool',
      'file an issue for the tool',
      'a companion tool is broken',
      'report a tool issue',
      'the tool returned a wrong result',
    ],
    first: 'junior report-issue <tool> --title <title>',
    then: ['junior report-issue <tool> --title <title> --file'],
  },
  {
    id: 'restore-context',
    job: "Rebuild the session's working context after compaction or resume from Junior's stores.",
    triggers: [
      'rebuild context after compaction',
      'restore the session context',
      'resume with the working context',
      'lost context after compaction',
      'what was i working on',
    ],
    first: 'junior compact',
    then: ['junior setup --context-hooks'],
  },
  {
    id: 'setup',
    job: 'Set up or update the project: check readiness, run setup, init companions and adopt newer tools.',
    triggers: [
      'set up the project',
      'install junior',
      'check readiness with doctor',
      'update the companions and skills',
      'initialize the project',
    ],
    first: 'junior doctor',
    then: [
      'junior setup',
      'junior init',
      'junior update',
    ],
  },
  {
    id: 'model',
    job: 'Manage commodity models: inspect status, list candidates, upgrade the roster and approve or revoke keys.',
    triggers: [
      'which model is in use',
      'list available models',
      'upgrade the model roster',
      'approve a model key',
      'check model status',
    ],
    first: 'junior model status',
    then: [
      'junior model list',
      'junior model upgrade',
      'junior model approve <key>',
    ],
  },
];

// ---------------------------------------------------------------------------
// Deterministic ranking
// ---------------------------------------------------------------------------

/** Common words that carry no routing signal. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'before', 'by', 'do', 'does',
  'for', 'from', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or',
  'should', 'so', 'that', 'the', 'their', 'them', 'then', 'this', 'to', 'up',
  'use', 'using', 'want', 'was', 'we', 'what', 'when', 'which', 'who', 'why',
  'will', 'with', 'you', 'your',
]);

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokens(text: string): string[] {
  return normalize(text).split(' ').filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

/** Score one route against a query: phrase hits dominate single-word overlap. */
function scoreRoute(route: Route, query: string, queryTokens: Set<string>): number {
  const normalizedQuery = ` ${normalize(query)} `;
  const haystack = [route.job, ...route.triggers].join(' ');
  let score = 0;
  // A trigger (or the job sentence) that appears verbatim in the query is the
  // strongest possible signal; longer phrases score higher.
  for (const phrase of [route.job, ...route.triggers]) {
    const normalizedPhrase = normalize(phrase);
    if (normalizedPhrase && normalizedQuery.includes(` ${normalizedPhrase} `)) {
      score += 100 + tokens(phrase).length;
    }
  }
  // Otherwise fall back to token overlap so an unseen phrasing still ranks.
  const seen = new Set<string>();
  for (const token of tokens(haystack)) {
    if (queryTokens.has(token) && !seen.has(token)) {
      seen.add(token);
      score += 1;
    }
  }
  return score;
}

export interface RankedRoute {
  id: string;
  score: number;
}

/**
 * Rank every route against a free-text query, best first. Deterministic:
 * ties keep declaration order, the input query is only lowercased and
 * tokenized, and no network or model is involved.
 */
export function rankRoutes(query: string): RankedRoute[] {
  const queryTokens = new Set(tokens(query));
  return ROUTES
    .map((route, index) => ({ id: route.id, score: scoreRoute(route, query, queryTokens), index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ id, score }) => ({ id, score }));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface RoutesIo {
  /** Where text output goes; defaults to stdout. */
  out?: (text: string) => void;
}

export const ROUTES_USAGE = 'Usage: junior routes [--json] [<query>]';

function routeById(id: string): Route {
  return ROUTES.find((route) => route.id === id) as Route;
}

/** Render one route as a compact, stable line. */
function textLine(rank: number | null, route: Route, score?: number): string {
  const prefix = rank === null ? '' : `${rank}. `;
  const detail = score === undefined ? '' : ` (score ${score})`;
  return `${prefix}${route.id}${detail}  ${route.first}  — ${route.job}`;
}

/**
 * `junior routes [--json] [<query>]`.
 *
 * Without a query: every route. With a query: the ranked routes, best first,
 * top three in text mode (all ranked routes in JSON). `--json` prints the
 * `Route` objects themselves, in the same order.
 */
export async function main(argv: string[], io: RoutesIo = {}): Promise<number> {
  const out = io.out ?? ((text: string) => { process.stdout.write(text); });
  const json = argv.includes('--json');
  const query = argv.filter((arg) => arg !== '--json').join(' ').trim();

  if (!query) {
    if (json) out(`${JSON.stringify(ROUTES, null, 2)}\n`);
    else out(`${ROUTES.map((route) => textLine(null, route)).join('\n')}\n`);
    return 0;
  }

  const ranked = rankRoutes(query);
  if (json) {
    out(`${JSON.stringify(ranked.map((entry) => ({ ...routeById(entry.id), score: entry.score })), null, 2)}\n`);
    return 0;
  }
  const lines = ranked
    .slice(0, 3)
    .map((entry, index) => textLine(index + 1, routeById(entry.id), entry.score));
  out(`${lines.join('\n')}\n`);
  return 0;
}
