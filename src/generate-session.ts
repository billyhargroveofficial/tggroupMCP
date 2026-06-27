#!/usr/bin/env node
import "dotenv/config";
import input from "input";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { StderrGramJsLogger } from "./gramjs-logger.js";

async function main(): Promise<void> {
  const apiId = Number(process.env.TELEGRAM_API_ID || process.env.API_ID || 0);
  const apiHash = process.env.TELEGRAM_API_HASH || process.env.API_HASH || "";
  const phone = process.env.TELEGRAM_PHONE || process.env.PHONE || "";
  const currentSession = process.env.TELEGRAM_SESSION || process.env.SESSION || "";

  if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) {
    throw new Error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env first.");
  }

  const client = new TelegramClient(new StringSession(currentSession), apiId, apiHash, {
    connectionRetries: 5,
    baseLogger: new StderrGramJsLogger(),
  });

  await client.start({
    phoneNumber: async () => phone || input.text("Phone: "),
    password: async () => input.text("2FA password: "),
    phoneCode: async () => input.text("Telegram code: "),
    onError: (error) => console.error("Telegram auth error:", error),
  });

  console.log("\nPut this into .env as TELEGRAM_SESSION:");
  console.log(client.session.save());
  await client.disconnect();
}

main().catch((error) => {
  console.error("generate-session fatal:", error);
  process.exit(1);
});
