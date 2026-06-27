#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { stringify } from "./json.js";
import { MessageStore } from "./store.js";
import { VectorRag } from "./vector-rag.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new MessageStore(config.storage.dbPath);
  const vectorRag = new VectorRag(config, store);
  const args = parseArgs(process.argv.slice(2));
  const chatId = args.chat || config.telegram.defaultChatId;

  const result = await vectorRag.indexCachedMessages({
    chatId,
    limitChunks: args.limitChunks ?? config.embeddings.tickChunkLimit,
    afterMessageId: args.afterMessageId,
    rebuild: args.rebuild,
  });
  console.log(stringify({ ok: true, result }));
}

function parseArgs(argv: string[]): {
  chat?: string;
  limitChunks?: number;
  afterMessageId?: number;
  rebuild?: boolean;
} {
  const result: {
    chat?: string;
    limitChunks?: number;
    afterMessageId?: number;
    rebuild?: boolean;
  } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--chat") {
      result.chat = argv[++index];
    } else if (arg === "--limit-chunks") {
      result.limitChunks = Number(argv[++index]);
    } else if (arg === "--after-message-id") {
      result.afterMessageId = Number(argv[++index]);
    } else if (arg === "--rebuild") {
      result.rebuild = true;
    }
  }
  return result;
}

main().catch((error) => {
  console.error("embed-index fatal:", error);
  process.exit(1);
});
