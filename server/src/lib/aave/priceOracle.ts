import { getHttpClient } from "@/lib/aave/clients";
import {
  AAVE_V3_PRICE_ORACLE_ADDRESS,
} from "@/lib/aave/config";
import { getAddress } from "viem";
import type { Address, PublicClient } from "viem";

const PRICE_DECIMALS = 8n;
const priceCache = new Map<string, PriceEntry>();

type PriceEntry = {
  price: number;
  fetchedAt: number;
};

const TTL_MS = 60_000; // 60 seconds

const priceOracleAbi = [
  {
    type: "function",
    name: "getAssetPrice",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const toUsd = (rawPrice: bigint): number => {
  if (rawPrice === 0n) {
    return 0;
  }
  const price = Number(rawPrice) / 10 ** Number(PRICE_DECIMALS);
  return price;
};

const fetchAssetPrice = async (
  client: PublicClient,
  asset: Address,
): Promise<number> => {
  const rawPrice = await client.readContract({
    address: AAVE_V3_PRICE_ORACLE_ADDRESS,
    abi: priceOracleAbi,
    functionName: "getAssetPrice",
    args: [asset],
  });
  return toUsd(rawPrice);
};

export const getAssetUsdPrice = async (
  asset: `0x${string}`,
): Promise<number> => {
  const normalized = getAddress(asset);
  const now = Date.now();
  const cached = priceCache.get(normalized);
  if (cached && now - cached.fetchedAt < TTL_MS) {
    return cached.price;
  }

  const client = getHttpClient();
  const price = await fetchAssetPrice(client, normalized);

  priceCache.set(normalized, { price, fetchedAt: now });
  return price;
};
