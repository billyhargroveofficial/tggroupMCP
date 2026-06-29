import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { loadConfig, NUMERIC_ENV_RULES } from "../src/config.js";

test("every numeric env field rejects values below its allowed range", () => {
  for (const [name, rule] of Object.entries(NUMERIC_ENV_RULES)) {
    withEnv({ [name]: String(rule.min - 1) }, () => {
      assert.throws(() => loadConfig(), new RegExp(`${name} must be an integer between ${rule.min} and ${rule.max}`));
    });
  }
});

test("every numeric env field rejects values above its allowed range", () => {
  for (const [name, rule] of Object.entries(NUMERIC_ENV_RULES)) {
    withEnv({ [name]: String(rule.max + 1) }, () => {
      assert.throws(() => loadConfig(), new RegExp(`${name} must be an integer between ${rule.min} and ${rule.max}`));
    });
  }
});

test("numeric env fields reject floats and NaN with actionable env names", () => {
  for (const raw of ["1.5", "NaN"]) {
    withEnv({ TELEGRAM_HISTORY_BATCH_SIZE: raw }, () => {
      assert.throws(
        () => loadConfig(),
        /TELEGRAM_HISTORY_BATCH_SIZE must be an integer between 1 and 1000/,
      );
    });
  }
});

test("cross-field validation rejects a backoff max below initial backoff", () => {
  withEnv(
    {
      TELEGRAM_SYNC_BACKOFF_INITIAL_MS: "10000",
      TELEGRAM_SYNC_BACKOFF_MAX_MS: "5000",
    },
    () => {
      assert.throws(
        () => loadConfig(),
        /TELEGRAM_SYNC_BACKOFF_MAX_MS must be greater than or equal to TELEGRAM_SYNC_BACKOFF_INITIAL_MS/,
      );
    },
  );
});

test("validate-config CLI fails before startup on invalid config", () => {
  const dir = mkdtempSync(join(tmpdir(), "telegram-config-cli-test-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts", "--validate-config"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TELEGRAM_DB_PATH: join(dir, "messages.sqlite"),
        TELEGRAM_GLOBAL_CONCURRENCY: "0",
      },
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /TELEGRAM_GLOBAL_CONCURRENCY must be an integer between 1 and 1000/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function withEnv(vars: Record<string, string>, fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), "telegram-config-test-"));
  const applied = {
    ...vars,
    TELEGRAM_DB_PATH: join(dir, "messages.sqlite"),
  };
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(applied)) {
    previous.set(key, process.env[key]);
    process.env[key] = applied[key];
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
