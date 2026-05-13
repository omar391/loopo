import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./loopo_utils.ts";
import { validateV3Input } from "./loopo_schema.ts";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "loopo.ts");

type Fixture = {
  root: string;
  repo: string;
  env: Record<string, string>;
};

function parseJson(stdout: string): any {
  return JSON.parse(stdout);
}

function expectValidSchema(
  payload: Record<string, unknown>,
  schemaName: string,
): void {
  expect(validateV3Input(payload, schemaName)).toEqual([]);
}

function expectNoSchemaRefs(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) expectNoSchemaRefs(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  expect(value).not.toHaveProperty("$ref");
  for (const item of Object.values(value)) expectNoSchemaRefs(item);
}

function runLoopo(
  cwd: string,
  args: string[],
  input?: Record<string, unknown>,
  env: Record<string, string> = {},
) {
  return runCommand("bun", [SCRIPT, ...args], {
    cwd,
    env,
    timeoutMs: 60_000,
    input: input ? JSON.stringify(input) : undefined,
  });
}

function runGit(cwd: string, args: string[]): void {
  const proc = runCommand("git", args, { cwd, timeoutMs: 30_000 });
  expect(proc.status, proc.stderr || proc.stdout).toBe(0);
}

function createFixture(prefix: string): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const repo = join(root, "repo");
  const env = {
    HOME: join(root, "home"),
    LOOPO_GLOBAL_BIN: join(root, "bin", "loopo"),
    LOOPO_SCRIPT: SCRIPT,
  };
  const initGit = runCommand("git", ["init", repo], { timeoutMs: 15_000 });
  expect(initGit.status, initGit.stderr || initGit.stdout).toBe(0);
  runGit(repo, ["config", "user.email", "loopo-test@example.invalid"]);
  runGit(repo, ["config", "user.name", "Loopo Test"]);
  writeFileSync(join(repo, "README.md"), "# loopo v3 integration\n", "utf8");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "fixture"]);
  return { root, repo, env };
}

function next(
  fixture: Fixture,
  slug: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const proc = runLoopo(
    fixture.repo,
    [
      "quest",
      "next",
      "--slug",
      slug,
      "--cwd",
      fixture.repo,
      "--json",
      "@-",
      "--full",
    ],
    payload,
    fixture.env,
  );
  expect(proc.status, proc.stderr || proc.stdout).toBe(0);
  return parseJson(proc.stdout);
}

function compactCurrent(
  fixture: Fixture,
  slug: string,
): Record<string, unknown> {
  const proc = runLoopo(
    fixture.repo,
    ["quest", "next", "--slug", slug, "--cwd", fixture.repo, "--json", "@-"],
    {},
    fixture.env,
  );
  expect(proc.status, proc.stderr || proc.stdout).toBe(0);
  return parseJson(proc.stdout);
}

