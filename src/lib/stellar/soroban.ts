// Soroban plumbing: an RPC client and one way to submit contract calls.
//
// The treasury is always the transaction source, so it pays every fee and users never hold XLM for
// contract calls either. Anyone else a call needs (a vault owner depositing, a payer creating a
// schedule) signs only their authorization entry, never the transaction.
import {
  Address,
  authorizeEntry,
  BASE_FEE,
  type Keypair,
  Operation,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { env } from "../env";
import { NETWORK_PASSPHRASE, treasuryKeypair } from "./config";

let server: rpc.Server | null = null;

export function sorobanRpc() {
  server ??= new rpc.Server(env.rpcUrl);
  return server;
}

export class SorobanError extends Error {}

export type InvokeResult<T = unknown> = { hash: string; value: T };

// Authorization signatures stay valid for ~5 minutes of ledgers.
const AUTH_VALID_LEDGERS = 60;

async function buildTx(source: Keypair, op: xdr.Operation) {
  const account = await sorobanRpc().getAccount(source.publicKey());
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(op)
    .setTimeout(60)
    .build();
}

/** Signs every address-credential auth entry with the matching keypair. */
async function signAuth(op: xdr.Operation, source: Keypair, authorizers: Keypair[]) {
  const sim = await sorobanRpc().simulateTransaction(await buildTx(source, op));
  if (rpc.Api.isSimulationError(sim)) throw new SorobanError(sim.error);
  const until = sim.latestLedger + AUTH_VALID_LEDGERS;
  const auth = await Promise.all(
    (sim.result?.auth ?? []).map(async (entry) => {
      const credentials = entry.credentials;
      if (credentials.type === "sorobanCredentialsSourceAccount") return entry;
      if (credentials.type !== "sorobanCredentialsAddress" && credentials.type !== "sorobanCredentialsAddressV2") {
        throw new SorobanError(`Unsupported authorization type ${credentials.type}`);
      }
      const who = Address.fromScAddress(credentials.value.address).toString();
      const signer = authorizers.find((k) => k.publicKey() === who);
      if (!signer) throw new SorobanError(`The call needs a signature from ${who}`);
      return authorizeEntry(entry, signer, until, NETWORK_PASSPHRASE);
    }),
  );
  if (op.body.type !== "invokeHostFunction") throw new SorobanError("Not a contract operation");
  return Operation.invokeHostFunction({ func: op.body.invokeHostFunctionOp.hostFunction, auth });
}

/**
 * Simulates, signs and submits one Soroban operation, then waits for the result.
 * `authorizers` sign the auth entries of accounts other than the treasury.
 */
export async function invoke<T = unknown>(op: xdr.Operation, authorizers: Keypair[] = []): Promise<InvokeResult<T>> {
  const source = treasuryKeypair();
  const signedOp = authorizers.length ? await signAuth(op, source, authorizers) : op;
  const prepared = await sorobanRpc().prepareTransaction(await buildTx(source, signedOp));
  prepared.sign(source);

  const sent = await sorobanRpc().sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new SorobanError(`Transaction rejected: ${sent.errorResult?.result.type ?? "unknown"}`);
  }
  const result = await sorobanRpc().pollTransaction(sent.hash, { attempts: 30 });
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new SorobanError(`Transaction ${sent.hash} ${result.status.toLowerCase()}`);
  }
  return { hash: sent.hash, value: (result.returnValue ? scValToNative(result.returnValue) : undefined) as T };
}

/** Read-only call: simulated, never submitted. */
export async function read<T = unknown>(contractId: string, method: string, args: xdr.ScVal[] = []): Promise<T> {
  const op = Operation.invokeContractFunction({ contract: contractId, function: method, args });
  const sim = await sorobanRpc().simulateTransaction(await buildTx(treasuryKeypair(), op));
  if (rpc.Api.isSimulationError(sim)) throw new SorobanError(sim.error);
  return (sim.result ? scValToNative(sim.result.retval) : undefined) as T;
}

export const call = (contractId: string, method: string, args: xdr.ScVal[] = []) =>
  Operation.invokeContractFunction({ contract: contractId, function: method, args });

export async function contractExists(contractId: string) {
  try {
    await sorobanRpc().getContractInstance(contractId);
    return true;
  } catch {
    return false;
  }
}

export async function wasmUploaded(hashHex: string) {
  try {
    await sorobanRpc().getContractWasmByHash(hashHex, "hex");
    return true;
  } catch {
    return false;
  }
}
