# Runtime Hook Contract

This reference defines hook behavior for:

- Codex CLI
- Codex Desktop
- Gemini CLI
- Copilot CLI
- Copilot in VS Code

Use [runtime-hook-ops.md](runtime-hook-ops.md) only when installing, repairing,
or live-testing hooks.

## Decision Source Priority

The hook reads active quest state in this order:

1. canonical V3 stage in `.loopo/quests/{slug}/tasks.yaml`
2. latest V3 event in `.loopo/quests/{slug}/handoffs.jsonl`
3. child slug state under `.loopo/quests/{slug}/children/*.yaml`

Active quest slug is resolved from `.loopo/state.json`.
Archived quests under `.loopo/archieve/{slug}` are inactive and must not
trigger continuation.

## Continuation Rules

- Continue only when latest `stop_reason` is exactly `none`.
- Continue as an automatic drain chain across hook-triggered turns until:
  - terminal handoff appears, or
  - all work is stalled, or
  - continuation budget is exhausted.
- Treat `all_done` and `all_blocked_or_deferred` as terminal only when the
  task table matches that terminal state; otherwise treat the handoff as stale
  drift, continue the hook chain, and repair the handoff before ending.
- Stop for every other stop reason.

## Managed Drift Guard

- Before any continuation decision, hash all managed quest files:
- `tasks.yaml`, `plan.yaml`, JSONL sidecars, child files, root system docs,
  and manifests.
- Compare against the latest stored managed hashes in `.loopo/state.json`.
- If mismatch is detected, mark `managed_file_drift` and emit no continuation.
- Recovery path is `loopo doctor --fix`.

## Duplicate Suppression

- Ignore only exact same-state duplicate end-events for:
  `(runtime, hook_event_name, context_root, active_quest_slug, iteration, snapshot_fingerprint)`.
- Keep suppressing duplicates while the snapshot is unchanged, even if events
  are delayed.
- Do not suppress later events once the snapshot has advanced.

## Budget Guard

- Limit each automatic continuation chain to 12 non-terminal hook-triggered
  turns per `(runtime, context_root, active_quest_slug)` chain.
- When budget is reached, emit one final continuation prompt directing terminal
  handoff append with `stop_reason: budget_exhausted`.
- The next end-event sees terminal handoff and emits no continuation.

## Runtime Event Mapping

- Codex:
  - event: `Stop`
  - continue output: `{ "decision": "block", "reason": "..." }`
- Gemini:
  - event: `AfterAgent`
  - continue output: `{ "decision": "deny", "reason": "..." }`
- Copilot shared `.github/hooks` lane:
  - events: `sessionStart`, `sessionEnd`, `agentStop`, `Stop` (VS Code surface)
  - `Stop` output includes VS Code `hookSpecificOutput` plus flat
    `decision`/`reason` fields
