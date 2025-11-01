import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const dbName =
  process.env.MONGODB_DB_NAME ?? "aave_liquidation_tracker";

if (!uri) {
  throw new Error(
    "MONGODB_URI is not defined. Set it in the UI environment to enable direct MongoDB access.",
  );
}

declare global {
  // eslint-disable-next-line no-var
  var __mongoClientPromise: Promise<MongoClient> | undefined;
}

const clientPromise =
  globalThis.__mongoClientPromise ??
  new MongoClient(uri, {
    maxPoolSize: 10,
  }).connect();

if (!globalThis.__mongoClientPromise) {
  globalThis.__mongoClientPromise = clientPromise;
}

export const getMongoClient = async (): Promise<MongoClient> =>
  clientPromise;

export const getDatabase = async () =>
  (await getMongoClient()).db(dbName);
