import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const defaultUrl = "postgres://postgres:postgres@localhost:5432/bud";
const connectionString = process.env.DATABASE_URL ?? defaultUrl;

export const pool = new Pool({
  connectionString,
  max: Number(process.env.PG_POOL_MAX ?? 10)
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;
export type Schema = typeof schema;
