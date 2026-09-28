import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { loadEnv, loadStrategiesFile } from "@aco/config";
import { AcoBot } from "./bot";
import { asLogger, createLogger } from "./logger";
import { buildServer } from "./server";

/** Repo root — apps/api/src/index.ts is three levels deep. */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

async function main(): Promise<void> {
  // Load .env from the repo root regardless of the workspace cwd.
  loadDotenv({ path: join(ROOT, ".env") });
  const env = loadEnv();
  const pino = createLogger(env.LOG_LEVEL);
  const logger = asLogger(pino);

  if (!env.DRY_RUN) {
    pino.warn(
      "DRY_RUN=false — the bot will broadcast REAL transactions. " +
        "Make sure PRIVATE_KEY belongs to a dedicated hot wallet.",
    );
  }
  if (env.PRIVATE_KEY) {
    pino.warn(
      "Hot-wallet mode: PRIVATE_KEY is loaded in memory. Never share " +
        "this key, never commit it, and keep the wallet minimally funded.",
    );
  }

  const strategiesPath = isAbsolute(env.STRATEGIES_FILE)
    ? env.STRATEGIES_FILE
    : resolve(ROOT, env.STRATEGIES_FILE);
  const strategies = loadStrategiesFile(strategiesPath, Object.keys(env.wallets));
  pino.info(
    { count: strategies.length, file: strategiesPath },
    "strategies loaded",
  );

  const bot = new AcoBot(env, strategies, logger);

  // A rejected promise in any async handler (mint path, monitor, API) must
  // not take the whole bot down — log it and keep running.
  process.on("unhandledRejection", (reason) => {
    pino.error({ err: reason }, "unhandled rejection — bot continues");
  });

  if (env.ACO_WIZARD && process.stdin.isTTY) {
    const { runWizard } = await import("./wizard");
    await runWizard(bot);
  }

  await bot.start();

  const app = buildServer(bot, env);
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  pino.info({ port: env.API_PORT }, "API listening");

  const shutdown = async (signal: string) => {
    pino.info({ signal }, "shutting down");
    await app.close();
    await bot.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
