import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startDashboard } from "../dist/server/dashboard.js";

const PORT = 9881;
let server;
let tmpDir = "";

function makeValidSpec(id = "builder-flow") {
  return {
    id,
    name: "Builder Flow",
    agents: [
      {
        id: "developer",
        workspace: {
          baseDir: "/tmp/project",
          files: { "README.md": "demo" },
        },
      },
    ],
    steps: [
      {
        id: "s1",
        agent: "developer",
        input: "do work",
        expects: "done",
      },
    ],
  };
}

function req(method, reqPath, body, rawBody) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "localhost",
      port: PORT,
      path: reqPath,
      method,
      headers: body || rawBody ? { "Content-Type": "application/json" } : {},
    };
    const r = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let data = null;
        if (text) {
          data = JSON.parse(text);
        }
        resolve({ status: res.statusCode, data });
      });
    });
    r.on("error", reject);
    if (rawBody) {
      r.write(rawBody);
    } else if (body) {
      r.write(JSON.stringify(body));
    }
    r.end();
  });
}

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "antfarm-workflow-api-"));
  process.env.OPENCLAW_STATE_DIR = tmpDir;
  server = startDashboard(PORT);
});

after(async () => {
  server.close();
  delete process.env.OPENCLAW_STATE_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const customDir = path.join(tmpDir, "antfarm", "custom-workflows");
  await fs.rm(customDir, { recursive: true, force: true });
});

afterEach(async () => {
  const customDir = path.join(tmpDir, "antfarm", "custom-workflows");
  await fs.rm(customDir, { recursive: true, force: true });
});

describe("workflow builder dashboard API", () => {
  it("lists empty custom workflows", async () => {
    const { status, data } = await req("GET", "/api/custom-workflows");
    assert.equal(status, 200);
    assert.deepEqual(data, []);
  });

  it("creates and fetches a custom workflow", async () => {
    const spec = makeValidSpec("new-flow");
    const created = await req("POST", "/api/custom-workflows", spec);
    assert.equal(created.status, 201);
    assert.equal(created.data.id, "new-flow");
    assert.equal(created.data.metadata.id, "new-flow");
    assert.equal(created.data.workflow.id, "new-flow");

    const fetched = await req("GET", "/api/custom-workflows/new-flow");
    assert.equal(fetched.status, 200);
    assert.equal(fetched.data.workflow.name, "Builder Flow");
    assert.ok(typeof fetched.data.metadata.updatedAt === "string");
  });

  it("blocks overwrite on create unless overwrite=true", async () => {
    await req("POST", "/api/custom-workflows", makeValidSpec("dup-flow"));
    const conflict = await req("POST", "/api/custom-workflows", makeValidSpec("dup-flow"));
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.error.code, "workflow_exists");

    const overwrite = await req("POST", "/api/custom-workflows", {
      spec: { ...makeValidSpec("dup-flow"), name: "Overwritten" },
      overwrite: true,
    });
    assert.equal(overwrite.status, 200);
    assert.equal(overwrite.data.workflow.name, "Overwritten");
  });

  it("returns structured 400 for invalid JSON", async () => {
    const response = await req("POST", "/api/custom-workflows", undefined, "{bad json");
    assert.equal(response.status, 400);
    assert.equal(response.data.error.code, "invalid_json");
  });

  it("returns structured 400 for invalid workflow spec", async () => {
    const spec = makeValidSpec("broken-flow");
    spec.steps = [];
    const response = await req("POST", "/api/custom-workflows", spec);
    assert.equal(response.status, 400);
    assert.equal(response.data.error.code, "invalid_workflow_spec");
    assert.ok(Array.isArray(response.data.error.details.errors));
  });

  it("validates workflow specs via /validate", async () => {
    const ok = await req("POST", "/api/custom-workflows/validate", makeValidSpec("validate-me"));
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.data, { valid: true, errors: [] });

    const bad = await req("POST", "/api/custom-workflows/validate", { id: "oops" });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error.code, "invalid_workflow_spec");
  });

  it("updates an existing custom workflow", async () => {
    await req("POST", "/api/custom-workflows", makeValidSpec("edit-me"));
    const updated = await req("PATCH", "/api/custom-workflows/edit-me", {
      ...makeValidSpec("edit-me"),
      name: "Edited Name",
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.id, "edit-me");
    assert.equal(updated.data.workflow.name, "Edited Name");
    assert.ok(updated.data.metadata.sizeBytes > 0);
  });

  it("returns 400 when route id and payload id mismatch on update", async () => {
    await req("POST", "/api/custom-workflows", makeValidSpec("route-id"));
    const response = await req("PATCH", "/api/custom-workflows/route-id", {
      ...makeValidSpec("other-id"),
    });
    assert.equal(response.status, 400);
    assert.equal(response.data.error.code, "workflow_id_mismatch");
  });

  it("deletes a custom workflow", async () => {
    await req("POST", "/api/custom-workflows", makeValidSpec("delete-me"));

    const deleted = await req("DELETE", "/api/custom-workflows/delete-me");
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.data, { id: "delete-me", deleted: true });

    const missing = await req("GET", "/api/custom-workflows/delete-me");
    assert.equal(missing.status, 404);
    assert.equal(missing.data.error.code, "workflow_not_found");
  });
});
