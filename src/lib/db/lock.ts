import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

// PGlite has no cross-process lock: two processes on one data folder silently overwrite each
// other's writes and can leave it unreadable. This pid file is that lock.
// MINT_DATA_DIR moves it, for example onto a Docker volume.
export const LOCAL_DB_DIR = path.join(process.env.MINT_DATA_DIR || path.join(process.cwd(), ".data"), "pglite");
const LOCK = `${LOCAL_DB_DIR}.lock`;

function holder(): number | null {
  let pid: number;
  try {
    pid = Number(readFileSync(LOCK, "utf8"));
  } catch {
    return null;
  }
  if (!pid || pid === process.pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null; // Left behind by a process that is gone.
  }
}

/** Throws if another live process has the local database open. */
export function assertDbFree(action = "open the local database") {
  const pid = holder();
  if (pid) {
    throw new Error(
      `Can't ${action}: process ${pid} already has ${path.relative(process.cwd(), LOCAL_DB_DIR)} open. ` +
        "PGlite allows one process at a time, so stop that one first (usually another pnpm dev, pnpm start or pnpm db:studio).",
    );
  }
}

export function acquireDbLock() {
  assertDbFree();
  writeFileSync(LOCK, String(process.pid));
  process.once("exit", releaseDbLock);
}

export function releaseDbLock() {
  try {
    if (Number(readFileSync(LOCK, "utf8")) === process.pid) unlinkSync(LOCK);
  } catch {
    // Already gone.
  }
}
