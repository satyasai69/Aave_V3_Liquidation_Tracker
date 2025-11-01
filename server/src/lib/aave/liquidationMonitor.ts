import {
  AAVE_V3_MAINNET_POOL_ADDRESS,
  aavePoolAbi,
} from "@/lib/aave/config";
import { getHttpClient, getWebSocketClient } from "@/lib/aave/clients";
import { getTokenMetadata } from "@/lib/aave/tokenRegistry";
import { getAssetUsdPrice } from "@/lib/aave/priceOracle";
import { liquidationStore } from "@/lib/store/liquidationStore";
import type { NormalizedLiquidationEvent } from "@/lib/types/liquidation";
import { logger } from "@/lib/utils/logger";
import { parseAbiItem, formatUnits } from "viem";
import type {
  Address,
  Hex,
  WatchBlocksReturnType,
} from "viem";

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as const;
const BACKFILL_BLOCK_WINDOW = 4_000n;
const MAX_LOG_BLOCK_SPAN = 128n;
const RATE_LIMIT_BACKOFF_MS = 750;
const MAX_RATE_LIMIT_RETRIES = 5;
const LOG_FETCH_THROTTLE_MS = 125;

type ReserveMetadata = {
  underlying: Address;
  aToken?: Address;
  stableDebtToken?: Address;
  variableDebtToken?: Address;
};

type ReserveLookupCache = {
  byUnderlying: Map<string, ReserveMetadata>;
  byToken: Map<string, ReserveMetadata>;
  aTokenAddresses: Address[];
  debtTokenAddresses: Address[];
  underlyingAddresses: Address[];
};

type DebtBurnLog = {
  reserve: ReserveMetadata;
  borrower: Address;
  amount: bigint;
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  tokenAddress: Address;
};

type CollateralMovementLog = {
  reserve: ReserveMetadata;
  from: Address;
  to: Address;
  amount: bigint;
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  tokenAddress: Address;
  type: "aToken" | "underlying";
};

type TxAggregate = {
  blockNumber: bigint;
  debtBurns: DebtBurnLog[];
  collateralMovements: CollateralMovementLog[];
};

type TransferLog = {
  address: Address;
  transactionHash: Hex | null | undefined;
  logIndex: number | null;
  blockNumber: bigint | null;
  args?: {
    from: Address;
    to: Address;
    value: bigint;
  } | null;
};

type ReserveAddresses = {
  aTokenAddress: Address;
  stableDebtTokenAddress: Address;
  variableDebtTokenAddress: Address;
};

class ReserveLookup {
  private cache: ReserveLookupCache | null = null;
  private refreshing: Promise<ReserveLookupCache> | null = null;

  async get(): Promise<ReserveLookupCache> {
    if (this.cache) {
      return this.cache;
    }

    if (!this.refreshing) {
      this.refreshing = this.refresh();
    }

    const value = await this.refreshing;
    this.cache = value;
    this.refreshing = null;
    return value;
  }

