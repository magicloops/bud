import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const POSTGRES_IDENTIFIER_LIMIT_BYTES = 63;

type Journal = {
  entries: Array<{
    tag: string;
  }>;
};

type NamedMetadata = {
  name?: string;
};

type TableMetadata = {
  name: string;
  columns?: Record<string, NamedMetadata>;
  indexes?: Record<string, NamedMetadata>;
  foreignKeys?: Record<string, NamedMetadata>;
  compositePrimaryKeys?: Record<string, NamedMetadata & { columns?: string[] }>;
  uniqueConstraints?: Record<string, NamedMetadata>;
  checkConstraints?: Record<string, NamedMetadata>;
};

type Snapshot = {
  tables: Record<string, TableMetadata>;
};

function readLatestSnapshot(): Snapshot {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const metaDir = join(testDir, "../../drizzle/migrations/meta");
  const journal = JSON.parse(readFileSync(join(metaDir, "_journal.json"), "utf8")) as Journal;
  const latestEntry = journal.entries.at(-1);

  assert.ok(latestEntry, "expected at least one Drizzle migration journal entry");

  const snapshotPrefix = latestEntry.tag.split("_")[0];
  return JSON.parse(
    readFileSync(join(metaDir, `${snapshotPrefix}_snapshot.json`), "utf8"),
  ) as Snapshot;
}

function byteLength(identifier: string): number {
  return Buffer.byteLength(identifier, "utf8");
}

test("latest Drizzle snapshot avoids PostgreSQL identifier round-trip traps", () => {
  const snapshot = readLatestSnapshot();
  const overlongIdentifiers: string[] = [];
  const oneColumnCompositePrimaryKeys: string[] = [];

  for (const table of Object.values(snapshot.tables)) {
    collectIdentifier(overlongIdentifiers, "table", table.name);

    for (const column of Object.values(table.columns ?? {})) {
      collectIdentifier(overlongIdentifiers, `${table.name} column`, column.name);
    }

    collectNamedSection(overlongIdentifiers, table.name, "index", table.indexes);
    collectNamedSection(overlongIdentifiers, table.name, "foreign key", table.foreignKeys);
    collectNamedSection(overlongIdentifiers, table.name, "unique constraint", table.uniqueConstraints);
    collectNamedSection(overlongIdentifiers, table.name, "check constraint", table.checkConstraints);
    collectNamedSection(
      overlongIdentifiers,
      table.name,
      "primary key",
      table.compositePrimaryKeys,
    );

    for (const [key, primaryKey] of Object.entries(table.compositePrimaryKeys ?? {})) {
      if ((primaryKey.columns ?? []).length === 1) {
        oneColumnCompositePrimaryKeys.push(`${table.name}.${primaryKey.name ?? key}`);
      }
    }
  }

  assert.deepEqual(overlongIdentifiers, []);
  assert.deepEqual(oneColumnCompositePrimaryKeys, []);
});

function collectNamedSection(
  overlongIdentifiers: string[],
  tableName: string,
  sectionName: string,
  section: Record<string, NamedMetadata> | undefined,
): void {
  for (const [key, metadata] of Object.entries(section ?? {})) {
    collectIdentifier(overlongIdentifiers, `${tableName} ${sectionName}`, metadata.name ?? key);
  }
}

function collectIdentifier(
  overlongIdentifiers: string[],
  location: string,
  identifier: string | undefined,
): void {
  if (identifier && byteLength(identifier) > POSTGRES_IDENTIFIER_LIMIT_BYTES) {
    overlongIdentifiers.push(
      `${location} ${identifier} is ${byteLength(identifier)} bytes`,
    );
  }
}
