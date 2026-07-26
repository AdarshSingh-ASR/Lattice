import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Client } = pg;

const migrationUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!migrationUrl) {
  throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL is required");
}

const sql = await readFile(
  path.join(process.cwd(), "migrations", "001_lattice_memory.sql"),
  "utf8",
);
const client = new Client({
  connectionString: migrationUrl,
  ssl: { rejectUnauthorized: true },
  application_name: "lattice-migration",
});

await client.connect();
try {
  await client.query(sql);
  console.log("Lattice memory schema is ready.");
} finally {
  await client.end();
}
