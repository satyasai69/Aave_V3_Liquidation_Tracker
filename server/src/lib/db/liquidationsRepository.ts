import { getLiquidationsCollection } from "@/lib/db/client";
import type {
  AssetDistributionBucket,
  LiquidationSummary,
  MetricsSnapshot,
  NormalizedLiquidationEvent,
  TimelineBucket,
  TimeWindowStats,
} from "@/lib/types/liquidation";

const BUCKET_MINUTES = 30;
const BUCKET_MS = BUCKET_MINUTES * 60 * 1_000;

const toTimeWindowStats = (
  result:
    | {
        count?: number;
        debtUsd?: number;
        collateralUsd?: number;
        liquidators?: string[];
      }
    | undefined,
): TimeWindowStats => ({
  count: result?.count ?? 0,
  debtUsd: result?.debtUsd ?? 0,
  collateralUsd: result?.collateralUsd ?? 0,
  uniqueLiquidators: result?.liquidators?.length ?? 0,
});

export const insertLiquidation = async (
  event: NormalizedLiquidationEvent,
): Promise<boolean> => {
  const collection = await getLiquidationsCollection();
  const result = await collection.updateOne(
    { id: event.id },
    { $setOnInsert: event },
    { upsert: true },
  );

  return (result.upsertedCount ?? 0) > 0;
};

export const getRecentEvents = async (
  limit = 50,
): Promise<NormalizedLiquidationEvent[]> => {
  const collection = await getLiquidationsCollection();
  const cursor = collection
    .find({})
    .sort({ blockTimestamp: -1 })
    .limit(limit);

  return cursor.toArray();
};

export const getSummary = async (): Promise<LiquidationSummary> => {
  const collection = await getLiquidationsCollection();
  const now = Date.now();
  const lastHourBoundary = now - 60 * 60 * 1_000;
  const last24HoursBoundary = now - 24 * 60 * 60 * 1_000;

  const [overall, lastHour, last24Hours] = await Promise.all([
    collection
      .aggregate<{
        totalLiquidations: number;
        totalDebtUsd: number;
        totalCollateralUsd: number;
        lastLiquidationAt: number | null;
        borrowers: string[];
        liquidators: string[];
        collateralAssets: string[];
        debtAssets: string[];
      }>([
        {
          $group: {
            _id: null,
            totalLiquidations: { $sum: 1 },
            totalDebtUsd: { $sum: "$debtValueUsd" },
            totalCollateralUsd: { $sum: "$collateralValueUsd" },
            lastLiquidationAt: { $max: "$blockTimestamp" },
            borrowers: { $addToSet: "$user" },
            liquidators: { $addToSet: "$liquidator" },
            collateralAssets: { $addToSet: "$collateralAsset" },
            debtAssets: { $addToSet: "$debtAsset" },
          },
        },
      ])
      .next(),
    collection
      .aggregate<{
        count: number;
        debtUsd: number;
        collateralUsd: number;
        liquidators: string[];
      }>([
        { $match: { blockTimestamp: { $gte: lastHourBoundary } } },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            debtUsd: { $sum: "$debtValueUsd" },
            collateralUsd: { $sum: "$collateralValueUsd" },
            liquidators: { $addToSet: "$liquidator" },
          },
        },
      ])
      .next(),
    collection
      .aggregate<{
        count: number;
        debtUsd: number;
        collateralUsd: number;
        liquidators: string[];
      }>([
        { $match: { blockTimestamp: { $gte: last24HoursBoundary } } },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            debtUsd: { $sum: "$debtValueUsd" },
            collateralUsd: { $sum: "$collateralValueUsd" },
            liquidators: { $addToSet: "$liquidator" },
          },
        },
      ])
      .next(),
  ]);

  return {
    totalLiquidations: overall?.totalLiquidations ?? 0,
    uniqueBorrowers: overall?.borrowers?.length ?? 0,
    uniqueLiquidators: overall?.liquidators?.length ?? 0,
    uniqueCollateralAssets: overall?.collateralAssets?.length ?? 0,
    uniqueDebtAssets: overall?.debtAssets?.length ?? 0,
    totalDebtUsd: overall?.totalDebtUsd ?? 0,
    totalCollateralUsd: overall?.totalCollateralUsd ?? 0,
    lastLiquidationAt: overall?.lastLiquidationAt ?? null,
    lastHour: toTimeWindowStats(lastHour ?? undefined),
    last24Hours: toTimeWindowStats(last24Hours ?? undefined),
  };
};

export const getAssetDistribution = async (): Promise<
  AssetDistributionBucket[]
> => {
  const collection = await getLiquidationsCollection();
  const rows = await collection
    .aggregate<{
      _id: { asset: `0x${string}`; symbol: string };
      totalUsd: number;
    }>([
      {
        $group: {
          _id: {
            asset: "$collateralAsset",
            symbol: "$collateralSymbol",
          },
          totalUsd: { $sum: "$collateralValueUsd" },
        },
      },
      { $sort: { totalUsd: -1 } },
    ])
    .toArray();

  const totalUsd = rows.reduce(
    (sum, row) => sum + (row.totalUsd ?? 0),
    0,
  );

  return rows.map((row) => ({
    asset: row._id.asset,
    symbol: row._id.symbol,
    totalUsd: row.totalUsd ?? 0,
    share:
      totalUsd > 0 ? (row.totalUsd ?? 0) / totalUsd : 0,
  }));
};

export const getTimeline = async (
  hours = 24,
): Promise<TimelineBucket[]> => {
  const collection = await getLiquidationsCollection();
  const boundary = Date.now() - hours * 60 * 60 * 1_000;

  const rows = await collection
    .aggregate<{
      _id: number;
      liquidations: number;
      debtUsd: number;
      collateralUsd: number;
    }>([
      { $match: { blockTimestamp: { $gte: boundary } } },
      {
        $addFields: {
          bucketStart: {
            $multiply: [
              {
                $floor: {
                  $divide: ["$blockTimestamp", BUCKET_MS],
                },
              },
              BUCKET_MS,
            ],
          },
        },
      },
      {
        $group: {
          _id: "$bucketStart",
          liquidations: { $sum: 1 },
          debtUsd: { $sum: "$debtValueUsd" },
          collateralUsd: { $sum: "$collateralValueUsd" },
        },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray();

  return rows.map((row) => ({
    bucketStart: row._id,
    label: new Date(row._id).toISOString(),
    liquidations: row.liquidations ?? 0,
    debtUsd: row.debtUsd ?? 0,
    collateralUsd: row.collateralUsd ?? 0,
  }));
};

export const getSnapshot = async (
  limit = 50,
): Promise<MetricsSnapshot> => {
  const [summary, assetDistribution, timeline, recent] =
    await Promise.all([
      getSummary(),
      getAssetDistribution(),
      getTimeline(24),
      getRecentEvents(limit),
    ]);

  return {
    summary,
    assetDistribution,
    timeline,
    recent,
  };
};
