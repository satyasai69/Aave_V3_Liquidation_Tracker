import { liquidationStore } from "@/lib/store/liquidationStore";
import { liquidationMonitor } from "@/lib/aave/liquidationMonitor";
import type { MetricsSnapshot } from "@/lib/types/liquidation";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { getEnv } from "@/lib/utils/env";
import { logger } from "@/lib/utils/logger";

import "@/lib/bootstrap/startMonitor";

const limitSchema = z
  .string()
  .regex(/^\d+$/)
  .transform((value) => Math.min(Math.max(parseInt(value, 10), 1), 200));

const hoursSchema = z
  .string()
  .regex(/^\d+$/)
  .transform((value) => Math.min(Math.max(parseInt(value, 10), 1), 168));

const { UI_ORIGIN } = getEnv();

const app = new Hono().basePath("/");

app.use(
  "/*",
  cors({
    origin: UI_ORIGIN ?? "*",
    allowHeaders: ["Content-Type"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  }),
);

app.get("/health", (c) =>
  c.json({
    status: "ok",
    monitorRunning: liquidationMonitor.isRunning(),
    timestamp: Date.now(),
  }),
);

app.get("/liquidations/summary", async (c) =>
  c.json(await liquidationStore.getSummary()),
);

app.get("/liquidations/recent", async (c) => {
  const limitParam = c.req.query("limit");
  const limitResult = limitParam
    ? limitSchema.safeParse(limitParam)
    : { success: true, data: 50 } as const;

  if (!limitResult.success) {
    return c.json({ error: "Invalid limit parameter" }, 400);
  }

  return c.json({
    events: await liquidationStore.getRecentEvents(limitResult.data),
  });
});

app.get("/liquidations/distribution", async (c) =>
  c.json({ buckets: await liquidationStore.getAssetDistribution() }),
);

app.get("/liquidations/timeline", async (c) => {
  const hoursParam = c.req.query("hours");
  const hoursResult = hoursParam
    ? hoursSchema.safeParse(hoursParam)
    : { success: true, data: 24 } as const;

  if (!hoursResult.success) {
    return c.json({ error: "Invalid hours parameter" }, 400);
  }

  return c.json({ buckets: await liquidationStore.getTimeline(hoursResult.data) });
});

app.get("/liquidations/snapshot", async (c) => {
  const limitParam = c.req.query("limit");
  const limitResult = limitParam
    ? limitSchema.safeParse(limitParam)
    : { success: true, data: 50 } as const;

  if (!limitResult.success) {
    return c.json({ error: "Invalid limit parameter" }, 400);
  }

  return c.json(await liquidationStore.getSnapshot(limitResult.data));
});

app.get("/liquidations/stream", (c) =>
  streamSSE(c, async (stream) => {
    let active = true;
    let unsubscribe: (() => void) | null = null;

    const cleanup = () => {
      if (!active) {
        return;
      }
      active = false;
      unsubscribe?.();
    };

    const sendSnapshot = (snapshot: MetricsSnapshot) =>
      stream.writeSSE({
        event: "snapshot",
        data: JSON.stringify(snapshot),
      });

    await sendSnapshot(await liquidationStore.getSnapshot());

    unsubscribe = liquidationStore.subscribe((event) => {
      if (!active) return;
      stream
        .writeSSE({
          event: "liquidation",
          data: JSON.stringify(event),
        })
        .catch((error) => {
          logger.error(
            { err: error },
            "[Hono] Failed to push SSE payload",
          );
        });
    });

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        cleanup();
        resolve();
      });
    });
  }),
);

export default app;
