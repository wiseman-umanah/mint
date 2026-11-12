import { eq } from "drizzle-orm";
import { Federation, StrKey } from "@stellar/stellar-sdk";
import { db, schema } from "../db";
import { env } from "../env";

export type Recipient = { publicKey: string; label: string; memo?: string; userId?: string };

/**
 * Resolves what a user types into a Stellar account:
 *   @alex / alex         → a MINT user's main wallet
 *   alex*mint.app        → SEP-2 federation (ours or any other domain)
 *   G…                   → a raw account
 */
export async function resolveRecipient(input: string): Promise<Recipient> {
  const value = input.trim();
  if (StrKey.isValidEd25519PublicKey(value)) {
    return { publicKey: value, label: `${value.slice(0, 4)}…${value.slice(-4)}` };
  }

  const [name, domain] = value.replace(/^@/, "").split("*");
  if (!domain || domain === env.federationDomain) {
    const handle = name.toLowerCase();
    const user = await db().query.users.findFirst({ where: eq(schema.users.handle, handle) });
    if (!user) throw new Error(`No MINT user with the handle @${handle}.`);
    const wallet = await db().query.wallets.findFirst({
      where: (w, { and, eq }) => and(eq(w.userId, user.id), eq(w.kind, "main")),
    });
    if (!wallet) throw new Error(`@${handle} doesn't have a wallet yet.`);
    return { publicKey: wallet.publicKey, label: `@${handle}`, userId: user.id };
  }

  try {
    const record = await Federation.Server.resolve(value, { timeout: 5_000 });
    return { publicKey: record.account_id, label: value, memo: record.memo ? String(record.memo) : undefined };
  } catch {
    throw new Error(`Couldn't resolve the federation address ${value}.`);
  }
}
