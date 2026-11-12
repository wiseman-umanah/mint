import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "./db";
import { getWallet } from "./stellar/accounts";
import { treasuryKeypair } from "./stellar/config";
import { sendPayment } from "./stellar/trade";

export const FAUCET_USDC = 50;
const COOLDOWN_MS = 10 * 60_000;

// Test-USDC faucet: the treasury pays out real Circle testnet USDC it holds.
export async function claimTestUsdc(userId: string) {
  const last = await db().query.activity.findFirst({
    where: and(eq(schema.activity.userId, userId), eq(schema.activity.kind, "faucet")),
    orderBy: desc(schema.activity.createdAt),
  });
  if (last && Date.now() - last.createdAt.getTime() < COOLDOWN_MS) {
    const minutes = Math.ceil((COOLDOWN_MS - (Date.now() - last.createdAt.getTime())) / 60_000);
    throw new Error(`You can claim more test USDC in ${minutes} min.`);
  }
  const main = await getWallet(userId, "main");
  const result = await sendPayment(treasuryKeypair(), main.publicKey, "USDC", FAUCET_USDC).catch((error) => {
    throw new Error(
      error.codes?.operations?.includes("op_underfunded")
        ? "The MINT faucet is empty right now — top it up with pnpm stellar:bootstrap, or use faucet.circle.com."
        : error.message,
    );
  });
  await db().insert(schema.activity).values({
    userId,
    kind: "faucet",
    summary: `Received ${FAUCET_USDC} test USDC from the MINT faucet`,
    txHash: result.hash,
    actor: "system",
  });
  return { hash: result.hash, amount: FAUCET_USDC };
}
