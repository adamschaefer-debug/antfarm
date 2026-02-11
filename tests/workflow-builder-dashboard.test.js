import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = __dirname.includes("dist") ? path.resolve(__dirname, "..", "..") : path.resolve(__dirname, "..");
const htmlPath = path.join(repoRoot, "src", "server", "index.html");
const html = fs.readFileSync(htmlPath, "utf-8");

describe("workflow builder dashboard UI", () => {
  it("provides workflow builder panel entrypoint and metadata fields", () => {
    assert.ok(html.includes("Workflow Builder"), "has workflow builder button/title");
    assert.ok(html.includes("id=\"wb-id\""), "has workflow id input");
    assert.ok(html.includes("id=\"wb-name\""), "has workflow name input");
    assert.ok(html.includes("id=\"builder-overlay\""), "has dedicated workflow builder overlay");
  });

  it("supports adding/removing multiple agents and steps", () => {
    assert.ok(html.includes("function addBuilderAgent()"), "has add agent function");
    assert.ok(html.includes("function removeBuilderAgent(index)"), "has remove agent function");
    assert.ok(html.includes("function addBuilderStep()"), "has add step function");
    assert.ok(html.includes("function removeBuilderStep(index)"), "has remove step function");
    assert.ok(html.includes("+ Add Agent"), "has add agent UI control");
    assert.ok(html.includes("+ Add Step"), "has add step UI control");
  });

  it("validates workflow spec and surfaces server-side errors inline", () => {
    assert.ok(html.includes("async function validateWorkflowBuilderSpec()"), "has validate action");
    assert.ok(html.includes("/api/custom-workflows/validate"), "calls validate API endpoint");
    assert.ok(html.includes("setBuilderErrors(errs)"), "maps server errors to UI");
    assert.ok(html.includes("id=\"wb-errors\""), "has inline error container");
    assert.ok(html.includes("builder-error-box"), "has error styles");
  });

  it("saves workflow and refreshes workflow selector options", () => {
    assert.ok(html.includes("async function saveWorkflowBuilderSpec()"), "has save action");
    assert.ok(html.includes("'/api/custom-workflows'"), "calls create custom workflow endpoint");
    assert.ok(html.includes("await loadWorkflows()"), "refreshes workflow options after save");
    assert.ok(html.includes("id=\"wf-select\""), "has workflow selector in dashboard header");
    assert.ok(html.includes("setBuilderSuccess(`Saved workflow"), "shows save success state");
  });
});
