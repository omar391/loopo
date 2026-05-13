# Runtime Hook Ops

Use this reference only when installing, repairing, or testing runtime hooks.

```bash
bun index.ts init "loopo: build" --cwd /path/to/repo --runtime all
bun index.ts quest next --slug build --json @request.json
bun index.ts hook --runtime codex
bun index.ts sim start --request "build me a python app" --runtime codex
bun scripts/setup_runtime_hooks.ts --repo /path/to/repo --runtime all --hook-script /abs/path/to/scripts/loopo_sim.ts
```

Generated files:

- `.loopo/system.yaml`
- `.loopo/docs/*.yaml`
- `.loopo/manifest.sign.json`
- `.loopo/quests/{slug}/tasks.yaml`
- `.loopo/quests/{slug}/plan.yaml`
- `.loopo/quests/{slug}/children/*.yaml`
- `.loopo/quests/{slug}/manifest.sign.json`

Verification:

```bash
bun scripts/verify_coherency.ts
bun scripts/verify_quest_contract.ts
bun scripts/verify_runtime_hooks.ts
bun scripts/verify_runtime_simulation.ts
bun scripts/verify_runtime_stepper.ts
bun test scripts/verify_child_agent_integration.test.ts
```
