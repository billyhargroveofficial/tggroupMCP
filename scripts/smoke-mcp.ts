import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = mkdtempSync(join(tmpdir(), "telegram-parilka-mcp-smoke-"));
const smokeChatId = "-1001234567890";
const stderrChunks: string[] = [];
const useWrapper = process.argv.includes("--wrapper");
const entrypoint = useWrapper ? "bin-wrapper" : "source";

const transport = new StdioClientTransport({
  command: useWrapper ? join(repoRoot, "bin", "telegram-parilka-mcp") : process.execPath,
  args: useWrapper ? [] : ["--import", "tsx", "src/index.ts"],
  cwd: repoRoot,
  stderr: "pipe",
  env: {
    ...getDefaultEnvironment(),
    NODE_NO_WARNINGS: "1",
    TELEGRAM_API_ID: "0",
    TELEGRAM_API_HASH: "",
    TELEGRAM_SESSION: "",
    TELEGRAM_SESSION_STRING_PERSONAL: "",
    TELEGRAM_SESSION_STRING_WIFE: "",
    SESSION: "",
    TELEGRAM_PHONE: "",
    TELEGRAM_DEFAULT_CHAT_ID: smokeChatId,
    TELEGRAM_ALLOWED_CHAT_IDS: smokeChatId,
    TELEGRAM_DB_PATH: join(tempDir, "messages.sqlite"),
    TELEGRAM_REQUIRE_ALLOWLIST: "true",
    TELEGRAM_SEND_ENABLED: "false",
    TELEGRAM_DRY_RUN_DEFAULT: "true",
    TELEGRAM_LIVE_SEND_APPROVAL_BYPASS: "false",
    TELEGRAM_EMBEDDINGS_ENABLED: "false",
    TELEGRAM_EMBEDDINGS_API_KEY: "",
    OPENAI_API_KEY: "",
  },
});

transport.stderr?.on("data", (chunk: Buffer | string) => {
  stderrChunks.push(chunk.toString());
});

const client = new Client({ name: "telegram-parilka-mcp-smoke", version: "0.1.0" }, { capabilities: {} });

try {
  await client.connect(transport, { timeout: 5_000 });

  const tools = await client.listTools(undefined, { timeout: 5_000 });
  assert(tools.tools.some((tool) => tool.name === "get_config"), "tools/list did not include get_config");

  const result = await client.callTool({ name: "get_config", arguments: {} }, undefined, { timeout: 5_000 });
  const payload = parseTextPayload(result.content);
  assert(payload.ok === true, "get_config did not return ok:true");
  assert(payload.config?.sendEnabled === false, "smoke config must keep live sends disabled");
  assert(payload.config?.dryRunDefault === true, "smoke config must keep dry-run enabled");
  assert(payload.config?.isTelegramConfigured === false, "smoke must not inherit Telegram credentials");
  assert(payload.config?.embeddings?.enabled === false, "smoke must keep embeddings disabled");
  assert(payload.config?.embeddings?.configured === false, "smoke must not inherit embedding credentials");

  console.log(JSON.stringify({ ok: true, entrypoint, tools: tools.tools.length, checkedTool: "get_config" }, null, 2));
} catch (error) {
  console.error("MCP smoke failed:", error);
  const stderr = stderrChunks.join("").trim();
  if (stderr) {
    console.error("Server stderr:");
    console.error(stderr);
  }
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
  rmSync(tempDir, { recursive: true, force: true });
}

function parseTextPayload(content: unknown): Record<string, any> {
  assert(Array.isArray(content), "tool response content was not an array");
  const text = content.find((item): item is { type: "text"; text: string } => {
    return item != null && typeof item === "object" && "type" in item && item.type === "text" && "text" in item;
  })?.text;
  assert(typeof text === "string", "tool response did not contain text content");
  const parsed = JSON.parse(text) as unknown;
  assert(parsed != null && typeof parsed === "object" && !Array.isArray(parsed), "tool response was not a JSON object");
  return parsed as Record<string, any>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
