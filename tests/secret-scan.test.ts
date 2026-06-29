import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  formatSecretFindings,
  isScannableFile,
  patterns,
  scanSecretFiles,
  secretScanSummary,
} from "../scripts/secret-scan.js";

test("secret scan detects synthetic fixtures with redacted file and line findings", () => {
  const dir = mkdtempSync(join(tmpdir(), "telegram-secret-scan-test-"));
  const fixture = join(dir, "synthetic.env");
  const openAiKey = "sk-" + "a".repeat(24);
  const telegramHash = "0123456789abcdef".repeat(2);
  const stringSession = "A".repeat(90);
  const privateKeyBegin = "-----BEGIN " + "PRIVATE KEY-----";
  try {
    writeFileSync(
      fixture,
      [
        "SAFE_VALUE=ok",
        `OPENAI_API_KEY=${openAiKey}`,
        "TELEGRAM_API_ID=123",
        `TELEGRAM_API_HASH=${telegramHash}`,
        "TELEGRAM_PHONE=+10000000000",
        `TELEGRAM_SESSION=${stringSession}`,
        "PRIVATE_KEY_FOR_TESTING=",
        privateKeyBegin,
        "synthetic-body",
        "-----END PRIVATE KEY-----",
      ].join("\n"),
    );

    const findings = scanSecretFiles([fixture]);
    assert.deepEqual(
      findings.map((finding) => ({ line: finding.line, pattern: finding.pattern })),
      [
        { line: 2, pattern: "OpenAI-compatible API key" },
        { line: 4, pattern: "Telegram API hash" },
        { line: 6, pattern: "Telegram StringSession" },
        { line: 8, pattern: "Private key block" },
      ],
    );

    const report = formatSecretFindings(findings);
    assert.match(report, new RegExp(`${escapeRegExp(fixture)}:2 OpenAI-compatible API key`));
    assert.match(report, new RegExp(`${escapeRegExp(fixture)}:4 Telegram API hash`));
    for (const secret of [openAiKey, telegramHash, stringSession, privateKeyBegin]) {
      assert.equal(report.includes(secret), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secret scan summary and file filter expose the configured scanner surface", () => {
  const summary = secretScanSummary(["README.md"]);

  assert.deepEqual(
    summary.patterns,
    patterns.map((pattern) => pattern.name),
  );
  assert.equal(summary.scannedFiles, 1);
  assert.equal(isScannableFile("safe.txt"), true);
  assert.equal(isScannableFile("image.png"), false);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
