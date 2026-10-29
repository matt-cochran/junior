import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { IsolationMode } from './isolation.ts';

// ---------------------------------------------------------------------------
// Explicit Pi session continuation
//
// A task may set `resumeFrom` to a prior result.json. The worker validates the
// prior run (same resolved cwd, same requested provider/model, a valid prior Pi
// session ID) and then passes an explicit `--session <id>` to Pi. It never uses
// `--continue`. The new contract is appended to the prior session; a prior
// recon recommendation is not treated as approval to change production code.
// ---------------------------------------------------------------------------

/** Pi session IDs start and end with a letter or number. */
export const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export type ResumeInfo = {
 from:string;
 parentResult:{ path:string; artifactDir:string|null; status:string|null };
 parentSessionId:string;
 parentRequested:{ provider:string; model:string };
 parentWorkflow:string|null;
 sessionId:string;
};

/** Advisory lock key for a continuation. The lock must guard the *parent*
 * session being continued (the session Pi attaches to), not any session id the
 * new run may report afterwards. */
export function sessionLockKey(resume:{parentSessionId:string}):string {
 return `session:${resume.parentSessionId}`;
}

function priorCwd(prior:any):string|null {
 if (prior && typeof prior.cwd === 'string' && prior.cwd.trim()) return resolve(prior.cwd);
 if (prior && typeof prior.artifactDir === 'string' && prior.artifactDir.trim()) {
  const normalized=prior.artifactDir.replace(/\\/g,'/');
  const idx=normalized.lastIndexOf('/.delivery/');
  if (idx > 0) return resolve(normalized.slice(0, idx));
 }
 return null;
}

export function resolveResume(prior:any, requested:{provider:string;model:string}, resolvedCwd:string, from:string):{ info?:ResumeInfo; error?:string } {
 if (!prior || typeof prior !== 'object' || Array.isArray(prior)) return {error:'resume prior result is not an object'};
 const receipt=prior.receipt;
 if (!receipt || typeof receipt !== 'object') return {error:'resume prior result has no receipt; cannot confirm a Pi session'};
 const sessionId=typeof receipt.sessionId === 'string' ? receipt.sessionId.trim() : '';
 if (!sessionId) return {error:'resume prior result has no Pi session ID'};
 if (!SESSION_ID_RE.test(sessionId)) return {error:`resume prior session ID is not valid: ${sessionId}`};
 const priorReq=receipt.requested && typeof receipt.requested === 'object' ? receipt.requested : null;
 if (!priorReq || typeof priorReq.provider !== 'string' || typeof priorReq.model !== 'string') return {error:'resume prior result has no requested provider/model'};
 if (priorReq.provider !== requested.provider || priorReq.model !== requested.model) {
  return {error:`resume provider/model mismatch (prior ${priorReq.provider}/${priorReq.model}, requested ${requested.provider}/${requested.model})`};
 }
 const cwd=priorCwd(prior);
 if (!cwd) return {error:'resume prior result has no resolved cwd to compare'};
 if (cwd !== resolvedCwd) return {error:`resume cwd mismatch (prior ${cwd}, requested ${resolvedCwd})`};
 const parentWorkflow=prior.workflow && typeof prior.workflow === 'object' ? (typeof prior.workflow.selected === 'string' ? prior.workflow.selected : null) : (typeof prior.workflow === 'string' ? prior.workflow : null);
 return {info:{
  from,
  parentResult:{ path:from, artifactDir:typeof prior.artifactDir === 'string' ? prior.artifactDir : null, status:typeof prior.status === 'string' ? prior.status : null },
  parentSessionId:sessionId,
  parentRequested:{ provider:priorReq.provider, model:priorReq.model },
  parentWorkflow,
  sessionId,
 }};
}

/** Resolve `resumeFrom` relative to the target checkout and validate it. The
 * raw prior result is returned too, so isolation compatibility can be checked. */
