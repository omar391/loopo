#!/usr/bin/env bun

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTasksYaml, questFiles } from "./loopo_core.ts";
import { readText, runCommand, tsRunner } from "./loopo_utils.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOOPO_SCRIPT = resolve(SCRIPT_DIR, "loopo.ts");
const SETUP_RUNTIME_HOOKS_SCRIPT = resolve(
  SCRIPT_DIR,
  "setup_runtime_hooks.ts",
);
const SIM_RUNTIME_SCRIPT = resolve(SCRIPT_DIR, "loopo_sim.ts");
const SIM_DIR = join(".loopo", "sim-runtime");

type Runtime = "codex" | "gemini" | "copilot";

type Fixture = {
  root: string;
  repo: string;
  env: Record<string, string>;
};

function fail(message: string): never {
  throw new Error(message);
}

function parseJson(text: string, label: string): Record<string, any> {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed as Record<string, any>;
  } catch {
    fail(`expected JSON for ${label}: ${text}`);
  }
}

function stepId(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const id = (value as Record<string, unknown>).id;
    return typeof id === "string" ? id : "";
  }
  return "";
}

function readJsonl(path: string): Array<Record<string, any>> {
  return readText(path)
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => parseJson(line, path));
}

function runTsScript(
  script: string,
  args: string[],
  input: Record<string, unknown> | undefined,
  cwd: string,
  env: Record<string, string>,
) {
  const launch = tsRunner(script, args);
  return runCommand(launch.cmd, launch.args, {
    cwd,
    env,
    input: input ? JSON.stringify(input) : undefined,
    timeoutMs: 60_000,
  });
}

function runLoopo(
  fixture: Fixture,
  args: string[],
  input?: Record<string, unknown>,
) {
  return runTsScript(LOOPO_SCRIPT, args, input, fixture.repo, fixture.env);
}

function createFixture(prefix: string, runtime: Runtime): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const repo = join(root, "repo");
  const env = {
    HOME: join(root, "home"),
    LOOPO_GLOBAL_BIN: join(root, "bin", "loopo"),
    LOOPO_SCRIPT: LOOPO_SCRIPT,
  };
  const init = runCommand("git", ["init", repo], {
    env,
    timeoutMs: 15_000,
  });
  if (init.status !== 0) fail(init.stderr || init.stdout);
  for (const [key, value] of [
    ["user.email", "loopo-test@example.invalid"],
    ["user.name", `Loopo ${runtime} Simulation`],
  ] as const) {
    const proc = runCommand("git", ["config", key, value], {
      cwd: repo,
      env,
      timeoutMs: 15_000,
    });
    if (proc.status !== 0) fail(proc.stderr || proc.stdout);
  }
  writeFileSync(join(repo, "README.md"), "# loopo simulation\n", "utf8");
  writeFileSync(join(repo, "hook-fixture.txt"), "hook fixture\n", "utf8");
  writeFileSync(
    join(repo, "callback-fixture.txt"),
    "callback fixture\n",
    "utf8",
  );
  const add = runCommand(
    "git",
    ["add", "README.md", "hook-fixture.txt", "callback-fixture.txt"],
    {
      cwd: repo,
      env,
      timeoutMs: 15_000,
    },
  );
  if (add.status !== 0) fail(add.stderr || add.stdout);
  const commit = runCommand("git", ["commit", "-m", "fixture"], {
    cwd: repo,
    env,
    timeoutMs: 15_000,
  });
  if (commit.status !== 0) fail(commit.stderr || commit.stdout);
  return { root, repo, env };
}

function collectHookCommands(
  value: unknown,
  commands: Array<{ raw: string; normalized: string }> = [],
): Array<{ raw: string; normalized: string }> {
  if (Array.isArray(value)) {
    for (const item of value) collectHookCommands(item, commands);
    return commands;
  }
  if (!value || typeof value !== "object") return commands;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      (key === "command" || key === "bash") &&
      typeof child === "string" &&
      child.trim()
    ) {
      commands.push({
        raw: child,
        normalized: child.replace(/['"]/g, " ").replace(/\s+/g, " ").trim(),
      });
      continue;
    }
    collectHookCommands(child, commands);
  }
  return commands;
}

function hookConfigPath(repo: string, runtime: Runtime): string {
  if (runtime === "codex") return join(repo, ".codex", "hooks.json");
  if (runtime === "gemini") return join(repo, ".gemini", "settings.json");
  return join(repo, ".github", "hooks", "loopo.json");
}

function installedHookCommand(repo: string, runtime: Runtime): string {
  const config = parseJson(
    readFileSync(hookConfigPath(repo, runtime), "utf8"),
    `${runtime} hook config`,
  );
  const source =
    runtime === "codex"
      ? (config.hooks?.Stop ?? [])
      : runtime === "gemini"
        ? (config.hooks?.AfterAgent ?? [])
        : (config.hooks?.Stop ?? []);
  const commands = collectHookCommands(source);
  const selected =
    commands.find(({ normalized }) => normalized.includes("loopo_sim.ts")) ??
    commands[0];
  if (!selected) {
    fail(`missing installed hook command for ${runtime}`);
  }
  return selected.raw;
}

function hookEventName(runtime: Runtime): string {
  return runtime === "gemini" ? "AfterAgent" : "Stop";
}

