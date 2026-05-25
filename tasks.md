# Cmdproto Transparent Wrapper Tasks

1. `completed` Align `cmdproto` with the transparent-wrapper contract:
   keep `execute` as the machine entrypoint, preserve direct app outputs and exit status, and finish the related runtime, schema, help, docs, and test updates.
2. `completed` Refactor Loopo's `cmdproto` integration to call direct service handlers instead of shelling back into the CLI, while preserving the existing human command behavior for `init`, `quest next`, `quest help`, `hook`, `doctor`, and `sim`.
3. `completed` Update Loopo's proto/runtime surface to use direct domain-shaped outputs, field-level JSON payload binding, and the refined `cmdproto execute --json` machine examples.
4. `completed` Update Loopo docs, references, behavior specs, and verifiers to match the transparent-wrapper model, including retiring stale `quest help --json` expectations where required by the plan.
5. `completed` Run the required verification commands in both repos, fix any regressions, and land the resulting worktree branches cleanly.
