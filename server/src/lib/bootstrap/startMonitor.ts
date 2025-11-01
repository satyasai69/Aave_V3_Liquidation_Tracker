import { liquidationMonitor } from "@/lib/aave/liquidationMonitor";
import { getEnv } from "@/lib/utils/env";
import { logger } from "@/lib/utils/logger";

const bootMonitor = async () => {
  const { ETHEREUM_HTTP_URL, AAVE_MONITOR_AUTO_START } = getEnv();

  if (!AAVE_MONITOR_AUTO_START) {
    logger.info(
      "[LiquidationMonitor] Auto-start disabled via AAVE_MONITOR_AUTO_START",
    );
    return;
  }

  if (!ETHEREUM_HTTP_URL) {
    logger.warn(
      "[LiquidationMonitor] ETHEREUM_HTTP_URL is not configured. Realtime monitoring and analytics will not run.",
    );
    return;
  }

  try {
    await liquidationMonitor.start();
  } catch (error) {
    logger.error(
      { err: error },
      "[LiquidationMonitor] Unable to start monitor",
    );
  }
};

void bootMonitor();
