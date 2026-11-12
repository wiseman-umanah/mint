/**
 * The dev and start scripts set NEXT_MANUAL_SIG_HANDLE, so Next leaves Ctrl+C to us: close the
 * database first, then exit. Next's own handler exits without it, and `next dev` force-kills its
 * server 100ms after Ctrl+C unless NEXT_EXIT_TIMEOUT_MS is raised (the scripts raise it too).
 */
export function handleShutdown(closeDb: () => Promise<void>) {
  const store = globalThis as typeof globalThis & { __mintShutdown?: boolean };
  if (store.__mintShutdown || !process.env.NEXT_MANUAL_SIG_HANDLE) return;
  store.__mintShutdown = true;
  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    closeDb()
      .catch((error) => console.error("[mint] closing the database failed", error))
      .finally(() => process.exit(code));
  };
  process.on("SIGINT", () => stop(130));
  process.on("SIGTERM", () => stop(143));
}
