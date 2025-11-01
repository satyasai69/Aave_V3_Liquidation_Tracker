export type NormalizedLiquidationEvent = {
  id: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTimestamp: number;
  collateralAsset: `0x${string}`;
  collateralSymbol: string;
  collateralDecimals: number;
  collateralAmountRaw: string;
  collateralAmount: string;
  collateralValueUsd: number;
  debtAsset: `0x${string}`;
  debtSymbol: string;
  debtDecimals: number;
  debtToCoverRaw: string;
  debtToCover: string;
  debtValueUsd: number;
  notionalUsd: number;
  user: `0x${string}`;
  liquidator: `0x${string}`;
  receiveAToken: boolean;
};

export type LiquidationSummary = {
  totalLiquidations: number;
  uniqueBorrowers: number;
  uniqueLiquidators: number;
  uniqueCollateralAssets: number;
  uniqueDebtAssets: number;
  totalDebtUsd: number;
  totalCollateralUsd: number;
  lastLiquidationAt: number | null;
  lastHour: TimeWindowStats;
  last24Hours: TimeWindowStats;
};

export type TimeWindowStats = {
  count: number;
  debtUsd: number;
  collateralUsd: number;
  uniqueLiquidators: number;
};

export type AssetDistributionBucket = {
  asset: `0x${string}`;
  symbol: string;
  totalUsd: number;
  share: number;
};

export type TimelineBucket = {
  bucketStart: number;
  label: string;
  liquidations: number;
  debtUsd: number;
  collateralUsd: number;
};

export type MetricsSnapshot = {
  summary: LiquidationSummary;
  assetDistribution: AssetDistributionBucket[];
  timeline: TimelineBucket[];
  recent: NormalizedLiquidationEvent[];
};
