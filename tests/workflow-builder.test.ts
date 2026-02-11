import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  deleteCustomWorkflow,
  getCustomWorkflow,
  listCustomWorkflows,
  saveCustomWorkflow,
  validateWorkflowSpec,
} from "../dist/workflow-builder.js";
import { resolveCustomWorkflowsDir } from "../dist/installer/paths.js";

function makeValidSpec(id: string) {
  return {
    id,
    name: "Test Workflow",
    agents: [
      {
        id: "developer",
        workspace: {
          baseDir: "/tmp/project",
          files: { "README.md": "..." },
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

let tmpDir = "";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "antfarm-custom-workflows-"));
  process.env.OPENCLAW_STATE_DIR = tmpDir;
});

afterEach(async () => {
  delete process.env.OPENCLAW_STATE_DIR;
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

describe("workflow-builder custom workflow CRUD", () => {
  it("lists no workflows when directory does not exist", async () => {
    const items = await listCustomWorkflows();
    assert.deepEqual(items, []);
  });

  it("saves and lists custom workflows", async () => {
    const result = await saveCustomWorkflow(makeValidSpec("my-flow"));
    assert.equal(result.valid, true);

    const dir = resolveCustomWorkflowsDir();
    const stat = await fs.stat(dir);
    assert.equal(stat.isDirectory(), true);

    const items = await listCustomWorkflows();
    assert.deepEqual(items, ["my-flow"]);
  });

  it("normalizes workflow ids to lowercase on save and lookup", async () => {
    const result = await saveCustomWorkflow(makeValidSpec("My-Flow"));
    assert.equal(result.valid, true);

    const items = await listCustomWorkflows();
    assert.deepEqual(items, ["my-flow"]);

    const workflow = await getCustomWorkflow("MY-FLOW");
    assert.equal(workflow?.id, "my-flow");
  });

  it("gets a saved custom workflow", async () => {
    await saveCustomWorkflow(makeValidSpec("reader-flow"));
    const workflow = await getCustomWorkflow("reader-flow");

    assert.ok(workflow);
    assert.equal(workflow?.id, "reader-flow");
    assert.equal(workflow?.agents[0]?.id, "developer");
  });

  it("deletes existing workflows and returns booleans", async () => {
    await saveCustomWorkflow(makeValidSpec("delete-me"));
    const deleted = await deleteCustomWorkflow("delete-me");
    const deletedAgain = await deleteCustomWorkflow("delete-me");

    assert.equal(deleted, true);
    assert.equal(deletedAgain, false);
    assert.deepEqual(await listCustomWorkflows(), []);
  });
});

describe("workflow-builder validation", () => {
  it("returns valid for a complete workflow spec", () => {
    const result = validateWorkflowSpec(makeValidSpec("valid-flow"));
    assert.deepEqual(result, { valid: true, errors: [] });
  });

  it("returns validation error when id is missing", () => {
    const spec = makeValidSpec("x");
    spec.id = "";

    const result = validateWorkflowSpec(spec);
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /missing id/i);
  });

  it("returns validation error when agents are missing", () => {
    const spec = makeValidSpec("x");
    spec.agents = [];

    const result = validateWorkflowSpec(spec);
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /missing agents list/i);
  });

  it("returns validation error when steps are missing", () => {
    const spec = makeValidSpec("x");
    spec.steps = [];

    const result = validateWorkflowSpec(spec);
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /missing steps list/i);
  });

  it("returns validation error for duplicate agent ids", () => {
    const spec = makeValidSpec("x");
    spec.agents = [spec.agents[0], { ...spec.agents[0], id: "developer" }];

    const result = validateWorkflowSpec(spec);
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /duplicate agent id/i);
  });

  it("returns validation error for duplicate step ids", () => {
    const spec = makeValidSpec("x");
    spec.steps = [spec.steps[0], { ...spec.steps[0], id: "s1" }];

    const result = validateWorkflowSpec(spec);
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /duplicate step id/i);
  });

  it("saveCustomWorkflow refuses invalid specs", async () => {
    const spec = makeValidSpec("invalid-save");
    spec.agents = [];

    const result = await saveCustomWorkflow(spec);
    assert.equal(result.valid, false);
    assert.deepEqual(await listCustomWorkflows(), []);
  });

  it("rejects invalid workflow ids before file writes", async () => {
    const dir = resolveCustomWorkflowsDir();
    const spec = makeValidSpec("bad id");

    await assert.rejects(() => saveCustomWorkflow(spec), /invalid workflow id/i);
    await assert.rejects(() => fs.access(dir));
  });
});
