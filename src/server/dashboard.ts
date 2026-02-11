import http from "node:http";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../db.js";
import { resolveCustomWorkflowPath } from "../installer/paths.js";
import { runWorkflow } from "../installer/run.js";
import { installWorkflow } from "../installer/install.js";
import { listAvailableWorkflows, resolveWorkflowReference } from "../installer/workflow-fetch.js";
import { getItems, createItem, updateItem, deleteItem, reorderItem } from "../backlog.js";
import {
  deleteCustomWorkflow,
  getCustomWorkflow,
  listCustomWorkflows,
  saveCustomWorkflow,
  validateWorkflowSpec,
} from "../workflow-builder.js";
import YAML from "yaml";

import type { RunInfo, StepInfo } from "../installer/status.js";
import type { WorkflowSpec } from "../installer/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface WorkflowDef {
  id: string;
  name: string;
  steps: Array<{ id: string; agent: string }>;
}

interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

async function loadWorkflows(): Promise<WorkflowDef[]> {
  const discovered = await listAvailableWorkflows();
  const results: WorkflowDef[] = [];
  const seenIds = new Set<string>();

  for (const workflow of discovered) {
    try {
      const parsed = YAML.parse(await fsPromises.readFile(workflow.specPath, "utf-8"));
      const id = parsed.id ?? workflow.id;
      // Prefer first discovered source when ids collide (bundled before custom).
      if (seenIds.has(id)) {
        continue;
      }
      seenIds.add(id);
      results.push({
        id,
        name: parsed.name ?? id,
        steps: (parsed.steps ?? []).map((s: any) => ({ id: s.id, agent: s.agent })),
      });
    } catch {
      // Skip unreadable/invalid specs so one bad file doesn't break dashboard APIs.
    }
  }

  return results;
}

function getRuns(workflowId?: string): Array<RunInfo & { steps: StepInfo[] }> {
  const db = getDb();
  const runs = workflowId
    ? (db.prepare("SELECT * FROM runs WHERE workflow_id = ? ORDER BY created_at DESC").all(workflowId) as RunInfo[])
    : (db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all() as RunInfo[]);
  return runs.map((r) => {
    const steps = db.prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY step_index ASC").all(r.id) as StepInfo[];
    return { ...r, steps };
  });
}

function getRunById(id: string): (RunInfo & { steps: StepInfo[] }) | null {
  const db = getDb();
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunInfo | undefined;
  if (!run) return null;
  const steps = db.prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY step_index ASC").all(run.id) as StepInfo[];
  return { ...run, steps };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const raw = await readBody(req);
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw);
}

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function jsonError(res: http.ServerResponse, status: number, code: string, message: string, details?: unknown) {
  const payload: ApiErrorBody = { error: { code, message } };
  if (details !== undefined) {
    payload.error.details = details;
  }
  return json(res, payload, status);
}

function extractWorkflowSpec(body: any): WorkflowSpec {
  if (body && typeof body === "object" && body.spec && typeof body.spec === "object") {
    return body.spec as WorkflowSpec;
  }
  return body as WorkflowSpec;
}

async function getWorkflowMetadata(id: string) {
  const workflowPath = resolveCustomWorkflowPath(id);
  const stat = await fsPromises.stat(workflowPath);
  return {
    id,
    path: workflowPath,
    updatedAt: stat.mtime.toISOString(),
    sizeBytes: stat.size,
  };
}

function serveHTML(res: http.ServerResponse) {
  const htmlPath = path.join(__dirname, "index.html");
  // In dist, index.html won't exist—serve from src
  const srcHtmlPath = path.resolve(__dirname, "..", "..", "src", "server", "index.html");
  const filePath = fs.existsSync(htmlPath) ? htmlPath : srcHtmlPath;
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(fs.readFileSync(filePath, "utf-8"));
}

