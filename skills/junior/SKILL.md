---
name: junior
description: Delegate a bounded coding deliverable to DeepSeek through the local Junior delivery worker, then review its artifacts and independent checks. Use when the user requests Junior or wants commodity-model execution under premium-model supervision.
---

# Junior

You manage the deliverable; DeepSeek executes through Pi. Junior is installed at `/home/mc/working/delivery-worker` in Ubuntu-24.04 WSL. Read that project's README only for optional fields or troubleshooting. Keep the manager context small: contract, result, relevant diff and check evidence; read full events only when diagnosing a failure.

## Dispatch

Choose one concrete artifact and independently verifiable acceptance criteria. Keep strategic uncertainty, broad architecture decisions and final acceptance with the manager. Use `recon` when mechanisms are unknown; review its findings before explicitly authorizing implementation. Use `test_first` for behavior changes and `checks_first` for setup/docs. Jev is advisory: use shadow mode initially; its verdict alone does not establish correctness.

Create a JSON contract in the target workspace containing:

```json
{
  "id": "unique-deliverable-id",
  "deliverable": "A precise artifact and resulting behavior",
  "cwd": "/absolute/target/checkout",
  "provider": "openrouter",
  "model": "deepseek/deepseek-v4.1-flash",
  "workflow": "test_first",
  "acceptance": ["Observable behavior to verify"],
  "constraints": ["Allowed files and explicit exclusions; no commits or pushes unless authorized", "Restrict searches to the checkout and named dependency paths; no nested workers"],
  "checks": [{"command": "node", "args": ["--test", "relevant.test.ts"]}],
  "jev": {"mode": "shadow"}
}
```

Replace illustrative fields with real requirements and runnable checks. Point to relevant files and instructions instead of copying conversation history. `cwd` is where DeepSeek edits and checks run; task paths passed to the CLI should be absolute. For another repository, inspect its instructions and existing changes first, and isolate work when needed. The worker executes with your filesystem access: contract scope is instruction, not sandbox enforcement.

In WSL, with Node and Pi on PATH:

```bash
node /home/mc/working/delivery-worker/worker.ts doctor
node /home/mc/working/delivery-worker/worker.ts validate /absolute/task.json
node /home/mc/working/delivery-worker/worker.ts run /absolute/task.json
```

From Windows, invoke through WSL. The tested runtime is:

```powershell
wsl.exe -d Ubuntu-24.04 --cd /home/mc/working/delivery-worker -- env PATH=/home/mc/.nvm/versions/node/v26.5.0/bin:/usr/local/bin:/usr/bin:/bin node worker.ts run /absolute/task.json
```

The `doctor` command checks Junior's configured defaults; explicit task overrides still need review. `run` spends provider credits. Follow the user's delegation authorization and normal execution permissions; the skill does not authorize unrelated external actions. If setup is missing, use `init`; installing Pi requires `init --install`. Authenticate through Pi `/login`, never collect or print credentials.

## Review and handback

Use the returned `artifactDir/result.json`, check logs and relevant changed files. Confirm the receipt's observed model matches the requested DeepSeek model. `ready_for_review` is a handoff, not acceptance. Inspect new, staged and modified files: the current Jev diff evidence may omit new/staged files. Verify scope and acceptance with meaningful checks; preserve existing tests.

For a specific repair, issue a new bounded contract with `resumeFrom` pointing to the prior result.json and the same cwd/provider/model. Limit automatic repairs to one unless the user authorizes more; escalate an unresolved blocker with evidence. Never treat a recon recommendation as approval to implement. Session continuation preserves context; cache reuse is best effort.

Report the deliverable outcome, verification, remaining issues and recorded model/cost briefly. Pi's zero catalog cost is not billed cost; an unavailable estimate remains unknown. Persist accepted deliverables and next dependencies in a small project plan so the manager can resume without loading transcripts.
