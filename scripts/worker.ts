/**
 *   pnpm worker            market maker + autonomous agent
 *   pnpm worker --mm       market maker only
 *   pnpm worker --agent    agent only
 *
 * With the local database (no DATABASE_URL) these loops already run inside `pnpm dev`; the
 * database can only be opened by one process, so this standalone worker is for Neon setups.
 */
import { initDb, isLocalDb } from "../src/lib/db";
import { startWorker } from "../src/lib/worker";

if (isLocalDb()) {
  console.error("Local database mode: the worker runs inside `pnpm dev` already. Set DATABASE_URL to run it standalone.");
  process.exit(1);
}

const args = process.argv.slice(2);
const only = (flag: string) => args.length === 0 || args.includes(flag);

initDb().then(() => startWorker({ marketMaker: only("--mm"), agent: only("--agent") }));
