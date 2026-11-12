import { eq } from "drizzle-orm";
import { db, schema } from "./db";
import { activateWallets, createWallets } from "./stellar/accounts";

async function uniqueHandle(email: string) {
  const base = email.split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || "user";
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? base : `${base}${Math.floor(100 + Math.random() * 900)}`;
    const taken = await db().query.users.findFirst({ where: eq(schema.users.handle, candidate) });
    if (!taken) return candidate;
  }
  return `${base}${Date.now().toString(36)}`;
}

/** First sign-in creates the user, their two wallets, default guardrails, and the on-chain accounts. */
export async function findOrCreateUser(email: string) {
  const existing = await db().query.users.findFirst({ where: eq(schema.users.email, email) });
  if (existing) return { user: existing, created: false };

  const [user] = await db()
    .insert(schema.users)
    .values({ email, handle: await uniqueHandle(email) })
    .returning();
  await createWallets(user.id);
  await db().insert(schema.guardrails).values({ userId: user.id }).onConflictDoNothing();
  // If the network call fails, the portfolio endpoint retries activation on next load.
  await activateWallets(user.id).catch((error) => console.error("[mint] wallet activation failed", error));
  return { user, created: true };
}
