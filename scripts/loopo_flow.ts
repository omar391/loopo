#!/usr/bin/env bun

import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { readText } from "./loopo_utils.ts";
import {
  FLOW_SCHEMA_ID,
  STEP_DEFINITION_SCHEMA_ID,
  v3SchemaPath,
  validateSchemaId,
} from "./loopo_schema.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_FLOW_ID = "swe";
export const DEFAULT_FLOW_VERSION = 1;

export type LoopoStepDefinition = {
  schema_version: 1;
  id: string;
  handler: string;
  input_step: string | null;
  input_schema: string | null;
  output_schema: string;
  summary: string;
  instructions: string;
};

export type LoopoFlowStage = {
  id: string;
  step: string;
  transitions: Record<string, string>;
};

export type LoopoSubflowDefinition = {
  id: string;
  type: "in_flow_detour" | "spawned_quest";
  starts_at: string;
  returns_to: string;
  trigger: string;
  result_step?: string;
  flow_id?: string;
};

export type LoopoFlowDefinition = {
  schema_version: 1;
  id: string;
  version: number;
  default_stage: string;
  stages: LoopoFlowStage[];
  subflows: LoopoSubflowDefinition[];
};

export type LoadedLoopoFlow = LoopoFlowDefinition & {
  stages_by_id: Record<string, LoopoFlowStage>;
  steps_by_id: Record<string, LoopoStepDefinition>;
};

function fail(message: string): never {
  throw new Error(message);
}

