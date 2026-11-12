import { z } from "zod";
import { errorResponse } from "@/lib/api";
import { initDb } from "@/lib/db";
import { issueCode } from "@/lib/auth/otp";

const body = z.object({ email: z.email("Enter a valid email address") });

export async function POST(request: Request) {
  try {
    await initDb();
    const { email } = body.parse(await request.json());
    const { devCode } = await issueCode(email);
    return Response.json({ ok: true, devCode });
  } catch (error) {
    return errorResponse(error);
  }
}
