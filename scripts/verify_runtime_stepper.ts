#!/usr/bin/env bun

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./loopo_utils.ts";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "loopo.ts");

function fail(message: string): never {
  throw new Error(message);
}

function parseJson(text: string): Record<string, any> {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("expected object");
    }
    return parsed;
  } catch {
    fail(`expected JSON object, got: ${text}`);
  }
}

function runSim(args: string[]) {
  return runCommand("bun", [SCRIPT, "sim", ...args], {
    timeoutMs: 120_000,
  });
}

function main(): number {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loopo-stepper-")));
  const repo = join(root, "repo");
  try {
    const start = runSim([
      "start",
      "--repo",
      repo,
      "--request",
      "build me a python app",
      "--runtime",
      "codex",
    ]);
    if (start.status !== 0) fail(start.stderr || start.stdout);
    const started = parseJson(start.stdout);
    if (started.slug !== "build-me-a-python-app") {
      fail(`unexpected slug from start: ${start.stdout}`);
    }
    if (started.current_stage !== "planning") {
      fail(`start must create a planning quest: ${start.stdout}`);
    }

    const seenOutputs: string[] = [];
    let sawParallelExecuting = false;
    for (let i = 0; i < 20; i += 1) {
      const next = runSim(["next", "--repo", repo]);
      if (next.status !== 0) fail(next.stderr || next.stdout);
      const step = parseJson(next.stdout);
      const outputStep = String(step.callback_output?.step?.id ?? "");
      if (outputStep) seenOutputs.push(outputStep);
      if (
        outputStep === "executing" &&
        Array.isArray(step.callback_output?.children) &&
        step.callback_output.children.length >= 2
      ) {
        sawParallelExecuting = true;
      }
      if (step.done === true) break;
    }

    const expected = [
      "questions",
      "plan",
      "task_graph",
      "executing",
      "validation",
      "verification",
      "system_update",
      "landing",
      "archived",
    ];
    for (const step of expected) {
      if (!seenOutputs.includes(step)) {
        fail(`stepper never emitted ${step}: ${JSON.stringify(seenOutputs)}`);
      }
    }
    if (!sawParallelExecuting) {
      fail(
        `stepper never exposed parallel-ready children: ${JSON.stringify(seenOutputs)}`,
      );
    }

    const status = runSim(["status", "--repo", repo]);
    if (status.status !== 0) fail(status.stderr || status.stdout);
    const current = parseJson(status.stdout);
    if (current.current_stage !== "archived" || current.done !== true) {
      fail(
        `status must report archived after the stepped run: ${status.stdout}`,
      );
    }
    if (Number(current.callback_count) !== 13) {
      fail(`expected 13 simulated callbacks, got ${current.callback_count}`);
    }

    console.log("loopo runtime stepper verification passed");
    return 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
