import { pino, type Logger as PinoLogger } from "pino";
import type { Logger } from "@aco/config";

export function createLogger(level: string): PinoLogger {
  return pino({
    level,
    base: { service: "aco-api" },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Defense in depth: never let a key reach the logs even by accident.
    redact: {
      paths: ["privateKey", "PRIVATE_KEY", "*.privateKey", "*.key"],
      censor: "[redacted]",
    },
  });
}

/** Adapt pino to the minimal Logger interface used by packages. */
export function asLogger(p: PinoLogger): Logger {
  return {
    debug: (o, m) => p.debug(o as object, m),
    info: (o, m) => p.info(o as object, m),
    warn: (o, m) => p.warn(o as object, m),
    error: (o, m) => p.error(o as object, m),
  };
}
