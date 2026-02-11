import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverWorkflows, listBundledWorkflowIds } from "../dist/installer/workflow-discovery.js";
import { listBundledWorkflows } from "../dist/installer/workflow-fetch.js";
import {
  resolveCustomWorkflowPath,
  resolveCustomWorkflowsDir,
  resolveOpenClawStateDir,
} from "../dist/installer/paths.js";

let tmpDir = "";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "antfarm-workflow-discovery-"));
  process.env.OPENCLAW_STATE_DIR = tmpDir;
});

afterEach(async () => {
  delete process.env.OPENCLAW_STATE_DIR;
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

describe("installer path helpers for custom workflows", () => {
  it("resolves custom workflow storage under the OpenClaw state dir", () => {
    assert.equal(resolveOpenClawStateDir(), tmpDir);
    assert.equal(resolveCustomWorkflowsDir(), path.join(tmpDir, "antfarm", "custom-workflows"));
    assert.equal(resolveCustomWorkflowPath("my-flow"), path.join(tmpDir, "antfarm", "custom-workflows", "my-flow.yml"));
  });
});

describe("workflow discovery", () => {
  it("keeps bundled workflow listing behavior consistent", async () => {
    const fromFetch = await listBundledWorkflows();
    const fromDiscoveryPrimitive = await listBundledWorkflowIds();

    assert.deepEqual(fromFetch, fromDiscoveryPrimitive);
    assert.deepEqual(fromFetch, [...fromFetch].sort());
  });

  it("returns bundled + custom workflows in one deterministic, normalized shape", async () => {
    const customDir = resolveCustomWorkflowsDir();
    await fs.mkdir(customDir, { recursive: true });

    await fs.writeFile(path.join(customDir, "zeta.yml"), "id: zeta\nname: Zeta\nagents: []\nsteps: []\n", "utf-8");
    await fs.writeFile(path.join(customDir, "alpha.yaml"), "id: alpha\nname: Alpha\nagents: []\nsteps: []\n", "utf-8");

    const discovered = await discoverWorkflows();

    assert.ok(discovered.length >= 2);
    assert.deepEqual(discovered, [...discovered].sort((a, b) => a.id.localeCompare(b.id) || a.source.localeCompare(b.source)));

    const alphaCustom = discovered.find((w) => w.id === "alpha" && w.source === "custom");
    const zetaCustom = discovered.find((w) => w.id === "zeta" && w.source === "custom");

    assert.ok(alphaCustom);
    assert.ok(zetaCustom);
    assert.equal(alphaCustom?.specPath, resolveCustomWorkflowPath("alpha"));
    assert.equal(zetaCustom?.specPath, resolveCustomWorkflowPath("zeta"));

    const bundled = discovered.filter((w) => w.source === "bundled");
    assert.ok(bundled.every((w) => w.specPath.endsWith(path.join(w.id, "workflow.yml"))));
  });
});