  async refresh(): Promise<ReserveLookupCache> {
    logger.info("[LiquidationMonitor] refreshing reserve metadata");
    const client = getHttpClient();
    const reserves = (await client.readContract({
      address: AAVE_V3_MAINNET_POOL_ADDRESS,
      abi: aavePoolAbi,
      functionName: "getReservesList",
    })) as Address[];

    const meta = await Promise.all(
      reserves.map(async (underlying) => {
        const underlyingKey = normalize(underlying);
        const reserveDataRaw = await client.readContract({
          address: AAVE_V3_MAINNET_POOL_ADDRESS,
          abi: aavePoolAbi,
          functionName: "getReserveData",
          args: [underlying],
        });

        const reserveData = extractReserveAddresses(reserveDataRaw);

        if (!reserveData) {
          logger.warn(
            { reserve: underlying },
            "[LiquidationMonitor] missing reserve data, using fallback calls",
          );
          return this.fetchReserveTokensFallback(client, underlying);
        }

        const {
          aTokenAddress,
          stableDebtTokenAddress,
          variableDebtTokenAddress,
        } = reserveData;

        return {
          underlying,
          aToken: aTokenAddress !== ZERO_ADDRESS ? aTokenAddress : undefined,
          stableDebtToken:
            stableDebtTokenAddress !== ZERO_ADDRESS
              ? stableDebtTokenAddress
              : undefined,
          variableDebtToken:
            variableDebtTokenAddress !== ZERO_ADDRESS
              ? variableDebtTokenAddress
              : undefined,
        } satisfies ReserveMetadata;
      }),
    );

    const byUnderlying = new Map<string, ReserveMetadata>();
    const byToken = new Map<string, ReserveMetadata>();
    const aTokenAddresses: Address[] = [];
    const debtTokenAddresses: Address[] = [];
    const underlyingAddresses: Address[] = [];

    for (const reserve of meta) {
      const key = normalize(reserve.underlying);
      byUnderlying.set(key, reserve);
      underlyingAddresses.push(reserve.underlying);

      if (reserve.aToken) {
        byToken.set(normalize(reserve.aToken), reserve);
        aTokenAddresses.push(reserve.aToken);
      }
      if (reserve.stableDebtToken) {
        byToken.set(normalize(reserve.stableDebtToken), reserve);
        debtTokenAddresses.push(reserve.stableDebtToken);
      }
      if (reserve.variableDebtToken) {
        byToken.set(normalize(reserve.variableDebtToken), reserve);
        debtTokenAddresses.push(reserve.variableDebtToken);
      }
    }

    logger.info(
      {
        reserveCount: meta.length,
      },
      "[LiquidationMonitor] refreshed reserve metadata",
    );

    return {
      byUnderlying,
      byToken,
      aTokenAddresses,
      debtTokenAddresses,
      underlyingAddresses,
    };
  }

  private async fetchReserveTokensFallback(
    client: ReturnType<typeof getHttpClient>,
    underlying: Address,
  ): Promise<ReserveMetadata> {
    try {
      const [aTokenAddress, variableDebtTokenAddress] = await Promise.all([
        client.readContract({
          address: AAVE_V3_MAINNET_POOL_ADDRESS,
          abi: aavePoolAbi,
          functionName: "getReserveAToken",
          args: [underlying],
        }) as Promise<Address>,
        client.readContract({
          address: AAVE_V3_MAINNET_POOL_ADDRESS,
          abi: aavePoolAbi,
          functionName: "getReserveVariableDebtToken",
          args: [underlying],
        }) as Promise<Address>,
      ]);

      return {
        underlying,
        aToken: aTokenAddress !== ZERO_ADDRESS ? aTokenAddress : undefined,
        variableDebtToken:
          variableDebtTokenAddress !== ZERO_ADDRESS
            ? variableDebtTokenAddress
            : undefined,
      };
    } catch (error) {
      logger.error(
        { err: error, reserve: underlying },
        "[LiquidationMonitor] fallback reserve metadata fetch failed",
      );
      return { underlying };
    }
  }
}

const reserveLookup = new ReserveLookup();

const normalize = (address: Address): string => address.toLowerCase();

const extractReserveAddresses = (
  raw: unknown,
): ReserveAddresses | null => {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const source =
    "res" in raw && raw.res && typeof raw.res === "object"
      ? raw.res
      : raw;

  if (
    source &&
    typeof source === "object" &&
    "aTokenAddress" in source &&
    "stableDebtTokenAddress" in source &&
    "variableDebtTokenAddress" in source
  ) {
    const { aTokenAddress, stableDebtTokenAddress, variableDebtTokenAddress } =
      source as {
        aTokenAddress: Address;
        stableDebtTokenAddress: Address;
        variableDebtTokenAddress: Address;
      };
    return {
      aTokenAddress,
      stableDebtTokenAddress,
      variableDebtTokenAddress,
    };
  }

  return null;
};

