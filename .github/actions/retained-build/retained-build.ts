import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Evidence {
  schema: number;
  repository: string;
  workflow: string;
  run_id: number;
  run_attempt: number;
  head_sha: string;
  built_sha: string;
  tree: string;
  // Schema 2: the triggering PR as delivered in the build's own event payload.
  // It is part of the immutable artifact, so it survives the PR closing.
  pull_request?: PullRequestProvenance | null;
}
export interface PullRequestProvenance {
  number: number;
  base_ref: string;
  base_repo_id: number;
  head_ref: string;
  head_repo_id: number;
  head_sha: string;
}
/** A pull request as returned by the REST pulls endpoints. */
export interface PullRequest {
  number: number;
  base: { ref: string; repo: { id: number; full_name: string } };
  head: { ref: string; sha: string; repo: { id: number; full_name: string } | null };
}
export interface Run {
  id: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string;
  head_repository: { full_name: string };
  path: string;
  event: string;
  status: string;
  conclusion: string;
  pull_requests: { number: number; base: { ref: string; repo: { id: number } }; head: { sha: string; repo: { id: number } } }[];
}
const sha = /^[a-f0-9]{40}$/;
const text = (args: string[]) => execFileSync(args[0], args.slice(1), { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
const api = (path: string): any => JSON.parse(text(['gh', 'api', path]));

export function validate(evidence: Evidence, run: Run, repository: string, workflow: string, tree: string): void {
  if (run.status !== 'completed' || run.conclusion !== 'success'
      || run.head_repository?.full_name !== repository || run.path !== `.github/workflows/${workflow}`
      || !['pull_request', 'workflow_dispatch', 'push'].includes(run.event)) throw new Error('Untrusted build run');
  if (run.event !== 'pull_request' && run.head_branch !== 'staging') throw new Error('Build did not run on staging');
  if (![1, 2].includes(evidence.schema) || evidence.repository !== repository || evidence.workflow !== workflow
      || evidence.run_id !== run.id || evidence.run_attempt !== run.run_attempt || evidence.head_sha !== run.head_sha
      || !sha.test(evidence.built_sha) || !sha.test(evidence.tree) || evidence.tree !== tree) {
    throw new Error('Retained build does not match this repository, run attempt and complete source tree');
  }
  // Schema 2 must carry PR provenance exactly when the build ran for a PR.
  if (evidence.schema === 2 && (run.event === 'pull_request') !== (evidence.pull_request != null)) {
    throw new Error('Retained build provenance does not match its triggering event');
  }
}

/**
 * Proves a pull_request build validated a same-repository PR into staging.
 *
 * `run.pull_requests` is emptied by GitHub once the PR closes, so it cannot be
 * the source of truth. The PR is instead checked live through the pulls API:
 * schema 2 evidence names the PR (recorded from the build's event payload) and
 * both the recorded and the live PR must target staging; schema 1 evidence has
 * no PR number, so the caller passes the repository's staging PRs for the
 * run's head branch. Either way the PR must still have head.sha == run.head_sha
 * and head.ref == run.head_branch, with base and head in this repository.
 * `commits/{sha}/pulls` is deliberately not used: for a commit already on the
 * default branch it returns only the PR that introduced it, never the
 * promotion PR into staging.
 */
export function verifyStagingPr(evidence: Evidence, run: Run, repository: string, prs: PullRequest[]): PullRequest {
  if (run.event !== 'pull_request') throw new Error('Not a pull_request build');
  const recorded = evidence.pull_request;
  if ((evidence.schema >= 2 || recorded) && (!recorded || recorded.base_ref !== 'staging' || recorded.head_sha !== run.head_sha
      || recorded.head_ref !== run.head_branch || recorded.base_repo_id !== recorded.head_repo_id)) {
    throw new Error('Retained build provenance does not name a same-repository staging PR for this run');
  }
  const match = prs.find(pr => pr.base.ref === 'staging' && pr.head.sha === run.head_sha && pr.head.ref === run.head_branch
    && pr.base.repo.full_name === repository && pr.head.repo?.full_name === repository && pr.base.repo.id === pr.head.repo?.id
    && (!recorded || (pr.number === recorded.number && pr.base.repo.id === recorded.base_repo_id)));
  if (!match) throw new Error('Build did not validate a same-repository staging PR');
  return match;
}

function stagingPrCandidates(evidence: Evidence, run: Run, repository: string): PullRequest[] {
  if (evidence.pull_request) return [api(`repos/${repository}/pulls/${evidence.pull_request.number}`)];
  const owner = repository.split('/')[0];
  const head = encodeURIComponent(`${owner}:${run.head_branch}`);
  const prs: PullRequest[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch: PullRequest[] = api(`repos/${repository}/pulls?state=all&base=staging&head=${head}&sort=updated&direction=desc&per_page=100&page=${page}`);
    prs.push(...batch);
    if (batch.some(pr => pr.head.sha === run.head_sha) || batch.length < 100) break;
  }
  return prs;
}

export function mustReuse(eventName: string, event: any, ref: string, repository: string): boolean {
  if (eventName === 'pull_request' && event.pull_request.base.ref === 'main') {
    const pr = event.pull_request;
    // head.repo is null when the source fork has been deleted.
    if (pr.head.repo?.full_name !== repository) throw new Error('Production promotion cannot come from a fork');
    // Main never rebuilds, including hotfixes: validate and promote through staging.
    if (pr.head.ref !== 'staging') throw new Error('Production promotion must come from staging');
    return true;
  }
  return ref === 'refs/heads/main';
}

export function main(): void {
  const env = process.env;
  const repository = env.GITHUB_REPOSITORY!;
  const workflow = env.RETAINED_BUILD_WORKFLOW!;
  if (!/^[\w.-]+\.ya?ml$/.test(workflow)) throw new Error('Expected a workflow filename');
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH!, 'utf8'));
  const builtSha = text(['git', 'rev-parse', 'HEAD']);
  const tree = text(['git', 'rev-parse', 'HEAD^{tree}']);
  const output = (key: string, value: string) => appendFileSync(env.GITHUB_OUTPUT!, `${key}=${value}\n`);
  const runId = Number(env.GITHUB_RUN_ID);
  if (env.RETAINED_BUILD_MODE === 'record') {
    const run: Run = api(`repos/${repository}/actions/runs/${runId}`);
    const pr = env.GITHUB_EVENT_NAME === 'pull_request' ? event.pull_request : null;
    const evidence: Evidence = { schema: 2, repository, workflow, run_id: runId,
      run_attempt: Number(env.GITHUB_RUN_ATTEMPT), head_sha: run.head_sha, built_sha: builtSha, tree,
      pull_request: pr && { number: pr.number, base_ref: pr.base.ref, base_repo_id: pr.base.repo.id,
        head_ref: pr.head.ref, head_repo_id: pr.head.repo?.id ?? 0, head_sha: pr.head.sha } };
    const dir = join(env.RUNNER_TEMP!, 'retained-build');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'build-result.json'), JSON.stringify(evidence, null, 2) + '\n');
    return;
  }
  if (env.RETAINED_BUILD_MODE !== 'resolve') throw new Error('Expected resolve or record mode');
  const required = mustReuse(env.GITHUB_EVENT_NAME!, event, env.GITHUB_REF!, repository);
  const staging = env.GITHUB_REF === 'refs/heads/staging'
    || (env.GITHUB_EVENT_NAME === 'pull_request' && event.pull_request.base.ref === 'staging');
  if (!required && !staging) {
    output('build-required', 'true');
    return;
  }
  // Include the full tree, including workflow files and lockfiles. A merge commit
  // changes the commit id even when every source byte is unchanged.
  for (let page = 1; page <= 10; page++) {
    const runs: Run[] = api(`repos/${repository}/actions/workflows/${workflow}/runs?status=success&per_page=100&page=${page}`).workflow_runs;
    for (const run of runs) {
      // A closed PR's run lists no pull_requests; provenance is verified below.
      if (run.id === runId || run.head_repository?.full_name !== repository
          || (run.event === 'pull_request'
            ? run.pull_requests.length > 0 && !run.pull_requests.some(pr => pr.base.ref === 'staging')
            : run.head_branch !== 'staging')) continue;
      const name = `retained-build-${workflow}-${run.run_attempt}`;
      // One unreadable candidate (an artifact that expired after listing, a
      // malformed evidence file) must not end the search: skip it, say why,
      // and keep looking for an older run with the same tree.
      const skip = (why: string) => console.log(`::warning::Skipping candidate run ${run.id}: ${why}`);
      let artifacts: any[];
      try { artifacts = api(`repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`).artifacts; }
      catch (error) { skip(`cannot list artifacts (${(error as Error).message})`); continue; }
      if (!artifacts.some((a: any) => a.name === name && !a.expired)) continue;
      const dir = mkdtempSync(join(env.RUNNER_TEMP!, 'retained-source-'));
      try {
        let evidence: Evidence;
        try {
          text(['gh', 'run', 'download', String(run.id), '--repo', repository, '--name', name, '--dir', dir]);
          evidence = JSON.parse(readFileSync(join(dir, 'build-result.json'), 'utf8'));
        } catch (error) { skip(`cannot read evidence (${(error as Error).message})`); continue; }
        try { validate(evidence, run, repository, workflow, tree); } catch { continue; }
        if (run.event === 'pull_request') {
          // An unreadable pulls API must fail loudly, not silently look like "no build".
          let prs: PullRequest[];
          try { prs = stagingPrCandidates(evidence, run, repository); } catch (error) {
            throw new Error(`Cannot read pull requests to verify staging build ${run.id}; the resolve job needs `
              + `permissions: pull-requests: read (${(error as Error).message})`);
          }
          try { verifyStagingPr(evidence, run, repository, prs); } catch { continue; }
        }
        // A pull_request build's built_sha is the refs/pull/N/merge commit,
        // which GitHub may garbage-collect after the PR closes. An unreadable
        // commit cannot be verified, so skip it; a readable commit whose tree
        // contradicts the evidence is tampering and still fails loudly.
        let commit: any;
        try { commit = api(`repos/${repository}/git/commits/${evidence.built_sha}`); }
        catch (error) { skip(`built commit ${evidence.built_sha} is unreadable (${(error as Error).message})`); continue; }
        if (commit.tree.sha !== tree) throw new Error('Build commit tree does not match retained evidence');
        output('build-required', 'false');
        output('run-id', String(run.id));
        appendFileSync(env.GITHUB_STEP_SUMMARY!, `Reusing [staging build ${run.id}](https://github.com/${repository}/actions/runs/${run.id}) for tree \`${tree}\`. No compilation.\n`);
        return;
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    if (runs.length < 100) break;
  }
  if (!required) {
    output('build-required', 'true');
    return;
  }
  throw new Error('No successful retained staging build matches this complete tree. Build and validate staging first; production never rebuilds as a fallback.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
