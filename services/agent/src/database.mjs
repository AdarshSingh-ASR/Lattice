import pg from "pg";

const { Pool } = pg;

let pool;

export function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured");
  }

  pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 4,
    connectionTimeoutMillis: 8_000,
    idleTimeoutMillis: 30_000,
    application_name: "lattice-incident-agent",
    ssl: { rejectUnauthorized: true },
  });

  return pool;
}

export function toVector(values) {
  return `[${values.map((value) => Number(value).toFixed(8)).join(",")}]`;
}

export async function withSerializableRetry(work, options = {}) {
  const maxAttempts = options.maxAttempts ?? 4;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error?.code !== "40001" || attempt >= maxAttempts) {
        throw error;
      }
      const backoff = Math.min(80 * 2 ** (attempt - 1), 700) + Math.floor(Math.random() * 50);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    } finally {
      client.release();
    }
  }

  throw new Error("Serializable transaction exhausted retries");
}
