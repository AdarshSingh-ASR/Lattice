import assert from "node:assert/strict";
import pg from "pg";

const { Client } = pg;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  application_name: "lattice-verification",
});

await client.connect();
try {
  const indexResult = await client.query(
    `SELECT *
       FROM [SHOW INDEXES FROM memories]
      WHERE index_name = 'memory_embedding_idx'`,
  );
  const countResult = await client.query(
    `SELECT
       (SELECT count(*) FROM memories) AS memories,
       (SELECT count(*) FROM agent_runs) AS runs,
       (SELECT count(*) FROM memory_events) AS events,
       (SELECT count(*) FROM memory_interventions) AS interventions,
       (SELECT count(*) FROM human_approvals) AS approvals`,
  );

  assert.ok(indexResult.rowCount >= 1);
  assert.equal(indexResult.rows[0].index_name, "memory_embedding_idx");
  assert.ok(Number(countResult.rows[0].memories) >= 5);

  console.log(
    JSON.stringify({
      ok: true,
      vectorIndex: {
        name: indexResult.rows[0].index_name,
        columns: indexResult.rows.map((row) => row.column_name),
      },
      records: countResult.rows[0],
    }),
  );
} finally {
  await client.end();
}
