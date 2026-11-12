import { eq } from "drizzle-orm";
import { authed } from "@/lib/api";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";

export const GET = authed(async (user) => {
  const wallets = await db().query.wallets.findMany({ where: eq(schema.wallets.userId, user.id) });
  return {
    ...user,
    federationAddress: `${user.handle}*${env.federationDomain}`,
    wallets: Object.fromEntries(wallets.map((w) => [w.kind, w.publicKey])),
  };
});
