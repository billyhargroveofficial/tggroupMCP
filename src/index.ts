#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, redactedConfig } from "./config.js";
import { stringify } from "./json.js";
import { MessageStore } from "./store.js";
import { TelegramService } from "./telegram-client.js";
import { TelegramTools } from "./tools.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (process.argv.includes("--validate-config")) {
    console.log(stringify({ ok: true, config: redactedConfig(config) }));
    return;
  }
  if (process.argv.includes("--print-config")) {
    console.log(stringify(redactedConfig(config)));
    return;
  }

  const telegram = new TelegramService(config);
  const store = new MessageStore(config.storage.dbPath);
  const tools = new TelegramTools(config, telegram, store);
  if (process.argv.includes("--status")) {
    const result = await tools.callTool("get_status", {});
    console.log(result.content[0]?.text ?? stringify({ ok: false, error: { message: "Status tool returned no content." } }));
    return;
  }

  const server = new Server(
    { name: "telegram-parilka-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return tools.callTool(request.params.name, request.params.arguments ?? {});
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("telegram-parilka-mcp running on stdio");
}

main().catch((error) => {
  console.error("telegram-parilka-mcp fatal:", error);
  process.exit(1);
});
