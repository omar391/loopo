# Loopo Parallel Worktree Hard Cut

1. [x] Preserve the current checkpointed changes on `main` and avoid reverting unrelated staged work while implementing the hard cut directly in this repo.
2. [x] Audit the public command surface for `slug`, `cwd`, `session`, active-session pointer, `state.json`, and latest-quest fallback usage.
3. [x] Define `wtree` as the canonical public quest/session selector and ensure it is treated as a basename, not a filesystem path.
4. [x] Update `init` so it is repo-root oriented and does not accept public `--cwd` or `--slug` inputs.
5. [x] Update continuation commands so `quest next` and related external step calls require `--wtree <base-worktree-name>` instead of `--cwd`, `--slug`, `--session`, active quest state, or latest quest fallback.
6. [x] Remove `.loopo/state.json` from quest selection and stop writing or relying on active quest state for continuation.
7. [x] Remove git-dir active-session pointer reads/writes from active quest selection.
8. [x] Keep legacy internal quest-file compatibility only where needed to read existing task YAML safely, without exposing `slug` as a public selector.
9. [x] Implement a shared deterministic hook worktree resolver that accepts explicit `--wtree`, payload `wtree`, payload `loopo_wtree`, normalized envelope cwd, payload cwd, or process cwd.
10. [x] Make hook cwd resolution derive `wtree` from `<repo>/worktrees/<name>` paths and from Git worktree top-level paths when available.
11. [x] Validate hook resolution by requiring a basename `wtree`, requiring `.loopo/quests/<wtree>/tasks.yaml`, and rejecting explicit/cwd signal conflicts.
12. [x] Ensure repo-root hook cwd never implies a quest, even if only one quest exists.
13. [x] Ensure ambiguous, missing, invalid, or conflicting hook context returns the runtime no-op output and mutates no quest files.
14. [x] Keep installed Codex, Gemini, Copilot, and sim hook commands generic (`loopo hook --runtime <runtime>`) with identity supplied by runtime cwd or explicit test payload.
15. [x] Update sim continuation and hook passthrough to use the same `wtree` selector and hook resolver as the main `loopo` runtime, with no sim-only sidecars.
16. [x] Remove public `--slug`, `--cwd`, and `--session` options from generated schemas, proto/cmdproto metadata, docs, emitted commands, and command help/introspection.
17. [x] Update JSON schemas and generated artifacts so public payloads expose `wtree` and local `schema_path` only.
18. [x] Update user-facing README and architecture references to describe the base-worktree-name model, root-only init, `--wtree` continuation, and deterministic hook no-op behavior.
19. [x] Add or update tests proving two parallel worktrees can continue independently with `next --wtree a` and `next --wtree b`.
20. [x] Add or update tests proving Codex, Gemini, Copilot, and sim hooks resolve from cwd inside different worktrees.
21. [x] Add or update tests proving repo-root hooks, missing selectors, invalid selectors, and explicit/cwd conflicts no-op without quest mutation.
22. [x] Add or update contract tests proving removed public selectors (`slug`, `cwd`, `session`) do not reappear in proto, schemas, generated docs, emitted commands, or cmdproto output.
23. [x] Run targeted verification for command contracts, quest contracts, hook behavior, sim behavior, schema coherency, and runtime stepper behavior.
24. [x] Run `bun run verify` after all generated artifacts and docs are synchronized.
25. [x] Review the final diff for staged-checkpoint safety, unrelated churn, stale references, and task ledger completion.
26. [x] Update the `loopo-dev` skill with the smallest durable lesson from this run before finishing.
