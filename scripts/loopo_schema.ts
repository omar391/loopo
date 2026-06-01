#!/usr/bin/env bun

import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import { existsSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./loopo_utils.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export const FLOW_SCHEMA_PATH = "schemas/flow.v1.json";
export const STEP_DEFINITION_SCHEMA_PATH = "schemas/step-definition.v1.json";
export const V3_STEP_SCHEMAS = [
  "init-output",
  "next-input",
  "step-output",
  "error-output",
  "plan-input",
  "questions-input",
  "task-graph-input",
  "child-dispatch-output",
  "child-result-input",
  "validation-input",
  "verification-input",
  "system-update-input",
  "landing-input",
  "archive-output",
  "hook-output",
  "lock-error",
] as const;

export function v3SchemaPath(name: string): string {
  return `schemas/steps/${name}.v3.json`;
}

export function v3SchemaFilePath(name: string): string {
  return resolve(ROOT, v3SchemaPath(name));
}

export function loopoSchemaRef(name: string): Record<string, string> {
  return {
    schema_path: `schemas/${name}.json`,
  };
}

export function v3SchemaRef(name: string): Record<string, string> {
  return {
    schema_path: v3SchemaPath(name),
  };
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function localSchemaFilePath(schemaPath: string): string {
  const path = schemaPath.trim();
  if (!path.endsWith(".json")) {
    throw new Error(`unsupported local schema path: ${schemaPath}`);
  }
  return isAbsolute(path) ? path : resolve(ROOT, path);
}

const cachedSchemaDocuments = new Map<string, JsonObject>();

function readSchemaByPath(schemaPath: string): JsonObject {
  const cached = cachedSchemaDocuments.get(schemaPath);
  if (cached) return cached;
  const path = localSchemaFilePath(schemaPath);
  const schema = readJson(path) as JsonValue;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error(`schema must be an object: ${schemaPath}`);
  }
  cachedSchemaDocuments.set(schemaPath, schema as JsonObject);
  return schema as JsonObject;
}

function resolveSchemaRefPath(refPath: string, currentSchemaPath: string): string {
  const path = refPath.trim();
  if (!path) return currentSchemaPath;
  if (path.startsWith("schemas/")) return path;
  if (isAbsolute(path)) return path;
  return normalize(`${dirname(currentSchemaPath)}/${path}`);
}

function pointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveJsonPointer(schema: JsonObject, fragment: string): JsonValue {
  if (!fragment || fragment === "#") return schema;
  if (!fragment.startsWith("#/")) {
    throw new Error(`unsupported schema fragment: ${fragment}`);
  }
  let cursor: JsonValue = schema;
  for (const rawToken of fragment.slice(2).split("/")) {
    const token = pointerToken(rawToken);
    if (
      !cursor ||
      typeof cursor !== "object" ||
      Array.isArray(cursor) ||
      !(token in cursor)
    ) {
      throw new Error(`schema fragment not found: ${fragment}`);
    }
    cursor = cursor[token];
  }
  return cursor;
}

function dereferenceSchemaValue(
  value: JsonValue,
  currentSchemaPath: string,
  currentSchema: JsonObject,
  seenRefs: Set<string>,
): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) =>
      dereferenceSchemaValue(item, currentSchemaPath, currentSchema, seenRefs),
    );
  }
  if (!value || typeof value !== "object") return value;

  const ref = value.$ref;
  if (typeof ref === "string") {
    const [refSchemaPathRaw, fragmentRaw = ""] = ref.split("#", 2);
    const refSchemaPath = resolveSchemaRefPath(
      refSchemaPathRaw,
      currentSchemaPath,
    );
    const fragment = fragmentRaw ? `#${fragmentRaw}` : "";
    const refKey = `${refSchemaPath}${fragment}`;
    if (seenRefs.has(refKey)) throw new Error(`cyclic schema ref: ${refKey}`);
    const refSchema =
      refSchemaPath === currentSchemaPath
        ? currentSchema
        : readSchemaByPath(refSchemaPath);
    seenRefs.add(refKey);
    const resolved = dereferenceSchemaValue(
      cloneJson(resolveJsonPointer(refSchema, fragment)),
      refSchemaPath,
      refSchema,
      seenRefs,
    );
    seenRefs.delete(refKey);

    const siblings = Object.entries(value).filter(([key]) => key !== "$ref");
    if (!siblings.length) return resolved;
    if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
      return Object.fromEntries(
        siblings.map(([key, item]) => [
          key,
          dereferenceSchemaValue(
            item,
            currentSchemaPath,
            currentSchema,
            seenRefs,
          ),
        ]),
      );
    }
    return {
      ...resolved,
      ...Object.fromEntries(
        siblings.map(([key, item]) => [
          key,
          dereferenceSchemaValue(
            item,
            currentSchemaPath,
            currentSchema,
            seenRefs,
          ),
        ]),
      ),
    };
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      dereferenceSchemaValue(item, currentSchemaPath, currentSchema, seenRefs),
    ]),
  );
}

export function dereferencedV3Schema(name: string): Record<string, unknown> {
  const schemaPath = v3SchemaPath(name);
  const schema = readSchemaByPath(schemaPath);
  return dereferenceSchemaValue(
    cloneJson(schema),
    schemaPath,
    schema,
    new Set<string>(),
  ) as Record<string, unknown>;
}

let cachedAjv: Ajv2020 | null = null;

function schemaFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => resolve(dir, name));
}

function buildAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  for (const file of [
    ...schemaFiles(resolve(ROOT, "schemas")),
    ...schemaFiles(resolve(ROOT, "schemas", "steps")),
  ]) {
    const schema = readJson(file);
    if (!schema) continue;
    ajv.addSchema(schema);
  }
  return ajv;
}

function ajv(): Ajv2020 {
  cachedAjv ??= buildAjv();
  return cachedAjv;
}

function errorPath(error: ErrorObject): string {
  if (error.instancePath) return error.instancePath;
  if (error.params && "missingProperty" in error.params) {
    return `/${String(error.params.missingProperty)}`;
  }
  if (error.params && "additionalProperty" in error.params) {
    return `/${String(error.params.additionalProperty)}`;
  }
  return "$";
}

function formatError(error: ErrorObject): string {
  const path = errorPath(error);
  const message = error.message ?? "is invalid";
  if (error.keyword === "additionalProperties") {
    return `${path} is not allowed`;
  }
  return `${path} ${message}`;
}

export function validateV3Input(
  payload: Record<string, any>,
  schemaName: string,
): string[] {
  const validate = ajv().getSchema(v3SchemaPath(schemaName));
  if (!validate) return [`input schema not found: ${schemaName}`];
  if (validate(payload)) return [];
  return (validate.errors ?? []).map(formatError);
}

export function validateSchemaPath(
  payload: Record<string, any>,
  schemaPath: string,
): string[] {
  const validate = ajv().getSchema(schemaPath);
  if (!validate) return [`input schema not found: ${schemaPath}`];
  if (validate(payload)) return [];
  return (validate.errors ?? []).map(formatError);
}
