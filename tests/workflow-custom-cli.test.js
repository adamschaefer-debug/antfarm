import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "dist", "cli", "cli.js");

let stateDir = "";

function run(cmd, { input } = {}) {
  return execSync(`node ${CLI} ${cmd}`, {
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      ANTFARM_DB_PATH: join(stateDir, "test.db"),
    },
    encoding: "utf-8",
    timeout: 10000,
    input,
  }).trim();
}

function runFail(cmd, { input } = {}) {
  try {
    run(cmd, { input });
    assert.fail("Expected command to fail");
  } catch (err) {
    return (err.stderr || err.stdout || "").toString().trim();
  }
}

function validSpec(id = "my-custom") {
  return {
    id,
    name: "My Custom Workflow",
    agents: [
      {
        id: "developer",
        workspace: {
          baseDir: "/tmp/proj",
          files: { "README.md": "hi" },
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

describe("workflow custom CLI", () => {
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "antfarm-workflow-custom-cli-"));
  });

  afterEach(() => {
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  });

  it("usage includes workflow custom commands", () => {
    const out = runFail("");
    assert.match(out, /workflow custom list/i);
    assert.match(out, /workflow custom create/i);
    assert.match(out, /workflow custom delete/i);
  });

  it("creates from file, then lists and shows", () => {
    const specPath = join(stateDir, "spec.json");
    writeFileSync(specPath, JSON.stringify(validSpec("from-file"), null, 2), "utf-8");

    const createOut = run(`workflow custom create --file ${specPath}`);
    assert.match(createOut, /created custom workflow/i);

    const listOut = run("workflow custom list");
    assert.match(listOut, /from-file/i);

    const showOut = run("workflow custom show from-file");
    assert.match(showOut, /^id:\s*from-file/m);
    assert.match(showOut, /name:\s*My Custom Workflow/m);
  });

  it("creates from stdin JSON", () => {
    const out = run("workflow custom create", { input: JSON.stringify(validSpec("stdin-flow")) });
    assert.match(out, /created custom workflow/i);
    assert.match(run("workflow custom list"), /stdin-flow/i);
  });

  it("rejects invalid spec and does not write files", () => {
    const bad = validSpec("bad-flow");
    bad.steps = [];

    const err = runFail("workflow custom create", { input: JSON.stringify(bad) });
    assert.match(err, /invalid workflow spec/i);

    const listOut = run("workflow custom list");
    assert.match(listOut, /no custom workflows found/i);
  });

  it("updates and deletes custom workflows", () => {
    run("workflow custom create", { input: JSON.stringify(validSpec("to-update")) });

    const updated = validSpec("different-id-ignored");
    updated.name = "Updated Name";
    const updateOut = run("workflow custom update to-update", { input: JSON.stringify(updated) });
    assert.match(updateOut, /updated custom workflow/i);

    const showOut = run("workflow custom show to-update");
    assert.match(showOut, /name:\s*Updated Name/m);
    assert.match(showOut, /^id:\s*to-update/m);

    const deleteOut = run("workflow custom delete to-update");
    assert.match(deleteOut, /deleted custom workflow/i);
    assert.match(run("workflow custom list"), /no custom workflows found/i);
  });
});
