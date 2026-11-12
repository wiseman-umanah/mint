import { endSession } from "@/lib/auth/session";
import { initDb } from "@/lib/db";

export async function POST() {
  await initDb();
  await endSession();
  return Response.json({ ok: true });
}
