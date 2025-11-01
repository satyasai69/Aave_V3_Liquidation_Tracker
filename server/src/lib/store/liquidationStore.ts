import EventEmitter from "events";
import type {
  MetricsSnapshot,
  NormalizedLiquidationEvent,
} from "@/lib/types/liquidation";
import {
  getAssetDistribution,
  getRecentEvents,
  getSnapshot,
  getSummary,
  getTimeline,
  insertLiquidation,
} from "@/lib/db/liquidationsRepository";

type Listener = (event: NormalizedLiquidationEvent) => void;

class LiquidationStore {
  private emitter = new EventEmitter();

  async addEvent(event: NormalizedLiquidationEvent): Promise<boolean> {
    const inserted = await insertLiquidation(event);
    if (inserted) {
      this.emitter.emit("event", event);
    }
    return inserted;
  }

  async getRecentEvents(limit = 50) {
    return getRecentEvents(limit);
  }

  async getSummary() {
    return getSummary();
  }

  async getAssetDistribution() {
    return getAssetDistribution();
  }

  async getTimeline(hours = 24) {
    return getTimeline(hours);
  }

  async getSnapshot(limit = 50): Promise<MetricsSnapshot> {
    return getSnapshot(limit);
  }

  subscribe(listener: Listener): () => void {
    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }
}

const globalStore = globalThis as unknown as {
  __aave_liquidation_store?: LiquidationStore;
};

export const liquidationStore =
  globalStore.__aave_liquidation_store ??
  (globalStore.__aave_liquidation_store = new LiquidationStore());
