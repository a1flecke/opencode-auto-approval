import { describe, expect, test } from "bun:test";
import { findScriptDrift, parseJsonc, pluginOptions } from "../scripts/check-trusted-scripts.js";

describe("findScriptDrift", () => {
  const files = ["scripts/a.sh", "scripts/b.sh", "tools/scripts/c.sh", "src/x.ts", "scripts/data.json"];

  test("flags tracked scripts that are neither trusted nor exempt", () => {
    expect(findScriptDrift(files, ["scripts/a.sh"], []).unclassified).toEqual(["scripts/b.sh", "tools/scripts/c.sh"]);
  });
  test("an exemption classifies a script", () => {
    expect(findScriptDrift(files, ["scripts/a.sh"], ["scripts/b.sh", "tools/scripts/c.sh"]).unclassified).toEqual([]);
  });
  test("reports entries the plugin would ignore", () => {
    expect(findScriptDrift([], ["scripts/*.sh", "scripts/a.sh"], []).invalid).toEqual(["scripts/*.sh"]);
  });
});

describe("config parsing", () => {
  test("reads trustedScripts from a commented config without breaking URLs", () => {
    const cfg = parseJsonc(`{
      // comment
      "plugins": [ { "package": "/p/opencode-auto-approval", "options": { "u": "https://x.y", "trustedScripts": ["scripts/a.sh",], }, } ],
    }`);
    expect(pluginOptions(cfg).trustedScripts).toEqual(["scripts/a.sh"]);
  });
  test("fails when the plugin is not configured", () => {
    expect(() => pluginOptions({ plugins: [] })).toThrow();
  });
});
