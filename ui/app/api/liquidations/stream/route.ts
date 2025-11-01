import { NextRequest } from "next/server";
import { getSnapshot, getLiquidationsCollectionDirect } from "@/lib/liquidations";
import type { ChangeStream } from "mongodb";
import type { NormalizedLiquidationEvent } from "@/types/liquidation";

export const revalidate = 0;

const encoder = new TextEncoder();

const toSSE = (event: string, payload: unknown) =>
  encoder.encode(
    `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
  );

export async function GET(request: NextRequest) {
  const controller = new AbortController();
  const { signal } = request;

  signal.addEventListener("abort", () => {
    controller.abort();
  });

  const collection = await getLiquidationsCollectionDirect();
  let changeStream: ChangeStream<NormalizedLiquidationEvent> | null =
    null;
  let closed = false;

  const closeStream = async () => {
    if (closed) return;
    closed = true;
    await changeStream?.close().catch(() => {});
  };

  const stream = new ReadableStream({
    async start(streamController) {
      const snapshot = await getSnapshot();
      streamController.enqueue(toSSE("snapshot", snapshot));

      changeStream = collection.watch(
        [
          {
            $match: {
              operationType: "insert",
            },
          },
        ],
        {
          fullDocument: "updateLookup",
          maxAwaitTimeMS: 10_000,
        },
      );

      const pump = async () => {
        if (!changeStream) {
          return;
        }
        try {
          while (await changeStream.hasNext()) {
            const change = await changeStream.next();
            if (!change?.fullDocument) continue;
            streamController.enqueue(
              toSSE("liquidation", change.fullDocument),
            );
          }
        } catch (error) {
          if (!(error instanceof Error && error.name === "AbortError")) {
            await closeStream();
            streamController.error(error);
          }
        }
      };

      pump().catch((error) => {
        closeStream().finally(() => {
          streamController.error(error);
        });
      });

      signal.addEventListener(
        "abort",
        async () => {
          await closeStream();
          try {
            streamController.close();
          } catch {
            // already closed
          }
        },
        { once: true },
      );
    },
    async cancel() {
      await closeStream();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
