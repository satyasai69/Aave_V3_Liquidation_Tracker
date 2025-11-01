import { config } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

let envLoaded = false;

const loadEnvFiles = () => {
  if (envLoaded) {
    return;
  }

  envLoaded = true;

  const currentDir = dirname(fileURLToPath(import.meta.url));

  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), ".env.local"),
    resolve(currentDir, "../../..", ".env"),
    resolve(currentDir, "../../..", ".env.local"),
    resolve(currentDir, "../../../..", ".env"),
    resolve(currentDir, "../../../..", ".env.local"),
  ];

  for (const path of new Set(candidates)) {
    if (!existsSync(path)) {
      continue;
    }
    config({ path, override: false });
  }
};

loadEnvFiles();

const envSchema = z.object({
  ETHEREUM_HTTP_URL: z
    .string()
    .url()
    .describe("HTTP RPC endpoint for Ethereum mainnet")
    .optional(),
  ETHEREUM_WS_URL: z
    .string()
    .url()
    .describe("WebSocket RPC endpoint for Ethereum mainnet")
    .optional(),
  AAVE_POOL_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .default("0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"),
  AAVE_PRICE_ORACLE_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .default("0xa50ba011c48153De246e5192C8f9258A2ba79Ca9"),
  AAVE_MONITOR_AUTO_START: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  MONGODB_URI: z
    .string()
    .describe("MongoDB connection string including credentials"),
  MONGODB_DB_NAME: z
    .string()
    .default("aave_liquidation_tracker"),
  SERVER_PORT: z
    .string()
    .regex(/^\d+$/)
    .default("4000")
    .transform((value) => Number.parseInt(value, 10)),
  UI_ORIGIN: z
    .string()
    .optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

type EnvVars = z.infer<typeof envSchema>;

let cachedEnv: EnvVars | null = null;

export const getEnv = (): EnvVars => {
  if (cachedEnv) {
    return cachedEnv;
  }

  const parsed = envSchema.safeParse({
    ETHEREUM_HTTP_URL: process.env.ETHEREUM_HTTP_URL,
    ETHEREUM_WS_URL: process.env.ETHEREUM_WS_URL,
    AAVE_POOL_ADDRESS: process.env.AAVE_POOL_ADDRESS,
    AAVE_PRICE_ORACLE_ADDRESS: process.env.AAVE_PRICE_ORACLE_ADDRESS,
    AAVE_MONITOR_AUTO_START: process.env.AAVE_MONITOR_AUTO_START,
    MONGODB_URI: process.env.MONGODB_URI,
    MONGODB_DB_NAME: process.env.MONGODB_DB_NAME,
    SERVER_PORT: process.env.SERVER_PORT,
    UI_ORIGIN: process.env.UI_ORIGIN,
    LOG_LEVEL: process.env.LOG_LEVEL,
  });

  if (!parsed.success) {
    throw new Error(
      `Environment validation failed: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} - ${issue.message}`)
        .join(", ")}`,
    );
  }

  cachedEnv = parsed.data;
  return cachedEnv;
};

export const requireEnvValue = (
  value: string | undefined,
  name: string,
): string => {
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
};
