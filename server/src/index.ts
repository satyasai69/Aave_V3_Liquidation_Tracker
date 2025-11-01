import { serve } from "@hono/node-server";
import app from "@/lib/api/app";
import { getLiquidationsCollection } from "@/lib/db/client";
import { getEnv } from "@/lib/utils/env";
import { logger } from "@/lib/utils/logger";

const start = async () => {
  const { SERVER_PORT } = getEnv();

  await getLiquidationsCollection();

  serve({
    fetch: app.fetch,
    port: SERVER_PORT,
  });

  logger.info(
    `[Server] listening on http://localhost:${SERVER_PORT}`,
  );
};

start().catch((error) => {
  logger.error({ err: error }, "[Server] failed to start");
  process.exitCode = 1;
});
