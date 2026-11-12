import {
  BASE_FEE,
  type FeeBumpTransaction,
  type Horizon,
  type Keypair,
  type Transaction,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";
import { horizon, NETWORK_PASSPHRASE, treasuryKeypair } from "./config";

export class StellarError extends Error {
  constructor(
    message: string,
    readonly codes?: { transaction?: string; operations?: string[] },
  ) {
    super(message);
  }
}

const FRIENDLY: Record<string, string> = {
  op_underfunded: "Not enough balance for this transaction.",
  op_low_reserve: "The account doesn't have enough XLM reserve.",
  op_no_trust: "The recipient hasn't enabled this asset (no trustline).",
  op_no_destination: "The recipient account doesn't exist on the network.",
  op_too_few_offers: "Not enough liquidity on the order book for this trade.",
  op_under_dest_min: "Price moved beyond your slippage limit — nothing was traded.",
  op_over_source_max: "Price moved beyond your slippage limit — nothing was traded.",
  op_cross_self: "This order would trade against one of your own orders.",
  op_line_full: "The recipient can't hold more of this asset.",
  tx_bad_seq: "Sequence conflict — please retry.",
  tx_insufficient_fee: "The network is congested — please retry.",
  tx_too_late: "The transaction expired before it reached the network — please retry.",
};

function explain(error: unknown): StellarError {
  // SEP-29: Horizon's client refuses payments to exchange-style accounts that need a memo.
  if (error instanceof Error && error.name === "AccountRequiresMemoError") {
    return new StellarError("This recipient requires a memo (e.g. an exchange deposit). Add the memo and retry.");
  }
  const response = (error as { response?: { data?: { extras?: { result_codes?: StellarError["codes"] } } } })
    .response;
  const codes = response?.data?.extras?.result_codes;
  if (!codes) return new StellarError(error instanceof Error ? error.message : String(error));
  const first = codes.operations?.find((code) => code !== "op_success") ?? codes.transaction ?? "unknown";
  return new StellarError(FRIENDLY[first] ?? `Stellar rejected the transaction (${first}).`, codes);
}

// Every transaction is built with a 2-minute timebound so a stale signed tx can't land later.
export async function build(
  sourcePublicKey: string,
  operations: xdr.Operation[],
  memo?: Parameters<TransactionBuilder["addMemo"]>[0],
): Promise<Transaction> {
  const account = await horizon().loadAccount(sourcePublicKey);
  const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE });
  for (const op of operations) builder.addOperation(op);
  if (memo) builder.addMemo(memo);
  return builder.setTimeout(120).build();
}

// Users hold no XLM for fees: the treasury wraps every signed transaction in a fee-bump.
export async function submitSponsored(inner: Transaction, signers: Keypair[]) {
  for (const signer of signers) inner.sign(signer);
  const treasury = treasuryKeypair();
  const bump: FeeBumpTransaction = TransactionBuilder.buildFeeBumpTransaction(
    treasury,
    String(Number(BASE_FEE) * 20),
    inner,
    NETWORK_PASSPHRASE,
  );
  bump.sign(treasury);
  return send(bump);
}

export async function submitSigned(tx: Transaction, signers: Keypair[]) {
  for (const signer of signers) tx.sign(signer);
  return send(tx);
}

async function send(tx: Transaction | FeeBumpTransaction): Promise<Horizon.HorizonApi.SubmitTransactionResponse> {
  try {
    return await horizon().submitTransaction(tx);
  } catch (error) {
    throw explain(error);
  }
}
