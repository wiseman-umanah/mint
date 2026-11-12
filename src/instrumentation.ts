export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const [{ closeDb, initDb, isLocalDb }, { handleShutdown }] = await Promise.all([import("./lib/db"), import("./lib/shutdown")]);
  handleShutdown(closeDb);
  if (!isLocalDb()) return;
  // Local mode: open PGlite and apply migrations before serving, then run the market maker and
  // agent in this process — the embedded database can't be shared with a separate worker.
  await initDb();
  if (process.env.MINT_EMBEDDED_WORKER !== "false") {
    const { startWorker } = await import("./lib/worker");
    startWorker();
  }
}