describe("loopo v3 child slug integration", () => {
  it("documents the v3 command flow in quest help", () => {
    const fixture = createFixture("loopo-v3-help-");
    try {
      const usage = runLoopo(fixture.repo, [], undefined, fixture.env);
      expect(usage.status).toBe(1);
      const publicInitLines = usage.stdout
        .split("\n")
        .filter((line) => line.trim().startsWith("loopo init "));
      expect(publicInitLines).toEqual([
        '  loopo init "loopo: <request>" --cwd <path> --runtime <codex|gemini|copilot|all> [--flow swe]',
      ]);
      const publicHookLines = usage.stdout
        .split("\n")
        .filter((line) => line.trim().startsWith("loopo hook "));
      expect(publicHookLines).toEqual([
        "  loopo hook --runtime <codex|gemini|copilot>",
      ]);
      expect(usage.stdout).not.toContain("loopo spec");

      const help = runLoopo(
        fixture.repo,
        ["quest", "help", "--json"],
        undefined,
        fixture.env,
      );
      expect(help.status, help.stderr || help.stdout).toBe(0);
      const helpJson = parseJson(help.stdout);
      expectValidSchema(helpJson, "help-output");
      expect(helpJson.step).toBe("help");
      expect(helpJson.state).toBe("help");
      expect(Object.keys(helpJson.commands)).toEqual([
        "init",
        "next",
        "help",
        "hook",
      ]);
      expect(helpJson.commands.hook.cmd).toBe("loopo");
      expect(helpJson.commands.hook.args).toEqual([
        "hook",
        "--runtime",
        "codex",
      ]);
      expect(helpJson.commands.init.args).toContain("--flow");
      expect(helpJson.flows.map((flow: any) => flow.id)).toContain("swe");
      expect(helpJson.schemas.map((schema: any) => schema.name)).toContain(
        "flow.v1",
      );
      expect(helpJson.schemas.map((schema: any) => schema.name)).toContain(
        "step-definition.v1",
      );
      expect(helpJson.guide.launcher).toContain("loopo init");
      expect(helpJson.guide.rules).toContain(
        "Generated hook files only need loopo hook --runtime <runtime>.",
      );
      expect(helpJson.guide.commands.map((entry: any) => entry.name)).toEqual([
        "init",
        "quest next",
        "quest help",
        "hook",
      ]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("runs the bin-coordinated parent and child result flow", () => {
    const fixture = createFixture("loopo-v3-child-");
    try {
      const init = runLoopo(
        fixture.repo,
        [
          "init",
          "loopo: build calculator",
          "--cwd",
          fixture.repo,
          "--runtime",
          "codex",
        ],
        undefined,
        fixture.env,
      );
      expect(init.status, init.stderr || init.stdout).toBe(0);
      const route = parseJson(init.stdout);
      expectValidSchema(route, "init-output");
      expect(route.kind).toBe("init_route");
      expect(route.flow_id).toBe("swe");
      expect(route.schema_id).toBe(
        "https://loopo.dev/schemas/steps/init-output.v3.json",
      );
      const slug = String(route.new_quest.suggested_slug);

      const created = next(fixture, slug, {
        step: "select_quest",
        action: "create_quest",
        slug,
        request: "loopo: build calculator",
      });
      expectValidSchema(created, "step-output");
      expect(created.step).toBe("plan");
      expect(created.flow_id).toBe("swe");
      expect((created.context as any).step).toMatchObject({
        schema_version: 1,
        id: "plan",
        handler: "plan",
        input_step: "plan",
        callback_schema: {
          $id: "https://loopo.dev/schemas/steps/plan-input.v3.json",
          type: "object",
        },
        output_schema: "step-output",
        summary:
          "Submit a decision-complete plan payload using AF/OF fields. Ask or default every high-impact unknown.",
      });
      expect((created.context as any).step).not.toHaveProperty("input_schema");
      expect((created.context as any).step).not.toHaveProperty("spec_refs");
      expect((created.context as any).step.instructions).toContain(
        "# Loopo Plan Step",
      );
      expect((created.context as any).step.instructions).toContain(
        "## Defaulting Rules",
      );
      expect((created.context as any).step.instructions).toContain(
        "request_user_input",
      );
      expect((created.context as any).step.instructions).toContain(
        "Follow the instructions above, then construct one JSON payload matching callback_schema and send it to commands.next.",
      );
      expect(created).not.toHaveProperty("session_id");
      expect(created).not.toHaveProperty("expected_update");

      const compact = compactCurrent(fixture, slug);
      expectValidSchema(compact, "step-output");
      expect(compact).toMatchObject({
        step: {
          id: "plan",
        },
      });
      const compactStep = compact.step as Record<string, string>;
      expect(compactStep).not.toHaveProperty("summary");
      expect(compactStep.instructions).toContain("# Loopo Plan Step");
      expect(compactStep.instructions).toContain(
        "Follow the instructions above, then construct one JSON payload matching callback_schema and send it to commands.next.",
      );
      const compactCallbackSchema = compact.callback_schema as Record<
        string,
        any
      >;
      expect(compactCallbackSchema).toMatchObject({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://loopo.dev/schemas/steps/plan-input.v3.json",
        type: "object",
      });
      expect(compactCallbackSchema.required).toEqual(
        expect.arrayContaining([
          "step",
          "classification",
          "scope",
          "af",
          "of",
          "verification_targets",
          "task_graph",
        ]),
      );
      expect(compactCallbackSchema.properties?.questions?.items).toMatchObject({
        type: "object",
        required: ["id", "question"],
      });
      expectNoSchemaRefs(compactCallbackSchema);
      expect(compact).not.toHaveProperty("schema_version");
      expect(compact).not.toHaveProperty("kind");
      expect(compact).not.toHaveProperty("schema_id");
      expect(compact).not.toHaveProperty("input_schema");
      expect(compact).not.toHaveProperty("slug");
      expect(compact).not.toHaveProperty("flow_id");
      expect(compact).not.toHaveProperty("flow_version");
      expect(compact).not.toHaveProperty("state");
      expect(compact).not.toHaveProperty("summary");
      expect(compact).not.toHaveProperty("quest_id");
      expect(compact).not.toHaveProperty("context");
      expect(compact).not.toHaveProperty("docs");
      expect(compact).not.toHaveProperty("allowed_transitions");
      expect(compact).not.toHaveProperty("requirements");
      expect(compact).not.toHaveProperty("note");
      expect(((compact.commands as any).next as any).args).toContain("next");
      expect((compact.commands as any).next).not.toHaveProperty("display");

      const unknownField = runLoopo(
        fixture.repo,
        [
          "quest",
          "next",
          "--slug",
          slug,
          "--cwd",
          fixture.repo,
          "--json",
          "@-",
        ],
        {
          step: "plan",
          classification: "general",
          scope: "calculator",
          af: {},
          of: {},
          verification_targets: [],
          task_graph: { tasks: [] },
          extra: true,
        },
        fixture.env,
      );
      expect(unknownField.status).toBe(1);
      expect(String(parseJson(unknownField.stdout).error)).toContain(
        "schema validation",
      );

      const blockedProc = runLoopo(
        fixture.repo,
        [
          "quest",
          "next",
          "--slug",
          slug,
          "--cwd",
          fixture.repo,
          "--json",
          "@-",
        ],
        {
          step: "plan",
          classification: "greenfield_app",
          scope: "calculator",
          high_impact_unknowns: ["target user"],
          af: {},
          of: {},
          verification_targets: [],
          task_graph: { tasks: [] },
        },
        fixture.env,
      );
      expect(blockedProc.status).toBe(1);
      const blocked = parseJson(blockedProc.stdout);
      expectValidSchema(blocked, "error-output");
      expect(blocked.kind).toBe("error");
      expect(String(blocked.error)).toContain("high-impact");

      const vagueInit = runLoopo(
        fixture.repo,
        [
          "init",
          "loopo: create a fullstack app",
          "--cwd",
          fixture.repo,
          "--runtime",
          "codex",
        ],
        undefined,
        fixture.env,
      );
      expect(vagueInit.status, vagueInit.stderr || vagueInit.stdout).toBe(0);
      const vagueRoute = parseJson(vagueInit.stdout);
      const vagueSlug = String(vagueRoute.new_quest.suggested_slug);
      const vagueCreated = next(fixture, vagueSlug, {
        step: "select_quest",
        action: "create_quest",
        slug: vagueSlug,
        request: "loopo: create a fullstack app",
      });
      expectValidSchema(vagueCreated, "step-output");
      expect(vagueCreated.step).toBe("plan");

      const vagueBlockedProc = runLoopo(
        fixture.repo,
        [
          "quest",
          "next",
          "--slug",
          vagueSlug,
          "--cwd",
          fixture.repo,
          "--json",
          "@-",
        ],
        {
          step: "plan",
          classification: "greenfield_app",
          scope: "Fullstack Todo App with React and Express",
          summary: "Implement a React and Express todo app",
          af: {},
          of: {},
          verification_targets: ["todo CRUD works"],
          task_graph: {
            tasks: [
              {
                id: "T001",
                title: "Implement todo app",
                type: "coding",
                acceptance: ["todo app works"],
              },
            ],
          },
        },
        fixture.env,
      );
      expect(vagueBlockedProc.status).toBe(1);
      const vagueBlocked = parseJson(vagueBlockedProc.stdout);
      expectValidSchema(vagueBlocked, "error-output");
      expect(vagueBlocked.kind).toBe("error");
      expect(String(vagueBlocked.error)).toContain("clarification round");

      const serialInit = runLoopo(
        fixture.repo,
        [
          "init",
          "loopo: build a task tracker",
          "--cwd",
          fixture.repo,
          "--runtime",
          "codex",
        ],
        undefined,
        fixture.env,
      );
      expect(serialInit.status, serialInit.stderr || serialInit.stdout).toBe(0);
      const serialRoute = parseJson(serialInit.stdout);
      const serialSlug = String(serialRoute.new_quest.suggested_slug);
      const serialCreated = next(fixture, serialSlug, {
        step: "select_quest",
        action: "create_quest",
        slug: serialSlug,
        request: "loopo: build a task tracker",
      });
      expectValidSchema(serialCreated, "step-output");
      expect(serialCreated.step).toBe("plan");

      const serialPlanned = next(fixture, serialSlug, {
        step: "plan",
        classification: "greenfield_app",
        scope: "task tracker",
        defaulted_unknowns: ["local single-user scope"],
        af: { hidden_assumptions: ["one serial chain is enough"] },
        of: { procedure: ["scaffold", "implement"] },
        verification_targets: ["dependent tasks dispatch in order"],
        task_graph: {
          tasks: [
            {
              id: "scaffold_and_auth",
              title: "Scaffold and auth",
              type: "coding",
              acceptance: ["scaffold exists"],
            },
            {
              id: "implement_dashboard",
              title: "Implement dashboard",
              depends_on: ["scaffold_and_auth"],
              type: "coding",
              acceptance: ["dashboard works"],
            },
          ],
        },
      });
      expectValidSchema(serialPlanned, "step-output");
      expect(serialPlanned.step).toBe("task_graph");

      const serialExecuting = next(fixture, serialSlug, {
        step: "task_graph",
        approved: true,
      });
      expectValidSchema(serialExecuting, "child-dispatch-output");
      expect(
        (serialExecuting.children as any[]).map((child) => child.task_id),
      ).toEqual(["scaffold-and-auth"]);

      const serialNext = next(fixture, serialSlug, {
        step: "child_result",
        task_id: "scaffold-and-auth",
        child_slug: `${serialSlug}-scaffold-and-auth`,
        status: "passed",
        evidence: [{ type: "summary", ref: "scaffold.txt" }],
        merge_commit: "serial123",
      });
      expectValidSchema(serialNext, "child-dispatch-output");
      expect((serialNext.children as any[]).map((child) => child.task_id)).toEqual(
        ["implement-dashboard"],
      );

      const planned = next(fixture, slug, {
        step: "plan",
        classification: "greenfield_app",
        scope: "calculator",
        high_impact_unknowns: ["target user"],
        defaulted_unknowns: ["standard end-user calculator"],
        af: { hidden_assumptions: ["static HTML is acceptable"] },
        of: { procedure: ["build", "verify"] },
        verification_targets: ["calculator arithmetic works"],
        task_graph: {
          tasks: [
            {
              id: "T001",
              title: "Build calculator",
              type: "coding",
              acceptance: ["calculator works"],
              scope_files: ["index.html"],
              spec_refs: ["coding"],
              context_refs: ["README.md"],
              concurrency_group: "ui",
            },
          ],
        },
      });
      expectValidSchema(planned, "step-output");
      expect(planned.step).toBe("task_graph");

      const executing = next(fixture, slug, {
        step: "task_graph",
        approved: true,
      });
      expectValidSchema(executing, "child-dispatch-output");
      expect(executing.step).toBe("executing");
      expect(executing.state).toBe("task_graph_ready");
      expect((executing.children as any[])[0].child_slug).toBe(`${slug}-t001`);

      const validating = next(fixture, slug, {
        step: "child_result",
        task_id: "T001",
        child_slug: `${slug}-t001`,
        status: "passed",
        evidence: [{ type: "summary", ref: "index.html" }],
        merge_commit: "abc123",
      });
      expectValidSchema(validating, "step-output");
      expect(validating.step).toBe("validation");
      expect(
        readFileSync(
          join(fixture.repo, ".loopo", "quests", slug, "tasks.yaml"),
          "utf8",
        ),
      ).toContain("quest_id:");

      const invalidValidation = runLoopo(
        fixture.repo,
        [
          "quest",
          "next",
          "--slug",
          slug,
          "--cwd",
          fixture.repo,
          "--json",
          "@-",
        ],
        {
          step: "validation",
          status: "passed",
        },
        fixture.env,
      );
      expect(invalidValidation.status).toBe(1);
      expect(parseJson(invalidValidation.stdout).error).toContain(
        "schema validation",
      );

      const verified = next(fixture, slug, {
        step: "validation",
        status: "passed",
        checks: [{ name: "smoke", status: "passed" }],
      });
      expectValidSchema(verified, "step-output");
      expect(verified.step).toBe("verification");

      const systemUpdate = next(fixture, slug, {
        step: "verification",
        status: "passed",
        acceptance_trace: [
          { acceptance: "calculator works", status: "passed" },
        ],
        risks: [],
      });
      expectValidSchema(systemUpdate, "step-output");
      expect(systemUpdate.step).toBe("system_update");

      const compactSystemUpdate = compactCurrent(fixture, slug);
      expectValidSchema(compactSystemUpdate, "step-output");
      expect((compactSystemUpdate.step as any).id).toBe("system_update");
      const systemUpdateSchema = compactSystemUpdate.callback_schema as Record<
        string,
        any
      >;
      expect(systemUpdateSchema).toMatchObject({
        $id: "https://loopo.dev/schemas/steps/system-update-input.v3.json",
      });
      expect(systemUpdateSchema.properties?.system_update).toMatchObject({
        $id: "https://loopo.dev/schemas/system-update.v1.json",
        required: ["schema_version", "updates"],
      });
      expectNoSchemaRefs(systemUpdateSchema);

      const invalidSystemUpdate = runLoopo(
        fixture.repo,
        [
          "quest",
          "next",
          "--slug",
          slug,
          "--cwd",
          fixture.repo,
          "--json",
          "@-",
        ],
        {
          step: "system_update",
          system_update: {
            updates: [{ doc_id: "architecture", summary: "calculator built" }],
          },
        },
        fixture.env,
      );
      expect(invalidSystemUpdate.status).toBe(1);
      expect(parseJson(invalidSystemUpdate.stdout).error).toContain(
        "schema validation",
      );

      const landing = next(fixture, slug, {
        step: "system_update",
        system_update: {
          schema_version: 1,
          updates: [{ doc_id: "architecture", summary: "calculator built" }],
        },
      });
      expectValidSchema(landing, "step-output");
      expect(landing.step).toBe("landing");

      mkdirSync(join(fixture.repo, "worktrees"), { recursive: true });
      writeFileSync(
        join(fixture.repo, "worktrees", "leaked.txt"),
        "should not be tracked\n",
        "utf8",
      );
      runGit(fixture.repo, ["add", "worktrees/leaked.txt"]);
      const leakedLanding = runLoopo(
        fixture.repo,
        [
          "quest",
          "next",
          "--slug",
          slug,
          "--cwd",
          fixture.repo,
          "--json",
          "@-",
        ],
        {
          step: "landing",
          status: "landed",
          summary: "done",
        },
        fixture.env,
      );
      expect(leakedLanding.status).toBe(1);
      expect(parseJson(leakedLanding.stdout).error).toContain(
        "tracked files remain under worktrees/",
      );
      runGit(fixture.repo, ["reset", "HEAD", "--", "worktrees/leaked.txt"]);
      rmSync(join(fixture.repo, "worktrees"), { recursive: true, force: true });

      const archived = next(fixture, slug, {
        step: "landing",
        status: "landed",
        summary: "done",
      });
      expectValidSchema(archived, "archive-output");
      expect(archived.step).toBe("archived");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("covers detours, partial child dispatch, and retry transitions", () => {
    const fixture = createFixture("loopo-v3-lifecycle-");
    try {
      const init = runLoopo(
        fixture.repo,
        [
          "init",
          "loopo: build lifecycle tester",
          "--cwd",
          fixture.repo,
          "--runtime",
          "codex",
        ],
        undefined,
        fixture.env,
      );
      expect(init.status, init.stderr || init.stdout).toBe(0);
      const route = parseJson(init.stdout);
      const slug = String(route.new_quest.suggested_slug);

      const created = next(fixture, slug, {
        step: "select_quest",
        action: "create_quest",
        slug,
        request: "loopo: build lifecycle tester",
      });
      expectValidSchema(created, "step-output");
      expect(created.step).toBe("plan");

      const awaitingAnswers = next(fixture, slug, {
        step: "plan",
        classification: "greenfield_app",
        scope: "lifecycle tester",
        high_impact_unknowns: ["target workflow"],
        questions: [
          {
            id: "target_workflow",
            question: "Which workflow should the tester cover?",
            impact: "Determines acceptance scope",
          },
        ],
        af: { hidden_assumptions: ["workflow is currently unspecified"] },
        of: { procedure: ["ask before decomposing"] },
        verification_targets: ["selected workflow is covered"],
        task_graph: { tasks: [] },
      });
      expectValidSchema(awaitingAnswers, "step-output");
      expect(awaitingAnswers.step).toBe("questions");
      expect(awaitingAnswers.state).toBe("awaiting_user_answers");
      expect((awaitingAnswers.context as any).step.instructions).toContain(
        "Do not auto-answer unresolved",
      );
      expect((awaitingAnswers.context as any).step.instructions).toContain(
        "human-provided answers",
      );

      const backToPlanning = next(fixture, slug, {
        step: "questions",
        answers: [
          {
            question_id: "target_workflow",
            answer: "Cover root and child lifecycle transitions.",
          },
        ],
      });
      expectValidSchema(backToPlanning, "step-output");
      expect(backToPlanning.step).toBe("plan");
      expect(backToPlanning.state).toBe("planning");

      const reviewed = next(fixture, slug, {
        step: "plan",
        classification: "greenfield_app",
        scope: "lifecycle tester",
        defaulted_unknowns: ["CLI-only verification"],
        af: { hidden_assumptions: ["two independent child tasks are enough"] },
        of: { procedure: ["plan", "dispatch", "verify"] },
        verification_targets: ["both child lifecycle tasks pass"],
        task_graph: {
          tasks: [
            {
              id: "T001",
              title: "Build root lifecycle fixture",
              type: "coding",
              acceptance: ["root lifecycle fixture works"],
              scope_files: ["root-fixture.txt"],
              spec_refs: ["coding"],
              concurrency_group: "root",
            },
            {
              id: "T002",
              title: "Build child lifecycle fixture",
              type: "coding",
              acceptance: ["child lifecycle fixture works"],
              scope_files: ["child-fixture.txt"],
              spec_refs: ["coding"],
              concurrency_group: "child",
            },
          ],
        },
      });
      expectValidSchema(reviewed, "step-output");
      expect(reviewed.step).toBe("task_graph");

      const rejected = next(fixture, slug, {
        step: "task_graph",
        approved: false,
        replan_reason: "tighten acceptance before dispatch",
      });
      expectValidSchema(rejected, "step-output");
      expect(rejected.step).toBe("plan");
      expect(rejected.state).toBe("planning");

      const planned = next(fixture, slug, {
        step: "plan",
        classification: "greenfield_app",
        scope: "lifecycle tester",
        defaulted_unknowns: ["CLI-only verification"],
        af: { hidden_assumptions: ["fixtures can be text files"] },
        of: { procedure: ["dispatch independent tasks", "verify retries"] },
        verification_targets: ["both fixtures are represented in evidence"],
        task_graph: {
          tasks: [
            {
              id: "T001",
              title: "Build root lifecycle fixture",
              type: "coding",
              acceptance: ["root lifecycle fixture works"],
              scope_files: ["root-fixture.txt"],
              spec_refs: ["coding"],
              concurrency_group: "root",
            },
            {
              id: "T002",
              title: "Build child lifecycle fixture",
              type: "coding",
              acceptance: ["child lifecycle fixture works"],
              scope_files: ["child-fixture.txt"],
              spec_refs: ["coding"],
              concurrency_group: "child",
            },
          ],
        },
      });
      expectValidSchema(planned, "step-output");
      expect(planned.step).toBe("task_graph");

      const executing = next(fixture, slug, {
        step: "task_graph",
        approved: true,
      });
      expectValidSchema(executing, "child-dispatch-output");
      expect(
        (executing.children as any[]).map((child) => child.task_id),
      ).toEqual(["t001", "t002"]);

      const partial = next(fixture, slug, {
        step: "child_result",
        task_id: "t001",
        child_slug: `${slug}-t001`,
        status: "passed",
        evidence: [{ type: "summary", ref: "root-fixture.txt" }],
        merge_commit: "partial123",
      });
      expectValidSchema(partial, "child-dispatch-output");
      expect(partial.step).toBe("executing");
      expect((partial.children as any[]).map((child) => child.task_id)).toEqual(
        ["t002"],
      );

      const validating = next(fixture, slug, {
        step: "child_result",
        task_id: "t002",
        child_slug: `${slug}-t002`,
        status: "passed",
        evidence: [{ type: "summary", ref: "child-fixture.txt" }],
        merge_commit: "valid123",
      });
      expectValidSchema(validating, "step-output");
      expect(validating.step).toBe("validation");

      const verification = next(fixture, slug, {
        step: "validation",
        status: "passed",
        checks: [{ name: "lifecycle", status: "passed" }],
      });
      expectValidSchema(verification, "step-output");
      expect(verification.step).toBe("verification");

      const retryValidation = next(fixture, slug, {
        step: "verification",
        status: "failed",
        acceptance_trace: [
          { acceptance: "root lifecycle fixture works", status: "passed" },
          { acceptance: "child lifecycle fixture works", status: "failed" },
        ],
        risks: [{ risk: "child evidence incomplete", severity: "medium" }],
      });
      expectValidSchema(retryValidation, "step-output");
      expect(retryValidation.step).toBe("validation");
      expect(retryValidation.state).toBe("validating");

      const verified = next(fixture, slug, {
        step: "validation",
        status: "passed",
        checks: [{ name: "lifecycle retry", status: "passed" }],
      });
      expectValidSchema(verified, "step-output");
      expect(verified.step).toBe("verification");

      const systemUpdate = next(fixture, slug, {
        step: "verification",
        status: "passed",
        acceptance_trace: [
          { acceptance: "root lifecycle fixture works", status: "passed" },
          { acceptance: "child lifecycle fixture works", status: "passed" },
        ],
        risks: [],
      });
      expectValidSchema(systemUpdate, "step-output");
      expect(systemUpdate.step).toBe("system_update");

      const landing = next(fixture, slug, {
        step: "system_update",
        system_update: {
          schema_version: 1,
          updates: [{ doc_id: "architecture", summary: "lifecycle covered" }],
        },
      });
      expectValidSchema(landing, "step-output");
      expect(landing.step).toBe("landing");

      const blocked = next(fixture, slug, {
        step: "landing",
        status: "blocked",
        summary: "waiting for final merge",
      });
      expectValidSchema(blocked, "step-output");
      expect(blocked.step).toBe("landing");
      expect(blocked.state).toBe("landing_ready");

      const archived = next(fixture, slug, {
        step: "landing",
        status: "landed",
        summary: "done",
      });
      expectValidSchema(archived, "archive-output");
      expect(archived.step).toBe("archived");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