function triggerInstalledHook(
  fixture: Fixture,
  runtime: Runtime,
): Record<string, any> {
  const command = installedHookCommand(fixture.repo, runtime);
  const payload = {
    hook_event_name: hookEventName(runtime),
    cwd: fixture.repo,
  };
  const proc = runCommand("bash", ["-lc", command], {
    cwd: fixture.repo,
    env: fixture.env,
    input: JSON.stringify(payload),
    timeoutMs: 60_000,
  });
  if (proc.status !== 0) {
    fail(
      proc.stderr || proc.stdout || `installed ${runtime} hook command failed`,
    );
  }
  return parseJson(proc.stdout || "{}", `${runtime} hook output`);
}

function runCallback(fixture: Fixture): Record<string, any> {
  const proc = runTsScript(
    LOOPO_SCRIPT,
    ["sim", "callback", "--repo", fixture.repo],
    undefined,
    fixture.repo,
    fixture.env,
  );
  if (proc.status !== 0) fail(proc.stderr || proc.stdout);
  return parseJson(proc.stdout, "simulation callback output");
}

function currentStage(fixture: Fixture, slug: string): string {
  const files = questFiles(fixture.repo, slug);
  return String(parseTasksYaml(readText(files.tasks)).stage ?? "");
}

function assertRuntimeHookShape(
  runtime: Runtime,
  payload: Record<string, any>,
) {
  if (runtime === "gemini") {
    if (payload.decision !== "deny" || payload.suppressOutput !== true) {
      fail(
        `gemini hook output must deny with suppressOutput: ${JSON.stringify(payload)}`,
      );
    }
    return;
  }
  if (payload.decision !== "block") {
    fail(`${runtime} hook output must block: ${JSON.stringify(payload)}`);
  }
  if (runtime === "copilot" && !payload.hookSpecificOutput) {
    fail(`copilot hook output must include hookSpecificOutput`);
  }
}

function assertLifecycleLog(repo: string): void {
  const events = readJsonl(join(repo, SIM_DIR, "events.jsonl"));
  const callbacks = events.filter((record) => record.kind === "callback");
  const hookEvents = events.filter((record) => record.kind === "hook");
  if (callbacks.length !== 11) {
    fail(`expected 11 callback turns, got ${callbacks.length}`);
  }
  if (hookEvents.length !== callbacks.length) {
    fail(
      `hook/callback turn count mismatch: ${hookEvents.length} vs ${callbacks.length}`,
    );
  }
  const requestSteps = callbacks.map((record) => stepId(record.request?.step));
  const responseSteps = callbacks.map((record) =>
    stepId(record.response?.step),
  );
  for (const step of [
    "plan",
    "questions",
    "task_graph",
    "executing",
    "validation",
    "verification",
    "system_update",
    "landing",
  ]) {
    if (!requestSteps.includes(step)) {
      fail(`simulation never requested lifecycle step ${step}`);
    }
  }
  for (const step of [
    "questions",
    "plan",
    "task_graph",
    "executing",
    "validation",
    "verification",
    "system_update",
    "landing",
    "archived",
  ]) {
    if (!responseSteps.includes(step)) {
      fail(`simulation never reached lifecycle response step ${step}`);
    }
  }
  if (existsSync(join(repo, SIM_DIR, "pending-callback.json"))) {
    fail("pending callback should be cleared after the lifecycle archives");
  }
}

function simulateRuntime(runtime: Runtime): void {
  const fixture = createFixture("loopo-runtime-sim-", runtime);
  try {
    const init = runLoopo(
      fixture,
      [
        "init",
        `loopo: simulate ${runtime} runtime lifecycle`,
        "--cwd",
        fixture.repo,
        "--runtime",
        "all",
      ],
      undefined,
    );
    if (init.status !== 0) fail(init.stderr || init.stdout);
    const route = parseJson(init.stdout, `${runtime} init`);
    const slug = String(route.new_quest?.suggested_slug ?? "");
    if (!slug) fail(`missing slug in ${runtime} init output`);

    const created = runLoopo(
      fixture,
      ["quest", "next", "--slug", slug, "--cwd", fixture.repo, "--json", "@-"],
      {
        step: "select_quest",
        action: "create_quest",
        slug,
        request: `loopo: simulate ${runtime} runtime lifecycle`,
      },
    );
    if (created.status !== 0) fail(created.stderr || created.stdout);
    if (
      stepId(parseJson(created.stdout, `${runtime} create`).step) !== "plan"
    ) {
      fail(`${runtime} create must enter plan`);
    }

    const setup = runTsScript(
      SETUP_RUNTIME_HOOKS_SCRIPT,
      [
        "--repo",
        fixture.repo,
        "--runtime",
        "all",
        "--hook-script",
        SIM_RUNTIME_SCRIPT,
      ],
      undefined,
      fixture.repo,
      fixture.env,
    );
    if (setup.status !== 0) fail(setup.stderr || setup.stdout);

    let firstHook = true;
    for (let guard = 0; guard < 16; guard += 1) {
      if (currentStage(fixture, slug) === "archived") break;
      const hook = triggerInstalledHook(fixture, runtime);
      if (firstHook) {
        assertRuntimeHookShape(runtime, hook);
        firstHook = false;
      }
      if (!hook.reason) {
        fail(
          `${runtime} hook returned no continuation before archive: ${JSON.stringify(hook)}`,
        );
      }
      const callback = runCallback(fixture);
      if (!stepId(callback.step)) {
        fail(
          `${runtime} callback returned malformed output: ${JSON.stringify(callback)}`,
        );
      }
    }

    if (currentStage(fixture, slug) !== "archived") {
      fail(`${runtime} simulation did not reach archived`);
    }
    assertLifecycleLog(fixture.repo);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function main(): number {
  for (const runtime of ["codex", "gemini", "copilot"] as const) {
    simulateRuntime(runtime);
  }
  console.log("loopo runtime simulation verification passed");
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
