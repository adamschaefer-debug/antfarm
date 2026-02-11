import fs from "node:fs/promises";
import path from "node:path";
import { listCustomWorkflows } from "../workflow-builder.js";
import { resolveBundledWorkflowsDir, resolveCustomWorkflowPath } from "./paths.js";

export type WorkflowSource = "bundled" | "custom";

export interface DiscoveredWorkflow {
  id: string;
  source: WorkflowSource;
  specPath: string;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function listBundledWorkflowIds(): Promise<string[]> {
  const bundledDir = resolveBundledWorkflowsDir();
  try {
    const entries = await fs.readdir(bundledDir, { withFileTypes: true });
    const workflows: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const workflowYml = path.join(bundledDir, entry.name, "workflow.yml");
      if (await pathExists(workflowYml)) {
        workflows.push(entry.name);
      }
    }

    return workflows.sort();
  } catch {
    return [];
  }
}

export async function discoverWorkflows(): Promise<DiscoveredWorkflow[]> {
  const [bundledIds, customIds] = await Promise.all([listBundledWorkflowIds(), listCustomWorkflows()]);

  const discovered: DiscoveredWorkflow[] = [
    ...bundledIds.map((id) => ({
      id,
      source: "bundled" as const,
      specPath: path.join(resolveBundledWorkflowsDir(), id, "workflow.yml"),
    })),
    ...customIds.map((id) => ({
      id,
      source: "custom" as const,
      specPath: resolveCustomWorkflowPath(id),
    })),
  ];

  const sourceOrder: Record<WorkflowSource, number> = { bundled: 0, custom: 1 };
  discovered.sort((a, b) => {
    const idCompare = a.id.localeCompare(b.id);
    if (idCompare !== 0) {
      return idCompare;
    }
    return sourceOrder[a.source] - sourceOrder[b.source];
  });

  return discovered;
}
