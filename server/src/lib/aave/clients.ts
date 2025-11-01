import { createPublicClient, http, webSocket } from "viem";
import type { Chain, PublicClient, Transport, WebSocketTransport } from "viem";
import { mainnet } from "viem/chains";
import { getEnv } from "@/lib/utils/env";

type HttpClient = PublicClient<Transport, Chain>;
type WsClient = PublicClient<WebSocketTransport, Chain>;

const rpcFallback = "https://rpc.mevblocker.io";

const globalClients = globalThis as unknown as {
  __aave_http_client?: HttpClient;
  __aave_ws_client?: WsClient | null;
};

export const getHttpClient = (): HttpClient => {
  if (globalClients.__aave_http_client) {
    return globalClients.__aave_http_client;
  }

  const { ETHEREUM_HTTP_URL } = getEnv();

  globalClients.__aave_http_client = createPublicClient({
    chain: mainnet,
    transport: http(ETHEREUM_HTTP_URL ?? rpcFallback),
    batch: {
      multicall: {
        wait: 32,
      },
    },
  });

  return globalClients.__aave_http_client;
};

export const getWebSocketClient = (): WsClient | null => {
  if (globalClients.__aave_ws_client !== undefined) {
    return globalClients.__aave_ws_client ?? null;
  }

  const { ETHEREUM_WS_URL } = getEnv();
  if (!ETHEREUM_WS_URL) {
    globalClients.__aave_ws_client = null;
    return null;
  }

  globalClients.__aave_ws_client = createPublicClient({
    chain: mainnet,
    transport: webSocket(ETHEREUM_WS_URL),
  });

  return globalClients.__aave_ws_client;
};
