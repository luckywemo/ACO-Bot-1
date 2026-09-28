/** Minimal structured logger interface shared across packages. */
export interface Logger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Silent logger used as a default in libraries and tests. */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Human-readable console logger (used when pino is not wired in). */
export const consoleLogger: Logger = {
  debug: (o, m) => console.debug(m ?? "", o ?? ""),
  info: (o, m) => console.info(m ?? "", o ?? ""),
  warn: (o, m) => console.warn(m ?? "", o ?? ""),
  error: (o, m) => console.error(m ?? "", o ?? ""),
};
