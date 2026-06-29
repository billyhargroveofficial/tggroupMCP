#!/usr/bin/env node
import input from "input";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { loadTelegramAuthConfig } from "./config.js";
import { StderrGramJsLogger } from "./gramjs-logger.js";

async function main(): Promise<void> {
  const telegram = loadTelegramAuthConfig({ requireApiCredentials: true });

  const client = new TelegramClient(new StringSession(telegram.session), telegram.apiId, telegram.apiHash, {
    connectionRetries: telegram.connectionRetries,
    baseLogger: new StderrGramJsLogger(),
  });

  await client.start({
    phoneNumber: async () => telegram.phone || input.text("Phone: "),
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
