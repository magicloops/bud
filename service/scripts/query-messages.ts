import { db } from "../src/db/client.js";
import { messageTable, threadTable } from "../src/db/schema.js";
import { eq, desc, sql } from "drizzle-orm";

async function main() {
  const threadId = "82c0c645-cc28-4b74-a6c5-835650cc10e1";

  // Count total messages
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(messageTable)
    .where(eq(messageTable.threadId, threadId));

  console.log(`Total messages in thread: ${countResult[0].count}`);

  // Get latest 15 messages
  const messages = await db
    .select()
    .from(messageTable)
    .where(eq(messageTable.threadId, threadId))
    .orderBy(desc(messageTable.createdAt))
    .limit(15);

  console.log(`\nLatest 15 messages (newest first):\n`);
  for (const msg of messages) {
    const contentPreview = msg.content.length > 60
      ? msg.content.slice(0, 60) + "..."
      : msg.content;
    const ts = msg.createdAt.toISOString().slice(0, 19).replace("T", " ");
    console.log(`${ts} [${msg.role.padEnd(9)}] ${contentPreview}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