class LiquidationMonitor {
  private backfilled = false;
  private running = false;
  private blockTimestamps = new Map<bigint, number>();
  private unsubscribe: WatchBlocksReturnType | null = null;
  private lastProcessedBlock: bigint | null = null;
  private processing: Promise<void> = Promise.resolve();

  async start() {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      await reserveLookup.get();
      await this.backfill();
      await this.watch();
      logger.info("[LiquidationMonitor] started.");
    } catch (error) {
      logger.error(
        { err: error },
        "[LiquidationMonitor] failed to start",
      );
      this.running = false;
    }
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.running = false;
    logger.info("[LiquidationMonitor] stopped.");
  }

  isRunning() {
    return this.running;
  }

  private async backfill() {
    if (this.backfilled) {
      return;
    }

    const client = getHttpClient();
    const latestBlock = await client.getBlockNumber();
    const fromBlock =
      latestBlock > BACKFILL_BLOCK_WINDOW
        ? latestBlock - BACKFILL_BLOCK_WINDOW
        : 0n;

    logger.info(
      `[LiquidationMonitor] backfilling from block ${fromBlock} to ${latestBlock}`,
    );

    await this.processRange(fromBlock, latestBlock);

    this.backfilled = true;
    this.lastProcessedBlock = latestBlock;
    logger.info("[LiquidationMonitor] backfill complete");
  }

  private async watch() {
    const wsClient = getWebSocketClient();
    const client = wsClient ?? getHttpClient();

    if (this.lastProcessedBlock === null) {
      this.lastProcessedBlock = await client.getBlockNumber();
    }

    this.unsubscribe = client.watchBlocks({
      emitMissed: true,
      pollingInterval: wsClient ? undefined : 12_000,
      onError: (error) => {
        logger.error({ err: error }, "[LiquidationMonitor] block watcher error");
      },
      onBlock: (block) => {
        if (!block.number) {
          return;
        }

        const toBlock = block.number;
        const fromBlock =
          this.lastProcessedBlock !== null
            ? this.lastProcessedBlock + 1n
            : toBlock;

        if (fromBlock > toBlock) {
          this.lastProcessedBlock = toBlock;
          return;
        }

        this.processing = this.processing
          .catch(() => {})
          .then(async () => {
            await this.processRange(fromBlock, toBlock);
            this.lastProcessedBlock = toBlock;
          })
          .catch((error) => {
            logger.error(
              { err: error },
              "[LiquidationMonitor] failed to process block range",
            );
          });
      },
    });
  }

  private async processRange(fromBlock: bigint, toBlock: bigint) {
    const lookup = await reserveLookup.get();
    const client = getHttpClient();

    const debtLogs = await this.fetchLogs(
      client,
      lookup.debtTokenAddresses,
      fromBlock,
      toBlock,
    );
    const aTokenLogs = await this.fetchLogs(
      client,
      lookup.aTokenAddresses,
      fromBlock,
      toBlock,
    );
    const underlyingLogs = await this.fetchLogs(
      client,
      lookup.underlyingAddresses,
      fromBlock,
      toBlock,
    );

    if (
      debtLogs.length === 0 &&
      aTokenLogs.length === 0 &&
      underlyingLogs.length === 0
    ) {
      return;
    }

    const aggregates = new Map<Hex, TxAggregate>();

    const ensureAggregate = (log: TransferLog) => {
      if (!log.transactionHash || log.logIndex == null || log.blockNumber == null) {
        return null;
      }

      let aggregate = aggregates.get(log.transactionHash);
      if (!aggregate) {
        aggregate = {
          blockNumber: log.blockNumber,
          debtBurns: [],
          collateralMovements: [],
        };
        aggregates.set(log.transactionHash, aggregate);
      }
      return aggregate;
    };

    const addDebtLog = (log: TransferLog) => {
      if (!log.args || !log.transactionHash || log.logIndex == null || log.blockNumber == null) {
        return;
      }

      const reserve = lookup.byToken.get(normalize(log.address));
      if (!reserve) return;
      if (log.args.to !== ZERO_ADDRESS) return;

      const aggregate = ensureAggregate(log);
      if (!aggregate) return;

      aggregate.debtBurns.push({
        reserve,
        borrower: log.args.from,
        amount: log.args.value,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        blockNumber: log.blockNumber,
        tokenAddress: log.address,
      });
    };

    const addCollateralLog = (log: TransferLog, type: "aToken" | "underlying") => {
      if (!log.args || !log.transactionHash || log.logIndex == null || log.blockNumber == null) {
        return;
      }

      const reserveLookup =
        type === "underlying" ? lookup.byUnderlying : lookup.byToken;
      const reserve = reserveLookup.get(normalize(log.address));
      if (!reserve) return;

      if (
        type === "underlying" &&
        normalize(log.args.from) !== normalize(AAVE_V3_MAINNET_POOL_ADDRESS)
      ) {
        return;
      }

      const aggregate = ensureAggregate(log);
      if (!aggregate) return;

      aggregate.collateralMovements.push({
        reserve,
        from: log.args.from,
        to: log.args.to,
        amount: log.args.value,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        blockNumber: log.blockNumber,
        tokenAddress: log.address,
        type,
      });
    };

    debtLogs.forEach(addDebtLog);
    aTokenLogs.forEach(log => addCollateralLog(log, "aToken"));
    underlyingLogs.forEach(log => addCollateralLog(log, "underlying"));

    for (const aggregate of aggregates.values()) {
      await this.constructEvents(aggregate);
    }
  }

  private async fetchLogs(
    client: ReturnType<typeof getHttpClient>,
    addresses: Address[],
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<TransferLog[]> {
    if (addresses.length === 0 || fromBlock > toBlock) {
      return [];
    }

    const logs: TransferLog[] = [];
    let currentFrom = fromBlock;

    while (currentFrom <= toBlock) {
      const { records, nextFrom } = await this.fetchLogChunk(
        client,
        addresses,
        currentFrom,
        toBlock,
        MAX_LOG_BLOCK_SPAN,
      );
      logs.push(...records);
      currentFrom = nextFrom;
    }

    return logs;
  }

  private async fetchLogChunk(
    client: ReturnType<typeof getHttpClient>,
    addresses: Address[],
    fromBlock: bigint,
    finalToBlock: bigint,
    span: bigint,
    attempt = 0,
  ): Promise<{ records: TransferLog[]; nextFrom: bigint }> {
    const toBlockCandidate = fromBlock + span - 1n;
    const toBlock =
      toBlockCandidate > finalToBlock ? finalToBlock : toBlockCandidate;

    try {
      const records = (await client.getLogs({
        address: addresses,
        event: TRANSFER_EVENT,
        fromBlock,
        toBlock,
      })) as TransferLog[];

      if (LOG_FETCH_THROTTLE_MS > 0 && toBlock < finalToBlock) {
        await sleep(LOG_FETCH_THROTTLE_MS);
      }

      const nextFrom =
        toBlock >= finalToBlock ? finalToBlock + 1n : toBlock + 1n;
      return { records, nextFrom };
    } catch (error) {
      if (this.isRateLimitError(error)) {
        if (attempt >= MAX_RATE_LIMIT_RETRIES) {
          throw error;
        }

        const delay = RATE_LIMIT_BACKOFF_MS * (attempt + 1);
        const nextSpan = span > 1n ? span / 2n : span;
        logger.debug(
          {
            fromBlock,
            attemptedToBlock: toBlock,
            span,
            nextSpan,
            delay,
            attempt,
          },
          "[LiquidationMonitor] rate limited fetching logs, backing off",
        );
        await sleep(delay);
        return this.fetchLogChunk(
          client,
          addresses,
          fromBlock,
          finalToBlock,
          nextSpan,
          attempt + 1,
        );
      }

      if (span <= 1n || !this.isLogLimitError(error)) {
        throw error;
      }

      const nextSpan = span / 2n;
      if (nextSpan < 1n) {
        throw error;
      }

      logger.debug(
        {
          fromBlock,
          attemptedToBlock: toBlock,
          retrySpan: nextSpan,
        },
        "[LiquidationMonitor] retrying log fetch with smaller block span",
      );

      return this.fetchLogChunk(
        client,
        addresses,
        fromBlock,
        finalToBlock,
        nextSpan,
        attempt,
      );
    }
  }

  private isLogLimitError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }

    const candidate = error as {
      name?: string;
      message?: string;
      shortMessage?: string;
      code?: number;
    };

    const message = `${candidate.shortMessage ?? candidate.message ?? ""}`;
    return (
      candidate.code === -32005 ||
      candidate.name === "LimitExceededRpcError" ||
      message.includes("Request exceeds defined limit") ||
      message.includes("query returned more than 10000")
    );
  }

  private isRateLimitError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }

    const candidate = error as {
      status?: number;
      body?: { error?: { code?: number } };
      code?: number;
      message?: string;
      shortMessage?: string;
    };

    if (candidate.status === 429) {
      return true;
    }

    const code =
      candidate.code ??
      candidate.body?.error?.code ??
      (typeof candidate.status === "number" ? candidate.status : undefined);

    const message = `${candidate.shortMessage ?? candidate.message ?? ""}`;

    return (
      code === 429 ||
      message.includes("Too Many Requests") ||
      message.includes("rate limit")
    );
  }

  private async constructEvents(aggregate: TxAggregate) {
    const usedCollateral = new Set<string>();
    const usedUnderlying = new Set<string>();

    for (const debtBurn of aggregate.debtBurns) {
      const borrowerMovements = aggregate.collateralMovements.filter(
        (movement) =>
          movement.type === "aToken" &&
          movement.reserve === debtBurn.reserve &&
          movement.from === debtBurn.borrower &&
          !usedCollateral.has(
            `${movement.tokenAddress}-${movement.logIndex}`,
          ),
      );

      if (borrowerMovements.length === 0) {
        logger.debug(
          {
            txHash: debtBurn.txHash,
            borrower: debtBurn.borrower,
          },
          "[LiquidationMonitor] unable to match aToken burn for debt burn",
        );
        continue;
      }

      const rewardATokenMovement = borrowerMovements.find(
        (movement) => normalize(movement.to) !== ZERO_ADDRESS,
      );

      const primaryATokenMovement =
        rewardATokenMovement ?? borrowerMovements[0];

      for (const movement of borrowerMovements) {
        usedCollateral.add(
          `${movement.tokenAddress}-${movement.logIndex}`,
        );
      }

      const candidateUnderlying = aggregate.collateralMovements.find(
        (movement) =>
          movement.type === "underlying" &&
          movement.reserve === primaryATokenMovement.reserve &&
          movement.txHash === debtBurn.txHash &&
          !usedUnderlying.has(
            `${movement.tokenAddress}-${movement.logIndex}`,
          ),
      );

      if (candidateUnderlying) {
        usedUnderlying.add(
          `${candidateUnderlying.tokenAddress}-${candidateUnderlying.logIndex}`,
        );
      }

      await this.emitLiquidationEvent({
        debtBurn,
        collateralMovement: primaryATokenMovement,
        underlyingMovement: candidateUnderlying ?? null,
        rewardMovement:
          candidateUnderlying ??
          rewardATokenMovement ??
          null,
      });
    }
  }

  private async emitLiquidationEvent({
    debtBurn,
    collateralMovement,
    underlyingMovement,
    rewardMovement,
  }: {
    debtBurn: DebtBurnLog;
    collateralMovement: CollateralMovementLog;
    underlyingMovement: CollateralMovementLog | null;
    rewardMovement: CollateralMovementLog | null;
  }) {
    try {
      const blockTimestamp = await this.getBlockTimestamp(
        debtBurn.blockNumber,
      );

      const [collateralMetadata, debtMetadata] = await Promise.all([
        getTokenMetadata(collateralMovement.reserve.underlying),
        getTokenMetadata(debtBurn.reserve.underlying),
      ]);

      const [collateralPrice, debtPrice] = await Promise.all([
        getAssetUsdPrice(collateralMovement.reserve.underlying),
        getAssetUsdPrice(debtBurn.reserve.underlying),
      ]);

      const collateralRaw = underlyingMovement
        ? underlyingMovement.amount
        : collateralMovement.amount;

      const collateralAmount = formatUnits(
        collateralRaw,
        collateralMetadata.decimals,
      );
      const debtAmount = formatUnits(
        debtBurn.amount,
        debtMetadata.decimals,
      );

      const collateralValueUsd =
        parseFloat(collateralAmount) * collateralPrice;
      const debtValueUsd = parseFloat(debtAmount) * debtPrice;

      const movementWithLiquidator =
        underlyingMovement ?? rewardMovement ?? collateralMovement;

      const rawLiquidator = movementWithLiquidator.from;
      const resolvedLiquidator =
        normalize(rawLiquidator) !== ZERO_ADDRESS
          ? rawLiquidator
          : movementWithLiquidator.to;

      const event: NormalizedLiquidationEvent = {
        id: `${debtBurn.txHash}-${debtBurn.logIndex}`,
        txHash: debtBurn.txHash,
        logIndex: debtBurn.logIndex,
        blockNumber: Number(debtBurn.blockNumber),
        blockTimestamp,
        collateralAsset: collateralMovement.reserve.underlying,
        collateralSymbol: collateralMetadata.symbol,
        collateralDecimals: collateralMetadata.decimals,
        collateralAmountRaw: collateralRaw.toString(),
        collateralAmount,
        collateralValueUsd,
        debtAsset: debtBurn.reserve.underlying,
        debtSymbol: debtMetadata.symbol,
        debtDecimals: debtMetadata.decimals,
        debtToCoverRaw: debtBurn.amount.toString(),
        debtToCover: debtAmount,
        debtValueUsd,
        notionalUsd: Math.max(collateralValueUsd, debtValueUsd),
        user: debtBurn.borrower,
        liquidator: resolvedLiquidator,
        receiveAToken:
          underlyingMovement === null &&
          rewardMovement?.type === "aToken" &&
          normalize(resolvedLiquidator) !== ZERO_ADDRESS,
      };

      const inserted = await liquidationStore.addEvent(event);
      if (inserted) {
        logger.info(
          {
            eventId: event.id,
            txHash: event.txHash,
            user: event.user,
            liquidator: event.liquidator,
            collateral: {
              asset: event.collateralAsset,
              amount: event.collateralAmount,
              usd: event.collateralValueUsd,
            },
            debt: {
              asset: event.debtAsset,
              amount: event.debtToCover,
              usd: event.debtValueUsd,
            },
          },
          "[LiquidationMonitor] processed liquidation event",
        );
      }
    } catch (error) {
      logger.error(
        {
          err: error,
          txHash: debtBurn.txHash,
        },
        "[LiquidationMonitor] failed to emit liquidation event",
      );
    }
  }

  private async getBlockTimestamp(blockNumber: bigint): Promise<number> {
    const cached = this.blockTimestamps.get(blockNumber);
    if (cached) {
      return cached;
    }

    const block = await getHttpClient().getBlock({ blockNumber });
    const timestamp = Number(block.timestamp) * 1_000;
    this.blockTimestamps.set(blockNumber, timestamp);

    if (this.blockTimestamps.size > 1_000) {
      const keys = Array.from(this.blockTimestamps.keys()).sort(
        (a, b) => Number(a - b),
      );
      const excess = keys.length - 1_000;
      keys.slice(0, excess).forEach((key) => this.blockTimestamps.delete(key));
    }

    return timestamp;
  }
}

const globalMonitor = globalThis as unknown as {
  __aave_liquidation_monitor?: LiquidationMonitor;
};

export const liquidationMonitor =
  globalMonitor.__aave_liquidation_monitor ??
  (globalMonitor.__aave_liquidation_monitor = new LiquidationMonitor());
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
