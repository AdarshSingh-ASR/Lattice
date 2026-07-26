import assert from "node:assert/strict";
import pg from "pg";

const { Client } = pg;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  application_name: "lattice-privilege-hardening",
});

await client.connect();
try {
  await client.query("CREATE ROLE IF NOT EXISTS lattice_runtime");
  await client.query("GRANT CONNECT ON DATABASE defaultdb TO lattice_runtime");
  await client.query("GRANT USAGE ON SCHEMA public TO lattice_runtime");
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE
       ON TABLE incidents, memories, agent_runs, memory_reads, memory_events, action_journal
       TO lattice_runtime`,
  );
  await client.query("GRANT lattice_runtime TO lattice_app");
  await client.query("REVOKE admin FROM lattice_app");

  const admin = await client.query(
    `SELECT member
       FROM [SHOW GRANTS ON ROLE admin]
      WHERE member = 'lattice_app'`,
  );
  const membership = await client.query(
    `SELECT member
       FROM [SHOW GRANTS ON ROLE lattice_runtime]
      WHERE member = 'lattice_app'`,
  );

  assert.equal(admin.rowCount, 0);
  assert.equal(membership.rowCount, 1);
  console.log(
    JSON.stringify({
      ok: true,
      user: "lattice_app",
      role: "lattice_runtime",
      admin: false,
      skillReceipt: {
        name: "hardening-user-privileges",
        source: "cockroachlabs/cockroachdb-skills",
      },
    }),
  );
} finally {
  await client.end();
}
