import "server-only";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { hmac, randomToken } from "../crypto";
import { db, schema } from "../db";

export const SESSION_COOKIE = "mint_session";
const SESSION_TTL_MS = 30 * 86_400_000;

export async function startSession(userId: string) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db().insert(schema.sessions).values({ id: hmac(token), userId, expiresAt });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function endSession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await db().delete(schema.sessions).where(eq(schema.sessions.id, hmac(token)));
  store.delete(SESSION_COOKIE);
}

export type SessionUser = { id: string; email: string; handle: string };

export async function currentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await db().query.sessions.findFirst({ where: eq(schema.sessions.id, hmac(token)) });
  if (!session || session.expiresAt < new Date()) return null;
  const user = await db().query.users.findFirst({ where: eq(schema.users.id, session.userId) });
  return user ? { id: user.id, email: user.email, handle: user.handle } : null;
}

export class Unauthorized extends Error {}

export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new Unauthorized();
  return user;
}
