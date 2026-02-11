import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { rmSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "dist", "cli", "cli.js");

let stateDir = "";

function run(cmd) {
  return execSync(`node ${CLI} ${cmd}`, {
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: join(stateDir, "openclaw.json"),
      ANTFARM_DB_PATH: join(stateDir, "test.db"),
    },
    encoding: "utf-8",
    timeout: 10000,
  }).trim();
}

function runFail(cmd) {
  try {
    run(cmd);
    assert.fail("Expected command to fail");
  } catch (err) {
    return (err.stderr || err.stdout || "").toString().trim();
  }
}

function seedCustomWorkflow({ id = "custom-runner", invalid = false } = {}) {
  const customDir = join(stateDir, "antfarm", "custom-workflows");
  mkdirSync(customDir, { recursive: true });
  const bootstrapFile = join(stateDir, "bootstrap.txt");
  writeFileSync(bootstrapFile, "hello", "utf-8");

  if (invalid) {
    writeFileSync(join(customDir, `${id}.yml`), "id: bad\nagents: []\nsteps: []\n", "utf-8");
    return;
  }

  const yaml = [
    `id: ${id}`,
    "name: Custom Runner",
    "agents:",
    "  - id: dev",
    "    workspace:",
    "      baseDir: app",
    "      files:",
    `        README.md: ${JSON.stringify(bootstrapFile)}`,
    "steps:",
    "  - id: s1",
    "    agent: dev",
    "    input: do the task",
    "    expects: done",
    "",
  ].join("\n");

  writeFileSync(join(customDir, `${id}.yml`), yaml, "utf-8");
}

describe("workflow lifecycle CLI (bundled + custom)", () => {
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "antfarm-workflow-lifecycle-"));
    writeFileSync(join(stateDir, "openclaw.json"), JSON.stringify({ agents: { list: [] } }, null, 2), "utf-8");
  });

  afterEach(() => {
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  });

  it("workflow list includes bundled and custom with source labels", () => {
    seedCustomWorkflow({ id: "custom-labeled" });

    const out = run("workflow list");
    assert.match(out, /feature-dev \(bundled\)/i);
    assert.match(out, /custom-labeled \(custom\)/i);
  });

  it("workflow run works for custom workflow ids", () => {
    seedCustomWorkflow({ id: "custom-runner" });

    const out = run('workflow run custom-runner "hello world"');
    assert.match(out, /^Run:\s+/m);
    assert.match(out, /^Workflow:\s+custom-runner/m);
    assert.match(out, /^Status:\s+running/m);
  });

  it("run errors distinguish unknown workflow vs invalid custom workflow spec", () => {
    const unknown = runFail('workflow run does-not-exist "task"');
    assert.match(unknown, /unknown workflow/i);

    seedCustomWorkflow({ id: "broken-custom", invalid: true });
    const invalid = runFail('workflow run broken-custom "task"');
    assert.match(invalid, /invalid custom workflow spec/i);
  });
});
