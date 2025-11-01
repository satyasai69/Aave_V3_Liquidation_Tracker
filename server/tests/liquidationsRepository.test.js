import { afterAll, beforeAll, beforeEach, describe, expect, test, } from "bun:test";
import { getLiquidationsCollection, closeMongoClient, } from "@/lib/db/client";
import { getRecentEvents, getSummary, insertLiquidation, getAssetDistribution, getTimeline, } from "@/lib/db/liquidationsRepository";
const baseEvent = {
    id: "0xdeadbeef-0",
    txHash: "0xdeadbeef",
    logIndex: 0,
    blockNumber: 1,
    blockTimestamp: Date.now(),
    collateralAsset: "0x0000000000000000000000000000000000000001",
    collateralSymbol: "USDC",
    collateralDecimals: 6,
    collateralAmountRaw: "1000000",
    collateralAmount: "1",
    collateralValueUsd: 1,
    debtAsset: "0x0000000000000000000000000000000000000002",
    debtSymbol: "USDT",
    debtDecimals: 6,
    debtToCoverRaw: "1000000",
    debtToCover: "1",
    debtValueUsd: 1,
    notionalUsd: 1,
    user: "0x0000000000000000000000000000000000000003",
    liquidator: "0x0000000000000000000000000000000000000004",
    receiveAToken: false,
};
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
    test.skip("skipping repository tests without MONGODB_URI", () => { });
}
beforeAll(async () => {
    if (!mongoUri)
        return;
    await closeMongoClient();
    await getLiquidationsCollection();
});
beforeEach(async () => {
    if (!mongoUri)
        return;
    const collection = await getLiquidationsCollection();
    await collection.deleteMany({});
});
describe("liquidations repository", () => {
    test("inserts and fetches liquidation data", async () => {
        if (!mongoUri) {
            return;
        }
        const inserted = await insertLiquidation(baseEvent);
        expect(inserted).toBeTrue();
        const recents = await getRecentEvents(5);
        expect(recents.length).toBe(1);
        expect(recents[0].id).toBe(baseEvent.id);
        const summary = await getSummary();
        expect(summary.totalLiquidations).toBe(1);
        expect(summary.totalDebtUsd).toBeCloseTo(1);
        const distribution = await getAssetDistribution();
        expect(distribution.length).toBe(1);
        expect(distribution[0].symbol).toBe("USDC");
        const timeline = await getTimeline(1);
        expect(timeline.length).toBeGreaterThan(0);
    });
    test("does not insert duplicates", async () => {
        if (!mongoUri)
            return;
        const firstInsert = await insertLiquidation(baseEvent);
        const secondInsert = await insertLiquidation(baseEvent);
        expect(firstInsert).toBeTrue();
        expect(secondInsert).toBeFalse();
        const collection = await getLiquidationsCollection();
        const count = await collection.countDocuments();
        expect(count).toBe(1);
    });
});
afterAll(async () => {
    if (!mongoUri)
        return;
    await closeMongoClient();
});
