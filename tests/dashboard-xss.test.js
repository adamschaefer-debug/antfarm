import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const htmlPath = path.resolve(process.cwd(), "src/server/index.html");
const html = fs.readFileSync(htmlPath, "utf8");

describe("dashboard XSS hardening", () => {
  it("escapes workflow options and avoids unsafe inline interpolation for run click handlers", () => {
    assert.match(html, /document\.createElement\('option'\)/, "workflow options should be created via DOM API");
    assert.match(html, /option\.textContent\s*=\s*String\(w\.name \|\| w\.id \|\| ''\)/);
    assert.doesNotMatch(html, /onclick="openRun\('/, "run cards should not embed run.id inside inline JS");
    assert.match(html, /data-run-id="\$\{escAttr\(run\.id\)\}"/, "run id should be attribute-escaped");
  });

  it("uses context-appropriate escaping and status normalization", () => {
    assert.match(html, /function escText\(s\)/, "text escaping helper should exist");
    assert.match(html, /function escAttr\(s\)/, "attribute escaping helper should exist");
    assert.match(html, /function safeStatus\(s\)/, "status should be normalized before class injection");
    assert.match(html, /<div class="step-name">\$\{escText\(s\.step_id\)\}<\/div>/);
    assert.match(html, /<span class="badge badge-\$\{runStatus\}">\$\{escText\(runStatus\)\}<\/span>/);
  });
});