export function loadResume(t:any, requested:{provider:string;model:string}, resolvedCwd:string):{ info?:ResumeInfo; error?:string; prior?:any } {
 if (typeof t.resumeFrom !== 'string' || !t.resumeFrom.trim()) return {};
 const path=resolve(resolvedCwd, t.resumeFrom);
 let raw:string;
 try { raw=readFileSync(path,'utf8'); } catch { return {error:`resumeFrom not readable: ${path}`}; }
 let prior:any;
 try { prior=JSON.parse(raw); } catch { return {error:`resumeFrom is not valid JSON: ${path}`}; }
 return {...resolveResume(prior, requested, resolvedCwd, path), prior};
}

/** Isolation mode recorded on a prior result; old results default to none. */
function priorIsolationMode(prior:any):IsolationMode {
 return prior?.isolation?.mode === 'worktree' ? 'worktree' : 'none';
}

/** Execution checkout recorded on a prior result; old results fall back to the
 * source checkout derived from the artifact path. */
export function priorExecutionCwd(prior:any):string|null {
 if (prior && typeof prior.executionCwd === 'string' && prior.executionCwd.trim()) return resolve(prior.executionCwd);
 if (prior && typeof prior.sourceCwd === 'string' && prior.sourceCwd.trim()) return resolve(prior.sourceCwd);
 return priorCwd(prior);
}

/** Decide which checkout a continuation must run in. A Pi session is scoped to
 * its working directory, so resuming across checkouts is refused before any
 * paid call rather than silently attaching to the wrong tree. */
export function resumeExecutionCwd(prior:any, sourceCwd:string, mode:IsolationMode):{ executionCwd?:string; error?:string } {
 const priorExec=priorExecutionCwd(prior);
 const priorMode=priorIsolationMode(prior);
 if (mode === 'worktree') {
  if (priorMode !== 'worktree') return {error:'resume prior run used isolation=none but this contract requests isolation=worktree; resuming across checkouts is not supported'};
  if (!priorExec) return {error:'resume prior worktree run has no recorded executionCwd'};
  return {executionCwd:priorExec};
 }
 if (priorMode === 'worktree') return {error:`resume prior run used isolation=worktree (${priorExec ?? 'unknown'}) but this contract requests isolation=none; use isolation=worktree to continue in the same checkout`};
 if (priorExec && priorExec !== sourceCwd) return {error:`resume prior run executed in ${priorExec}, not the source checkout ${sourceCwd}`};
 return {executionCwd:sourceCwd};
}

/** Bounded review-context budget. The prior transcript is never read; only the
 * original prompt/contract and the bounded change evidence are included. */
export const REVIEW_PROMPT_MAX_CHARS = 8000;
export const REVIEW_DIFF_MAX_CHARS = 16000;
export const REVIEW_CONTEXT_FILENAME = 'review-context.md';

/** Validate the shape and context paths of a `reviewFrom` subject before any
 * paid call. Returns a human-readable error, or null when the subject is
 * reviewable. */
export function validateReviewSubject(prior:any):string|null {
 if (!prior || typeof prior !== 'object' || Array.isArray(prior)) return 'reviewFrom prior result is not an object';
 if (typeof prior.id !== 'string' || !prior.id.trim()) return 'reviewFrom prior result has no id';
 if (typeof prior.status !== 'string' || !prior.status.trim()) return 'reviewFrom prior result has no status';
 if (typeof prior.artifactDir !== 'string' || !prior.artifactDir.trim()) return 'reviewFrom prior result has no artifactDir';
 if (!existsSync(prior.artifactDir)) return `reviewFrom prior artifactDir does not exist: ${prior.artifactDir}`;
 const promptPath=join(prior.artifactDir,'prompt.txt');
 if (!existsSync(promptPath)) return `reviewFrom prior prompt.txt is missing: ${promptPath}`;
 const evidencePath=join(prior.artifactDir,'evidence.json');
 if (!existsSync(evidencePath) && !(prior.evidence && typeof prior.evidence === 'object')) return `reviewFrom prior change evidence is missing: ${evidencePath}`;
 return null;
}

