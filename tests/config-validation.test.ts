import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { BOOLEAN_ENV_RULES, loadConfig, NUMERIC_ENV_RULES } from "../src/config.js";

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

test("boolean env fields reject malformed and empty values with actionable env names", () => {
  for (const name of Object.keys(BOOLEAN_ENV_RULES)) {
    for (const raw of ["treu", "maybe", "2", ""]) {
      withEnv({ [name]: raw }, () => {
        assert.throws(
          () => loadConfig(),
          new RegExp(`${name} must be a boolean`),
        );
      });
    }
  }
});

test("boolean env fields accept only explicit true and false spellings", () => {
  for (const name of Object.keys(BOOLEAN_ENV_RULES)) {
    for (const raw of ["1", "true", "yes", "on", "0", "false", "no", "off"]) {
      withEnv({ [name]: raw }, () => {
        assert.doesNotThrow(() => loadConfig());
      });
    }
  }
});

test("allowlist cannot be disabled by a boolean typo", () => {
  withEnv({ TELEGRAM_REQUIRE_ALLOWLIST: "tru" }, () => {
    assert.throws(
      () => loadConfig(),
      /TELEGRAM_REQUIRE_ALLOWLIST must be a boolean/,
    );
  });
});

test("unset boolean defaults are safe for live sending", () => {
  withEnv(unsetBooleanEnv(), () => {
    const config = loadConfig();
    assert.equal(config.safety.sendEnabled, false);
    assert.equal(config.safety.dryRunDefault, true);
    assert.equal(config.safety.liveSendApprovalBypass, false);
  });
});

test("explicit live send opt-in requires send enabled and hard dry-run disabled", () => {
  withEnv(
    {
      ...unsetBooleanEnv(),
      TELEGRAM_SEND_ENABLED: "true",
      TELEGRAM_DRY_RUN_DEFAULT: "false",
      TELEGRAM_LIVE_SEND_APPROVAL_BYPASS: "false",
    },
    () => {
      const config = loadConfig();
      assert.equal(config.safety.sendEnabled, true);
      assert.equal(config.safety.dryRunDefault, false);
      assert.equal(config.safety.liveSendApprovalBypass, false);
    },
  );
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

test("configured dotenv files are parsed without shell execution", () => {
  const dir = mkdtempSync(join(tmpdir(), "telegram-config-env-file-test-"));
  const sharedEnv = join(dir, "shared.env");
  const localEnv = join(dir, "local.env");
  const marker = join(dir, "should-not-exist");
  const localDefaultChat = `$(touch ${marker})`;
  try {
    writeFileSync(
      sharedEnv,
      [
        "TELEGRAM_DEFAULT_CHAT_ID=-100shared",
        "TELEGRAM_ALLOWED_CHAT_IDS=-100shared",
        "TELEGRAM_SEND_ENABLED=true",
      ].join("\n"),
    );
    writeFileSync(
      localEnv,
      [
        `TELEGRAM_DEFAULT_CHAT_ID=${localDefaultChat}`,
        `TELEGRAM_ALLOWED_CHAT_IDS=${localDefaultChat}`,
        "TELEGRAM_SEND_ENABLED=true",
      ].join("\n"),
    );

    const result = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts", "--print-config"], {
      cwd: process.cwd(),
      env: {
        HOME: dir,
        PATH: process.env.PATH ?? "",
        TELEGRAM_SHARED_ENV_PATH: sharedEnv,
        TELEGRAM_ENV_PATH: localEnv,
        TELEGRAM_DB_PATH: join(dir, "messages.sqlite"),
        TELEGRAM_SEND_ENABLED: "false",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(marker), false);
    const config = JSON.parse(result.stdout) as {
      telegram: { defaultChatId: string; allowedChatIds: string[] };
      safety: { sendEnabled: boolean };
    };
    assert.equal(config.telegram.defaultChatId, localDefaultChat);
    assert.deepEqual(config.telegram.allowedChatIds, [localDefaultChat]);
    assert.equal(config.safety.sendEnabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("copied env example keeps live sends hard-disabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "telegram-config-example-test-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts", "--print-config"], {
      cwd: process.cwd(),
      env: {
        HOME: dir,
        PATH: process.env.PATH ?? "",
        TELEGRAM_SHARED_ENV_PATH: join(dir, "missing-shared.env"),
        TELEGRAM_ENV_PATH: join(process.cwd(), ".env.example"),
        TELEGRAM_DB_PATH: join(dir, "messages.sqlite"),
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout) as {
      safety: { sendEnabled: boolean; dryRunDefault: boolean; liveSendApprovalBypass: boolean };
    };
    assert.equal(config.safety.sendEnabled, false);
    assert.equal(config.safety.dryRunDefault, true);
    assert.equal(config.safety.liveSendApprovalBypass, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function unsetBooleanEnv(): Record<string, undefined> {
  return Object.fromEntries(Object.keys(BOOLEAN_ENV_RULES).map((name) => [name, undefined])) as Record<string, undefined>;
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), "telegram-config-test-"));
  const applied = {
    ...vars,
    TELEGRAM_DB_PATH: join(dir, "messages.sqlite"),
  };
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(applied)) {
    previous.set(key, process.env[key]);
    const value = applied[key];
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
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
