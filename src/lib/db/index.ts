import { mkdirSync } from "node:fs";
import path from "node:path";
import { neon } from "@neondatabase/serverless";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { acquireDbLock, LOCAL_DB_DIR, releaseDbLock } from "./lock";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Two backends, one schema:
 *   DATABASE_URL=postgres://…  → Neon over HTTP (production)
 *   DATABASE_URL unset         → PGlite: real Postgres in-process, stored in .data/pglite (local dev)
 */
export { LOCAL_DB_DIR };
export const isLocalDb = () => !process.env.DATABASE_URL;

// On globalThis so hot reloads and separately bundled modules share one handle — PGlite's data
// directory may only be opened once per process.
const store = globalThis as typeof globalThis & {
  __mintDb?: Db;
  __mintDbReady?: Promise<Db>;
  __mintPglite?: { close(): Promise<void>; closed: boolean };
};

/** Opens the database (and, locally, applies migrations). Safe to call repeatedly. */
export function initDb(): Promise<Db> {
  store.__mintDbReady ??= open().then((db) => (store.__mintDb = db));
  return store.__mintDbReady;
}

async function open(): Promise<Db> {
  if (!isLocalDb()) return drizzleNeon(neon(process.env.DATABASE_URL!), { schema }) as unknown as Db;
  const [{ PGlite }, { drizzle }, { migrate }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("drizzle-orm/pglite"),
    import("drizzle-orm/pglite/migrator"),
  ]);
  mkdirSync(path.dirname(LOCAL_DB_DIR), { recursive: true });
  acquireDbLock();
  const client = new PGlite(LOCAL_DB_DIR);
  store.__mintPglite = client;
  const db = drizzle(client, { schema });
  try {
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  } catch (error) {
    // PGlite aborts with no detail when its files were left half-written by a hard kill.
    if (String((error as Error)?.cause ?? error).includes("Aborted")) {
      throw new Error(
        `The local database in ${path.relative(process.cwd(), LOCAL_DB_DIR)} is damaged, usually by two processes using it at once or a forced stop. ` +
          "Stop the server, move or delete that folder (pnpm db:reset), and start again.",
        { cause: error },
      );
    }
    throw error;
  }
  console.info(`[mint] local database ready at ${path.relative(process.cwd(), LOCAL_DB_DIR)}`);
  return db as unknown as Db;
}

/** Flushes and closes PGlite. Skipping this on exit can leave .data/pglite unreadable. */
export async function closeDb() {
  const client = store.__mintPglite;
  if (client && !client.closed) await client.close();
  releaseDbLock();
}

export function db(): Db {
  if (store.__mintDb) return store.__mintDb;
  if (!isLocalDb()) {
    store.__mintDb = drizzleNeon(neon(process.env.DATABASE_URL!), { schema }) as unknown as Db;
    return store.__mintDb;
  }
  throw new Error("The local database is still starting — try again in a moment.");
}

export { schema };
