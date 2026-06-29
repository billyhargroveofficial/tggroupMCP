import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const checkBuild = resolve("bin", "telegram-parilka-mcp-check-build");

test("build guard reports missing deployed entrypoint clearly", () => {
  const projectDir = makeTempProject();
  try {
    const entrypoint = join(projectDir, "dist", "index.js");
    const result = spawnSync(checkBuild, [projectDir, entrypoint], { encoding: "utf8" });

    assert.equal(result.status, 78);
    assert.match(result.stderr, /missing built entrypoint/);
    assert.match(result.stderr, /npm run build/);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("build guard reports stale deployed entrypoint clearly", () => {
  const projectDir = makeTempProject();
  try {
    const entrypoint = join(projectDir, "dist", "index.js");
    mkdirSync(join(projectDir, "dist"), { recursive: true });
    writeFileSync(entrypoint, "console.log('old build');\n");

    const oldDate = new Date("2026-01-01T00:00:00Z");
    const newDate = new Date("2026-01-02T00:00:00Z");
    utimesSync(entrypoint, oldDate, oldDate);
    utimesSync(join(projectDir, "src", "index.ts"), newDate, newDate);

    const result = spawnSync(checkBuild, [projectDir, entrypoint], { encoding: "utf8" });

    assert.equal(result.status, 78);
    assert.match(result.stderr, /built entrypoint is stale/);
    assert.match(result.stderr, /Newer source\/config file:/);
    assert.match(result.stderr, /npm run build/);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

function makeTempProject(): string {
  const projectDir = mkdtempSync(join(tmpdir(), "telegram-parilka-mcp-entrypoint-"));
  mkdirSync(join(projectDir, "src"), { recursive: true });
  writeFileSync(join(projectDir, "src", "index.ts"), "export {};\n");
  writeFileSync(join(projectDir, "package.json"), "{}\n");
  writeFileSync(join(projectDir, "tsconfig.json"), "{}\n");
  return projectDir;
}
