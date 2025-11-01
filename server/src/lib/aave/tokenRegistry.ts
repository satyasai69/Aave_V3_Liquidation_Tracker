import { getHttpClient } from "@/lib/aave/clients";
import { logger } from "@/lib/utils/logger";
import { erc20Abi } from "viem";

const metadataCache = new Map<string, TokenMetadata>();
const pendingCache = new Map<string, Promise<TokenMetadata>>();

export type TokenMetadata = {
  address: `0x${string}`;
  symbol: string;
  name: string;
  decimals: number;
};

const defaultMetadata: TokenMetadata = {
  address: "0x0000000000000000000000000000000000000000",
  symbol: "UNKNOWN",
  name: "Unknown",
  decimals: 18,
};

const fetchTokenMetadata = async (
  address: `0x${string}`,
): Promise<TokenMetadata> => {
  const client = getHttpClient();
  try {
    const [rawSymbol, rawName, decimals] = await Promise.all([
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "symbol",
      }),
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "name",
      }),
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "decimals",
      }),
    ]);

    const symbol =
      typeof rawSymbol === "string" && rawSymbol.length > 0
        ? rawSymbol.trim()
        : "UNKNOWN";
    const name =
      typeof rawName === "string" && rawName.length > 0
        ? rawName.trim()
        : symbol;

    return {
      address,
      symbol,
      name,
      decimals: Number(decimals),
    };
  } catch (error) {
    logger.warn(
      { err: error },
      `[TokenRegistry] Failed to fetch token metadata for ${address}:`,
    );
    return {
      ...defaultMetadata,
      address,
    };
  }
};

export const getTokenMetadata = async (
  address: `0x${string}`,
): Promise<TokenMetadata> => {
  const normalized = address.toLowerCase() as `0x${string}`;
  if (metadataCache.has(normalized)) {
    return metadataCache.get(normalized)!;
  }

  if (pendingCache.has(normalized)) {
    return pendingCache.get(normalized)!;
  }

  const promise = fetchTokenMetadata(normalized).then((metadata) => {
    metadataCache.set(normalized, metadata);
    pendingCache.delete(normalized);
    return metadata;
  });

  pendingCache.set(normalized, promise);
  return promise;
};
