import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import * as schema from "./schema.js";

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.pgPoolMax
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;
export type Schema = typeof schema;
