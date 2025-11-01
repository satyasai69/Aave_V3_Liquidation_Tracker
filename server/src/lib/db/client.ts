import { MongoClient, type Collection } from "mongodb";
import { getEnv } from "@/lib/utils/env";
import type { NormalizedLiquidationEvent } from "@/lib/types/liquidation";
import { logger } from "@/lib/utils/logger";

const maskMongoUri = (uri: string): string =>
  uri.replace(/\/\/[^@]+@/, "//");

let clientPromise: Promise<MongoClient> | null = null;
let collectionPromise:
  | Promise<Collection<NormalizedLiquidationEvent>>
  | null = null;

const bootstrap = async (
  collection: Collection<NormalizedLiquidationEvent>,
) => {
  await Promise.all([
    collection.createIndex({ id: 1 }, { unique: true }),
    collection.createIndex({ blockTimestamp: -1 }),
    collection.createIndex({ liquidator: 1 }),
    collection.createIndex({ user: 1 }),
    collection.createIndex(
      { collateralAsset: 1, debtAsset: 1 },
    ),
  ]);
};

export const getMongoClient = async (): Promise<MongoClient> => {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { MONGODB_URI } = getEnv();
      const maskedUri = maskMongoUri(MONGODB_URI);
      logger.info({ uri: maskedUri }, "[MongoDB] connecting");

      const client = new MongoClient(MONGODB_URI, {
        maxIdleTimeMS: 60_000,
      });

      await client.connect();
      logger.info({ uri: maskedUri }, "[MongoDB] connected");
      return client;
    })();
  }

  return clientPromise;
};

export const getLiquidationsCollection = async (): Promise<
  Collection<NormalizedLiquidationEvent>
> => {
  if (!collectionPromise) {
    collectionPromise = (async () => {
      const { MONGODB_DB_NAME } = getEnv();
      const client = await getMongoClient();
      const db = client.db(MONGODB_DB_NAME);
      const collection =
        db.collection<NormalizedLiquidationEvent>(
          "liquidations",
        );

      await bootstrap(collection);
      return collection;
    })();
  }

  return collectionPromise;
};

export const closeMongoClient = async (): Promise<void> => {
  if (clientPromise) {
    const client = await clientPromise;
    await client.close();
  }

  clientPromise = null;
  collectionPromise = null;
};