function readYamlObject(path: string): Record<string, any> {
  const parsed = parseYaml(readText(path));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`YAML document must be an object: ${path}`);
  }
  return parsed as Record<string, any>;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${path} must be a non-empty string`);
  }
  return value;
}

function assertKnownStepSchema(name: string | null, owner: string): void {
  if (name === null) return;
  if (typeof name !== "string" || !name.trim()) {
    fail(`${owner} schema ref must be a non-empty string or null`);
  }
  if (!existsSync(v3SchemaPath(name))) {
    fail(`${owner} references missing step schema: ${name}`);
  }
}

function assertSchemaValid(
  raw: Record<string, any>,
  path: string,
  schemaId: string,
  label: string,
): void {
  const errors = validateSchemaId(raw, schemaId);
  if (errors.length) {
    fail(`${path} ${label} schema validation failed: ${errors.join("; ")}`);
  }
}

function hasTransitionPath(
  stagesById: Record<string, LoopoFlowStage>,
  startsAt: string,
  returnsTo: string,
): boolean {
  const visited = new Set<string>();
  const queue = [startsAt];
  while (queue.length) {
    const current = queue.shift() as string;
    if (current === returnsTo) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const target of Object.values(
      stagesById[current]?.transitions ?? {},
    )) {
      if (!visited.has(target)) queue.push(target);
    }
  }
  return false;
}

function assertKnownFlowRef(
  flowId: string,
  owner: string,
  currentFlowId: string,
  currentFlowPath: string,
): void {
  if (flowId === currentFlowId) return;
  const siblingFlow = resolve(dirname(currentFlowPath), `${flowId}.yaml`);
  const bundledFlow = resolve(ROOT, "assets", "flows", `${flowId}.yaml`);
  if (!existsSync(siblingFlow) && !existsSync(bundledFlow)) {
    fail(`${owner}.flow_id references missing flow: ${flowId}`);
  }
}

export function loadStepDefinitions(
  dir = resolve(ROOT, "assets", "steps"),
): Record<string, LoopoStepDefinition> {
  if (!existsSync(dir)) fail(`missing steps directory: ${dir}`);
  const steps: Record<string, LoopoStepDefinition> = {};
  for (const name of readdirSync(dir).filter((entry) =>
    entry.endsWith(".yaml"),
  )) {
    const path = resolve(dir, name);
    const raw = readYamlObject(path);
    assertSchemaValid(raw, path, STEP_DEFINITION_SCHEMA_ID, "step definition");
    if (raw.schema_version !== 1) fail(`${path} schema_version must be 1`);
    for (const key of [
      "id",
      "handler",
      "output_schema",
      "summary",
      "instructions",
    ]) {
      if (typeof raw[key] !== "string" || !raw[key].trim()) {
        fail(`${path} ${key} must be a non-empty string`);
      }
    }
    const id = raw.id as string;
    if (steps[id]) fail(`duplicate step definition id: ${id}`);
    const inputStep =
      raw.input_step == null ? null : String(raw.input_step).trim();
    const inputSchema =
      raw.input_schema == null ? null : String(raw.input_schema).trim();
    const outputSchema = String(raw.output_schema);
    assertKnownStepSchema(inputSchema, path);
    assertKnownStepSchema(outputSchema, path);
    steps[id] = {
      schema_version: 1,
      id,
      handler: raw.handler,
      input_step: inputStep || null,
      input_schema: inputSchema || null,
      output_schema: outputSchema,
      summary: raw.summary,
      instructions: raw.instructions,
    };
  }
  return steps;
}

export function loadFlowDefinition(flowId = DEFAULT_FLOW_ID): LoadedLoopoFlow {
  const path = resolve(ROOT, "assets", "flows", `${flowId}.yaml`);
  if (!existsSync(path)) fail(`unknown flow: ${flowId}`);
  return loadFlowDefinitionFromPath(path, flowId);
}

export function loadFlowDefinitionFromPath(
  path: string,
  expectedFlowId?: string,
  stepsById = loadStepDefinitions(),
): LoadedLoopoFlow {
  const raw = readYamlObject(path);
  assertSchemaValid(raw, path, FLOW_SCHEMA_ID, "flow");
  if (raw.schema_version !== 1) fail(`${path} schema_version must be 1`);
  if (expectedFlowId && raw.id !== expectedFlowId) {
    fail(`${path} id must match requested flow ${expectedFlowId}`);
  }
  if (!Number.isInteger(raw.version) || raw.version <= 0) {
    fail(`${path} version must be a positive integer`);
  }
  if (typeof raw.default_stage !== "string" || !raw.default_stage.trim()) {
    fail(`${path} default_stage must be a non-empty string`);
  }
  if (!Array.isArray(raw.stages) || raw.stages.length === 0) {
    fail(`${path} stages must be a non-empty array`);
  }

  const stages: LoopoFlowStage[] = raw.stages.map(
    (stage: Record<string, any>, index: number) => {
      if (!stage || typeof stage !== "object" || Array.isArray(stage)) {
        fail(`${path}.stages[${index}] must be an object`);
      }
      if (typeof stage.id !== "string" || !stage.id.trim()) {
        fail(`${path}.stages[${index}].id must be a non-empty string`);
      }
      if (typeof stage.step !== "string" || !stage.step.trim()) {
        fail(`${path}.stages[${index}].step must be a non-empty string`);
      }
      if (!stepsById[stage.step]) {
        fail(`${path}.stages[${index}] references missing step ${stage.step}`);
      }
      const transitions =
        stage.transitions &&
        typeof stage.transitions === "object" &&
        !Array.isArray(stage.transitions)
          ? (stage.transitions as Record<string, unknown>)
          : {};
      return {
        id: stage.id,
        step: stage.step,
        transitions: Object.fromEntries(
          Object.entries(transitions).map(([key, value]) => {
            if (typeof value !== "string" || !value.trim()) {
              fail(`${path}.stages[${index}].transitions.${key} is invalid`);
            }
            return [key, value];
          }),
        ),
      };
    },
  );

  const stagesById: Record<string, LoopoFlowStage> = {};
  for (const stage of stages) {
    if (stagesById[stage.id]) fail(`duplicate flow stage id: ${stage.id}`);
    stagesById[stage.id] = stage;
  }
  if (!stagesById[raw.default_stage]) {
    fail(`${path} default_stage is not in stages: ${raw.default_stage}`);
  }
  for (const stage of stages) {
    for (const [name, target] of Object.entries(stage.transitions)) {
      if (!stagesById[target]) {
        fail(`${stage.id} transition ${name} targets missing stage ${target}`);
      }
    }
  }

  const subflowIds = new Set<string>();
  const subflows: LoopoSubflowDefinition[] = raw.subflows.map(
    (subflow: Record<string, any>, index: number) => {
      const prefix = `${path}.subflows[${index}]`;
      if (!subflow || typeof subflow !== "object" || Array.isArray(subflow)) {
        fail(`${prefix} must be an object`);
      }
      const id = stringValue(subflow.id, `${prefix}.id`);
      if (subflowIds.has(id)) fail(`duplicate flow subflow id: ${id}`);
      subflowIds.add(id);
      const type = stringValue(subflow.type, `${prefix}.type`);
      if (!["in_flow_detour", "spawned_quest"].includes(type)) {
        fail(`${prefix}.type is invalid`);
      }
      const startsAt = stringValue(subflow.starts_at, `${prefix}.starts_at`);
      const returnsTo = stringValue(subflow.returns_to, `${prefix}.returns_to`);
      if (!stagesById[startsAt]) {
        fail(`${prefix}.starts_at targets missing stage ${startsAt}`);
      }
      if (!stagesById[returnsTo]) {
        fail(`${prefix}.returns_to targets missing stage ${returnsTo}`);
      }
      if (
        type === "in_flow_detour" &&
        !hasTransitionPath(stagesById, startsAt, returnsTo)
      ) {
        fail(
          `${prefix}.returns_to is not reachable from starts_at ${startsAt}`,
        );
      }
      const returnStep = stepsById[stagesById[returnsTo].step];
      const resultStep =
        subflow.result_step == null
          ? undefined
          : stringValue(subflow.result_step, `${prefix}.result_step`);
      const flowId =
        subflow.flow_id == null
          ? undefined
          : stringValue(subflow.flow_id, `${prefix}.flow_id`);
      if (type === "spawned_quest") {
        const expectedResultStep = returnStep.input_step ?? returnStep.id;
        if (resultStep !== expectedResultStep) {
          fail(
            `${prefix}.result_step must match return stage input step ${expectedResultStep}`,
          );
        }
        assertKnownFlowRef(flowId as string, prefix, raw.id, path);
      }
      return {
        id,
        type: type as LoopoSubflowDefinition["type"],
        starts_at: startsAt,
        returns_to: returnsTo,
        trigger: stringValue(subflow.trigger, `${prefix}.trigger`),
        result_step: resultStep,
        flow_id: flowId,
      };
    },
  );

  return {
    schema_version: 1,
    id: raw.id,
    version: raw.version,
    default_stage: raw.default_stage,
    stages,
    subflows,
    stages_by_id: stagesById,
    steps_by_id: stepsById,
  };
}

export function flowStage(
  flow: LoadedLoopoFlow,
  stageId: string | null | undefined,
): LoopoFlowStage {
  const id = stageId?.trim() || flow.default_stage;
  return flow.stages_by_id[id] ?? flow.stages_by_id[flow.default_stage];
}

export function flowStep(
  flow: LoadedLoopoFlow,
  stageId: string | null | undefined,
): LoopoStepDefinition {
  const stage = flowStage(flow, stageId);
  return flow.steps_by_id[stage.step];
}

export function listBundledFlows(): Array<{
  id: string;
  version: number;
  default_stage: string;
  stages: string[];
  subflows: string[];
}> {
  const dir = resolve(ROOT, "assets", "flows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yaml"))
    .map((name) => loadFlowDefinition(name.replace(/\.yaml$/, "")))
    .map((flow) => ({
      id: flow.id,
      version: flow.version,
      default_stage: flow.default_stage,
      stages: flow.stages.map((stage) => stage.id),
      subflows: flow.subflows.map((subflow) => subflow.id),
    }));
}
