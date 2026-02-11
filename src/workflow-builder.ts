import fs from "node:fs/promises";
import YAML from "yaml";
import type { WorkflowSpec } from "./installer/types.js";
import { resolveCustomWorkflowPath, resolveCustomWorkflowsDir } from "./installer/paths.js";
import { validateWorkflowSpecDocument } from "./installer/workflow-spec.js";

function normalizeWorkflowId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) {
    throw new Error("workflow id is required");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(trimmed)) {
    throw new Error(`invalid workflow id: ${id}`);
  }
  return trimmed;
}

function workflowPath(id: string): string {
  return resolveCustomWorkflowPath(normalizeWorkflowId(id));
}

export async function listCustomWorkflows(): Promise<string[]> {
  const dir = resolveCustomWorkflowsDir();
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")))
      .map((entry) => entry.name.replace(/\.ya?ml$/i, ""))
      .sort();
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function getCustomWorkflow(id: string): Promise<WorkflowSpec | null> {
  const file = workflowPath(id);
  try {
    const raw = await fs.readFile(file, "utf-8");
    return YAML.parse(raw) as WorkflowSpec;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function validateWorkflowSpec(spec: WorkflowSpec): { valid: boolean; errors: string[] } {
  try {
    validateWorkflowSpecDocument(spec, "custom workflow spec");
    return { valid: true, errors: [] };
  } catch (error: any) {
    return { valid: false, errors: [error?.message ?? String(error)] };
  }
}

export async function saveCustomWorkflow(spec: WorkflowSpec): Promise<{ valid: boolean; errors: string[] }> {
  const validation = validateWorkflowSpec(spec);
  if (!validation.valid) {
    return validation;
  }

  const id = normalizeWorkflowId(spec.id);
  const dir = resolveCustomWorkflowsDir();
  await fs.mkdir(dir, { recursive: true });
  const outputPath = workflowPath(id);
  const yaml = YAML.stringify(spec);
  await fs.writeFile(outputPath, yaml, "utf-8");
  return validation;
}

export async function deleteCustomWorkflow(id: string): Promise<boolean> {
  const file = workflowPath(id);
  try {
    await fs.unlink(file);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
