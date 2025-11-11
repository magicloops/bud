import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const defaultUrl = "postgres://postgres:postgres@localhost:5432/bud";
const databaseUrl = process.env.DATABASE_URL ?? defaultUrl;

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl
  },
  strict: true,
  verbose: true
});
