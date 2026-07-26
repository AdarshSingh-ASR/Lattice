import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Client } = pg;

const migrationUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!migrationUrl) {
  throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL is required");
}

const client = new Client({
  connectionString: migrationUrl,
  ssl: { rejectUnauthorized: true },
  application_name: "lattice-migration",
});

await client.connect();
try {
  const migrationDirectory = path.join(process.cwd(), "migrations");
  const migrations = (await readdir(migrationDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const migration of migrations) {
    const sql = await readFile(path.join(migrationDirectory, migration), "utf8");
    await client.query(sql);
    console.log(`Applied ${migration}.`);
  }
  console.log("Lattice memory schema is ready.");
} finally {
  await client.end();
}