export function startDashboard(port = 3333): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const p = url.pathname;
    const method = req.method ?? "GET";

    // CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      return res.end();
    }

    // --- API ---
    try {
      // --- Custom Workflows API ---
      if (p === "/api/custom-workflows" && method === "GET") {
        const workflowIds = await listCustomWorkflows();
        const workflows = await Promise.all(
          workflowIds.map(async (id) => {
            const workflow = await getCustomWorkflow(id);
            const metadata = await getWorkflowMetadata(id);
            return {
              id,
              name: workflow?.name ?? id,
              metadata,
            };
          })
        );
        return json(res, workflows);
      }

      if (p === "/api/custom-workflows/validate" && method === "POST") {
        const body = await readJsonBody(req);
        const spec = extractWorkflowSpec(body);
        const validation = validateWorkflowSpec(spec);
        if (!validation.valid) {
          return jsonError(res, 400, "invalid_workflow_spec", "Workflow spec validation failed", {
            errors: validation.errors,
          });
        }
        return json(res, { valid: true, errors: [] });
      }

      if (p === "/api/custom-workflows" && method === "POST") {
        const body = await readJsonBody(req);
        const overwrite = body.overwrite === true;
        const spec = extractWorkflowSpec(body);

        const validation = validateWorkflowSpec(spec);
        if (!validation.valid) {
          return jsonError(res, 400, "invalid_workflow_spec", "Workflow spec validation failed", {
            errors: validation.errors,
          });
        }

        const existing = await getCustomWorkflow(spec.id);
        if (existing && !overwrite) {
          return jsonError(
            res,
            409,
            "workflow_exists",
            `Workflow \"${spec.id}\" already exists. Set overwrite=true to replace it.`
          );
        }

        await saveCustomWorkflow(spec);
        const persisted = await getCustomWorkflow(spec.id);
        const metadata = await getWorkflowMetadata(spec.id);
        return json(res, { id: spec.id, metadata, workflow: persisted }, existing ? 200 : 201);
      }

      const customWorkflowMatch = p.match(/^\/api\/custom-workflows\/([^/]+)$/);
      if (customWorkflowMatch && method === "GET") {
        const id = customWorkflowMatch[1];
        const workflow = await getCustomWorkflow(id);
        if (!workflow) {
          return jsonError(res, 404, "workflow_not_found", `Workflow \"${id}\" not found`);
        }
        const metadata = await getWorkflowMetadata(id);
        return json(res, { id, metadata, workflow });
      }

      if (customWorkflowMatch && method === "PATCH") {
        const id = customWorkflowMatch[1];
        const existing = await getCustomWorkflow(id);
        if (!existing) {
          return jsonError(res, 404, "workflow_not_found", `Workflow \"${id}\" not found`);
        }

        const body = await readJsonBody(req);
        const spec = extractWorkflowSpec(body);
        if (spec?.id && String(spec.id).trim().toLowerCase() !== id.toLowerCase()) {
          return jsonError(res, 400, "workflow_id_mismatch", "Workflow id in payload must match route id", {
            routeId: id,
            payloadId: spec.id,
          });
        }

        await saveCustomWorkflow({ ...spec, id });
        const persisted = await getCustomWorkflow(id);
        const metadata = await getWorkflowMetadata(id);
        return json(res, { id, metadata, workflow: persisted }, 200);
      }

      if (customWorkflowMatch && method === "DELETE") {
        const id = customWorkflowMatch[1];
        const deleted = await deleteCustomWorkflow(id);
        if (!deleted) {
          return jsonError(res, 404, "workflow_not_found", `Workflow \"${id}\" not found`);
        }
        return json(res, { id, deleted: true }, 200);
      }

      // --- Backlog API ---
      if (p === "/api/backlog" && method === "GET") {
        return json(res, getItems());
      }

      if (p === "/api/backlog" && method === "POST") {
        const body = JSON.parse(await readBody(req));
        if (!body.title || typeof body.title !== "string") {
          return json(res, { error: "title is required" }, 400);
        }
        const item = createItem(body.title, body.description ?? "", undefined);
        if (body.target_workflow) {
          updateItem(item.id, { target_workflow: body.target_workflow });
          item.target_workflow = body.target_workflow;
        }
        return json(res, item, 201);
      }

      const backlogIdMatch = p.match(/^\/api\/backlog\/([^/]+)$/);

      if (backlogIdMatch && method === "PATCH") {
        const body = JSON.parse(await readBody(req));
        const updated = updateItem(backlogIdMatch[1], body);
        if (!updated) return json(res, { error: "not found" }, 404);
        return json(res, updated);
      }

      if (backlogIdMatch && method === "DELETE") {
        const deleted = deleteItem(backlogIdMatch[1]);
        if (!deleted) return json(res, { error: "not found" }, 404);
        return json(res, { ok: true });
      }

      const reorderMatch = p.match(/^\/api\/backlog\/([^/]+)\/reorder$/);
      if (reorderMatch && method === "POST") {
        const body = JSON.parse(await readBody(req));
        if (typeof body.priority !== "number") {
          return json(res, { error: "priority must be a number" }, 400);
        }
        const reordered = reorderItem(reorderMatch[1], body.priority);
        if (!reordered) return json(res, { error: "not found" }, 404);
        return json(res, reordered);
      }

      const dispatchMatch = p.match(/^\/api\/backlog\/([^/]+)\/dispatch$/);
      if (dispatchMatch && method === "POST") {
        const items = getItems();
        const item = items.find((i) => i.id === dispatchMatch[1]);
        if (!item) return json(res, { error: "not found" }, 404);
        if (!item.target_workflow) {
          return json(res, { error: "target_workflow is not set" }, 400);
        }
        // Validate workflow exists
        let resolved;
        try {
          resolved = await resolveWorkflowReference(item.target_workflow);
        } catch {
          return json(res, { error: "invalid workflow: " + item.target_workflow }, 400);
        }

        if (resolved.source === "custom") {
          await installWorkflow({ workflowId: item.target_workflow });
        }

        const run = await runWorkflow({ workflowId: item.target_workflow, taskTitle: item.title });
        updateItem(item.id, { status: "dispatched" });
        return json(res, { ok: true, run_id: run.id, status: "dispatched" });
      }
    } catch (err: unknown) {
      if (err instanceof SyntaxError) {
        return jsonError(res, 400, "invalid_json", "Request body must be valid JSON");
      }
      const msg = err instanceof Error ? err.message : String(err);
      return jsonError(res, 500, "internal_error", msg);
    }

    if (p === "/api/workflows") {
      return json(res, await loadWorkflows());
    }

    const storiesMatch = p.match(/^\/api\/runs\/([^/]+)\/stories$/);
    if (storiesMatch) {
      const db = getDb();
      const stories = db.prepare("SELECT * FROM stories WHERE run_id = ? ORDER BY story_index ASC").all(storiesMatch[1]);
      return json(res, stories);
    }

    const runMatch = p.match(/^\/api\/runs\/(.+)$/);
    if (runMatch) {
      const run = getRunById(runMatch[1]);
      return run ? json(res, run) : json(res, { error: "not found" }, 404);
    }

    if (p === "/api/runs") {
      const wf = url.searchParams.get("workflow") ?? undefined;
      return json(res, getRuns(wf));
    }

    // Serve fonts
    if (p.startsWith("/fonts/")) {
      const fontName = path.basename(p);
      const fontPath = path.resolve(__dirname, "..", "..", "assets", "fonts", fontName);
      const srcFontPath = path.resolve(__dirname, "..", "..", "src", "..", "assets", "fonts", fontName);
      const resolvedFont = fs.existsSync(fontPath) ? fontPath : srcFontPath;
      if (fs.existsSync(resolvedFont)) {
        res.writeHead(200, {
          "Content-Type": "font/woff2",
          "Cache-Control": "public, max-age=31536000",
          "Access-Control-Allow-Origin": "*",
        });
        return res.end(fs.readFileSync(resolvedFont));
      }
    }

    // Serve logo
    if (p === "/logo.jpeg") {
      const logoPath = path.resolve(__dirname, "..", "..", "assets", "logo.jpeg");
      const srcLogoPath = path.resolve(__dirname, "..", "..", "src", "..", "assets", "logo.jpeg");
      const resolvedLogo = fs.existsSync(logoPath) ? logoPath : srcLogoPath;
      if (fs.existsSync(resolvedLogo)) {
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" });
        return res.end(fs.readFileSync(resolvedLogo));
      }
    }

    // Serve frontend
    serveHTML(res);
  });

  server.listen(port, () => {
    console.log(`Antfarm Dashboard: http://localhost:${port}`);
  });

  return server;
}
