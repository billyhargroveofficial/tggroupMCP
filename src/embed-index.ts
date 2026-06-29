#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { stringify } from "./json.js";
import { MessageStore } from "./store.js";
import { embeddingEstimateRequiresConfirmation, VectorRag } from "./vector-rag.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new MessageStore(config.storage.dbPath);
  const vectorRag = new VectorRag(config, store);
  const args = parseArgs(process.argv.slice(2));
  const chatId = args.chat || config.telegram.defaultChatId;
  const estimate = vectorRag.estimateIndexCachedMessages({
    chatId,
    limitChunks: args.limitChunks ?? config.embeddings.tickChunkLimit,
    afterMessageId: args.afterMessageId,
    rebuild: args.rebuild,
  });
  const requiresConfirmation = embeddingEstimateRequiresConfirmation(estimate, args.confirmEstimate ?? false);
  if (args.estimateOnly || requiresConfirmation) {
    console.log(
      stringify({
        ok: true,
        status: args.estimateOnly ? "estimate_only" : "requires_confirmation",
        estimate,
        requires_confirmation: requiresConfirmation,
        result: null,
      }),
    );
    return;
  }

  const result = await vectorRag.indexCachedMessages({
    chatId,
    limitChunks: args.limitChunks ?? config.embeddings.tickChunkLimit,
    afterMessageId: args.afterMessageId,
    rebuild: args.rebuild,
    confirmFirstRun: args.confirmEstimate,
  });
  console.log(stringify({ ok: true, status: "indexed", estimate, requires_confirmation: false, result }));
}

function parseArgs(argv: string[]): {
  chat?: string;
  limitChunks?: number;
  afterMessageId?: number;
  rebuild?: boolean;
  estimateOnly?: boolean;
  confirmEstimate?: boolean;
} {
  const result: {
    chat?: string;
    limitChunks?: number;
    afterMessageId?: number;
    rebuild?: boolean;
    estimateOnly?: boolean;
    confirmEstimate?: boolean;
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
    } else if (arg === "--estimate-only") {
      result.estimateOnly = true;
    } else if (arg === "--confirm-estimate") {
      result.confirmEstimate = true;
    }
  }
  return result;
}

main().catch((error) => {
  console.error("embed-index fatal:", error);
  process.exit(1);
});
