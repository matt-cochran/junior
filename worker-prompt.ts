import { dirname } from 'node:path';
import { briefMdPath, briefPath } from './prepare.ts';
import type { ToolRoute } from './tool-routing.ts';
import type { ResumeInfo } from './worker-resume.ts';
import { COMMON_PROMPT_BLOCK, WORKFLOW_PROMPT_BLOCKS, type ExplicitWorkflow } from './worker-workflows.ts';
import { codeContextBlock, boundedContextBlock, type ResolvedContextEntry } from './worker-contract.ts';

/** Fixed report requirement block for the report-only QA workflow. */
export function qaReportBlock(reportPath:string):string {
 return [
  `QA report requirement: write the complete review report to this exact artifact path: ${reportPath}`,
  'Save the report there before finishing. The handback is needs_review until that file exists; a missing report is never reported as completion.',
  'The report must list every finding with severity, the concrete file reference, the affected acceptance ID, the evidence and the recommended check; separate confirmed findings from uncertainties; and state that review completion is not deliverable acceptance.',
  'This is an instruction to the worker, not a sandbox guarantee.',
 ].join('\n');
}

/** Fixed report requirement block appended only to analysis-only workflow
 * prompts. It names the deterministic artifact path and states that completion
 * is not claimed until the report exists. This is an instruction, not a
 * sandbox guarantee. */
export function analysisReportBlock(reportPath:string):string {
 return [
  `Analysis report requirement: write the complete analysis report to this exact artifact path: ${reportPath}`,
  'Save the report there before finishing. The handback is needs_review until that file exists; a missing report is never reported as completion.',
  'The report must, for every risk, state the domain, failure mode, cause, effect, qualitative Severity and Probability, mitigation and its justification, production observability, and residual Severity and Probability; before labelling a claim tested/proven-here, open the cited file and quote the cited span (a few lines, with path:line) in the report, and label a claim whose span was not opened and quoted as inferred, not proven-here; label each claim tested/proven-here, adapted or speculation; separate existing verified controls from proposed mitigation; state residual risk as conditional; and never declare a risk eliminated merely by proposing a fix. The report is a set of leads for the manager to verify, not findings.',
  'This is an instruction to the worker, not a sandbox guarantee.',
 ].join('\n');
}

/** Fixed report requirement block for the discover requirements-interview
 * workflow. It names the deterministic artifact path and the interview report
 * contents. This is an instruction to the worker, not a sandbox guarantee. */
export function discoverReportBlock(reportPath:string):string {
 return [
  `Analysis report requirement: write the complete analysis report to this exact artifact path: ${reportPath}`,
  'Save the report there before finishing. The handback is needs_review until that file exists; a missing report is never reported as completion.',
  'The report must contain: the established claims and their evidence; the open questions ranked by leverage (from question.next), each with a suggested answer and why; the contradictions found; and the readiness.assess result. Never invent user answers. The report is a set of leads for the manager to verify, not findings.',
  'This is an instruction to the worker, not a sandbox guarantee.',
 ].join('\n');
}

/** Fixed report requirement block for the investigate scientific-process
 * workflow. It names the deterministic artifact path and the experiment report
 * contents. This is an instruction to the worker, not a sandbox guarantee. */
export function investigateReportBlock(reportPath:string):string {
 return [
  `Analysis report requirement: write the complete analysis report to this exact artifact path: ${reportPath}`,
  'Save the report there before finishing. The handback is needs_review until that file exists; a missing report is never reported as completion.',
  'The report must contain: the hypothesis, the experiment, the prediction, the observation, the raw evidence, and the recommended next experiment or conclusion. Never conclude Supported without supporting observations. The report is a set of leads for the manager to verify, not findings.',
  'This is an instruction to the worker, not a sandbox guarantee.',
 ].join('\n');
}

/** Fixed report requirement block for the prepare workflow. It names both
 * deterministic artifacts (brief.json and brief.md) so the handback is
 * needs_choice only after the brief exists. This is an instruction to the
 * worker, not a sandbox guarantee. */
export function prepareReportBlock(reportPath:string):string {
 const dir=dirname(reportPath);
 return [
  `Prepare brief requirement: write the machine-readable brief to this exact artifact path: ${briefPath(dir)}`,
  `Write the human-readable brief to this exact artifact path: ${briefMdPath(dir)}`,
  'Save both there before finishing. The handback is needs_choice until brief.json exists; a missing brief is never reported as completion or failure.',
  'The brief must validate against the prepare schema: understanding.scope/outOfScope/assumptions (each assumption status verified or guess, with path:line evidence when verified)/acceptanceProof; options with id, title, approach, files, effort and risks; and a recommendation. Render the numbered U and A items before the options.',
  'This is an instruction to the worker, not a sandbox guarantee.',
 ].join('\n');
}

