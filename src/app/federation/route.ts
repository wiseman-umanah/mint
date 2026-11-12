import { connection, type NextRequest } from "next/server";
import { initDb } from "@/lib/db";
import { env } from "@/lib/env";
import { resolveRecipient } from "@/lib/stellar/recipients";

const cors = { "Access-Control-Allow-Origin": "*" };

// SEP-2 federation server: any Stellar wallet can pay alex*<domain>.
export async function GET(request: NextRequest) {
  await connection();
  const q = request.nextUrl.searchParams.get("q") ?? "";
  const type = request.nextUrl.searchParams.get("type");
  if (type !== "name") return Response.json({ detail: "Only type=name is supported" }, { status: 501, headers: cors });
  const [name, domain] = q.split("*");
  if (!name || domain !== env.federationDomain) {
    return Response.json({ detail: "Not found" }, { status: 404, headers: cors });
  }
  try {
    await initDb();
    const recipient = await resolveRecipient(name);
    return Response.json({ stellar_address: q, account_id: recipient.publicKey }, { headers: cors });
  } catch {
    return Response.json({ detail: "Not found" }, { status: 404, headers: cors });
  }
}