function boundText(text:unknown, maxChars:number):string {
 const s=String(text ?? '');
 return s.length > maxChars ? `${s.slice(0,maxChars)}\n... (truncated)` : s;
}

/** Build the compact grounded review context from a prior result: the original
 * prompt/contract evidence and the complete tracked/staged/untracked change
 * evidence. The full transcript is deliberately not loaded. */
export function buildReviewContext(prior:any):{ text?:string; files?:string[]; error?:string } {
 const artifactDir=prior?.artifactDir;
 const promptPath=join(artifactDir,'prompt.txt');
 let prompt:string;
 try { prompt=readFileSync(promptPath,'utf8'); } catch { return {error:`reviewFrom prior prompt.txt is not readable: ${promptPath}`}; }
 const evidencePath=join(artifactDir,'evidence.json');
 let evidence:any=null;
 if (existsSync(evidencePath)) {
  try { evidence=JSON.parse(readFileSync(evidencePath,'utf8')); } catch { return {error:`reviewFrom prior evidence.json is not valid JSON: ${evidencePath}`}; }
 }
 if (!evidence || typeof evidence !== 'object') evidence={...(prior?.evidence && typeof prior.evidence === 'object' ? prior.evidence : {})};
 const runChanged=Array.isArray(evidence.runChangedFiles) ? evidence.runChangedFiles : [];
 const files=runChanged.map((f:any)=>(typeof f === 'string' ? f : f?.path)).filter((p:any)=>typeof p === 'string');
 const after=evidence.after && typeof evidence.after === 'object' ? evidence.after : null;
 const diff=after && typeof after.diff === 'string' ? after.diff : '';
 const checks=Array.isArray(prior?.checks) ? prior.checks : [];
 const workflow=prior?.workflow && typeof prior.workflow === 'object' ? (prior.workflow.selected ?? prior.workflow.workflow ?? 'unknown') : (prior?.workflow ?? 'unknown');
 const lines=[
  'Independent QA review context (grounded; the full transcript is intentionally not loaded).',
  `Prior result: id=${prior?.id ?? 'unknown'} status=${prior?.status ?? 'unknown'} workflow=${workflow}`,
  `Prior checks: ${checks.length ? checks.map((c:any)=>`${[c?.command,...(Array.isArray(c?.args)?c.args:[])].filter(Boolean).join(' ')} => exit ${c?.exitCode ?? 'null'}`).join('; ') : 'none recorded'}`,
  `Prior worker error: ${prior?.workerError ? String(prior.workerError) : 'none recorded'}`,
  `Changed files (complete tracked/staged/untracked): ${files.length ? files.join(', ') : 'none recorded'}`,
  `Bounded change evidence (git diff HEAD${after?.truncated ? ' (truncated)' : ''}):`,
  boundText(diff, REVIEW_DIFF_MAX_CHARS) || '(no diff text recorded)',
  'Original prompt/contract evidence (bounded):',
  boundText(prompt, REVIEW_PROMPT_MAX_CHARS),
 ].join('\n');
 return { text:lines, files };
}

/** Resolve and validate `reviewFrom` before any paid call, returning the parsed
 * prior result and its compact grounded review context. */
export function loadReview(t:any, resolvedCwd:string):{ prior?:any; context?:string; error?:string } {
 if (typeof t.reviewFrom !== 'string' || !t.reviewFrom.trim()) return {error:'reviewFrom is required for workflow qa' };
 const path=resolve(resolvedCwd, t.reviewFrom);
 let raw:string;
 try { raw=readFileSync(path,'utf8'); } catch { return {error:`reviewFrom not readable: ${path}`}; }
 let prior:any;
 try { prior=JSON.parse(raw); } catch { return {error:`reviewFrom is not valid JSON: ${path}`}; }
 const shapeError=validateReviewSubject(prior);
 if (shapeError) return {error:shapeError};
 const built=buildReviewContext(prior);
 if (built.error) return {error:built.error};
 return { prior, context:built.text };
}