/** Select the deterministic report requirement block for a report workflow. */
export function reportBlockFor(workflow:ExplicitWorkflow, reportPath:string):string {
 if (workflow === 'qa') return qaReportBlock(reportPath);
 if (workflow === 'discover') return discoverReportBlock(reportPath);
 if (workflow === 'investigate') return investigateReportBlock(reportPath);
 if (workflow === 'prepare') return prepareReportBlock(reportPath);
 return analysisReportBlock(reportPath);
}

/** Fixed lines naming the hop handoff path and the Junior CLI command that the
 * discover and investigate workflows use to reach the tool session. Present
 * only when the contract supplies hopFrom; without it the workflow still
 * produces the report and states that the tool session was not recorded. */
export function hopToolBlock(t:any, workflow?:ExplicitWorkflow):string|null {
 const from=t?.hopContext?.from ?? (typeof t?.hopFrom === 'string' && t.hopFrom.trim() ? t.hopFrom : null);
 if (!from) return null;
 const tool = workflow === 'investigate' ? 'scientific-process' : 'elicitation';
 return [
  `Hop handoff path: ${from}`,
  `Record the tool session through the Junior CLI: junior tools call ${from} ${tool} <request.json> (session_id = the contract id).`,
 ].join('\n');
}

/** One line per routed tool application, with the contract's hop path
 * substituted for `<hop>`. Present only when the contract supplies hopFrom, so
 * a worker is never told to run a tool command it cannot record. */
export function toolDirectionsBlock(t:any, routing?:ToolRoute|null):string|null {
 const from=t?.hopContext?.from ?? (typeof t?.hopFrom === 'string' && t.hopFrom.trim() ? t.hopFrom : null);
 if (!from || !routing || !routing.workerDirections.length) return null;
 const lines=['Tool routing directions:'];
 for (const direction of routing.workerDirections) lines.push(`- ${direction.replaceAll('<hop>', from)}`);
 return lines.join('\n');
}

/** Build the fixed prompt blocks for a workflow. The only variable content is
 * the task contract JSON, the deterministic report path and (for qa) the
 * grounded review context; no Jev-generated prose is inserted. */
export function promptParts(workflow:ExplicitWorkflow, resume?:ResumeInfo|null, reportPath?:string|null, reviewContext?:string|null, codeContext?:ResolvedContextEntry[]|null):{ common:string; workflow:string; resume:string|null; report:string|null; review:string|null; context:string|null } {
 let resumeBlock:string|null=null;
 if (resume) {
  resumeBlock=[
   `Resume context: this run continues the prior Pi session ${resume.sessionId}.`,
   'The new task contract below is appended to that session.',
   'Do not treat any prior recommendation as authorization to modify production code.',
  ].join('\n');
 }
 const reportBlock = reportPath ? reportBlockFor(workflow, reportPath) : null;
 const reviewBlock = reviewContext ? reviewContext : null;
 const contextBlock = codeContext ? codeContextBlock(codeContext) : null;
 return {common:COMMON_PROMPT_BLOCK, workflow:WORKFLOW_PROMPT_BLOCKS[workflow], resume:resumeBlock, report:reportBlock, review:reviewBlock, context:contextBlock};
}

export function buildPrompt(t:any, workflow:ExplicitWorkflow, resume?:ResumeInfo|null, reportPath?:string|null, reviewContext?:string|null, codeContext?:ResolvedContextEntry[]|null, routing?:ToolRoute|null, executionCwd?:string|null):string {
 const parts=promptParts(workflow, resume, reportPath, reviewContext, codeContext);
 const blocks=[parts.common, parts.workflow];
 const hop = (workflow === 'discover' || workflow === 'investigate') ? hopToolBlock(t, workflow) : null;
 if (hop) blocks.push(hop);
 const directions = toolDirectionsBlock(t, routing);
 if (directions) blocks.push(directions);
 if (parts.report) blocks.push(parts.report);
 if (parts.review) blocks.push(parts.review);
 if (parts.context) blocks.push(parts.context);
 const bounded=boundedContextBlock(t);
 if (bounded) blocks.push(bounded);
 if (parts.resume) blocks.push(parts.resume);
 // The contract must name the checkout the worker actually runs in, never the
 // source checkout a worktree run is isolated from.
 const execCwd = executionCwd ?? t?.cwd;
 blocks.push(`Execution checkout: ${execCwd}. Read and write files only inside it (use relative paths); the source checkout is off limits.`);
 blocks.push(`Task contract (JSON):\n${JSON.stringify({...t, cwd:execCwd})}`);
 return blocks.join('\n\n');
}
