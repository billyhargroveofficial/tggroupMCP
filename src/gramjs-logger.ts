import { Logger, LogLevel } from "telegram/extensions/Logger.js";

export class StderrGramJsLogger extends Logger {
  constructor(level: LogLevel = LogLevel.WARN) {
    super(level);
  }

  override log(level: LogLevel, message: string): void {
    console.error(`[gramjs:${level}] ${message}`);
  }
}
