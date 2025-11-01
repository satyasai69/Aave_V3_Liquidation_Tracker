import pino, { type LoggerOptions } from "pino";
import { getEnv } from "@/lib/utils/env";

type GlobalWithLogger = typeof globalThis & {
  __aave_liquidation_logger?: ReturnType<typeof pino>;
};

const createLogger = () => {
  const options: LoggerOptions<string> = {
    level: getEnv().LOG_LEVEL,
  };

  return pino(options);
};

const globalWithLogger = globalThis as GlobalWithLogger;

export const logger =
  globalWithLogger.__aave_liquidation_logger ??
  (globalWithLogger.__aave_liquidation_logger = createLogger());
