import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

type SecretPattern = {
  name: string;
  regex: RegExp;
};

const patterns: SecretPattern[] = [
  {
    name: "OpenAI-compatible API key",
    regex: /\b(?:OPENAI_API_KEY|TELEGRAM_EMBEDDINGS_API_KEY)\s*[:=]\s*['"]?sk-[A-Za-z0-9_-]{20,}/i,
  },
  {
    name: "Telegram API hash",
    regex: /\bTELEGRAM_API_HASH\s*[:=]\s*['"]?[a-f0-9]{32}\b/i,
  },
  {
    name: "Telegram StringSession",
    regex: /\b(?:TELEGRAM_SESSION|TELEGRAM_SESSION_STRING(?:_[A-Z0-9_]+)?|SESSION)\s*[:=]\s*['"]?[A-Za-z0-9+/=_-]{80,}/,
  },
  {
    name: "Private key block",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  },
];

const git = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  encoding: "buffer",
});

if (git.status !== 0) {
  process.stderr.write(git.stderr);
  process.exit(git.status ?? 1);
}

const files = git.stdout
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .filter((file) => !file.endsWith(".png") && !file.endsWith(".jpg") && !file.endsWith(".jpeg") && !file.endsWith(".gif"));

const findings: Array<{ file: string; line: number; pattern: string }> = [];

for (const file of files) {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const pattern of patterns) {
      if (pattern.regex.test(line)) {
        findings.push({ file, line: index + 1, pattern: pattern.name });
      }
    }
  }
}

if (findings.length > 0) {
  console.error("Potential secrets found. Values are intentionally redacted:");
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line} ${finding.pattern}`);
  }
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      scannedFiles: files.length,
      patterns: patterns.map((pattern) => pattern.name),
    },
    null,
    2,
  ),
);
