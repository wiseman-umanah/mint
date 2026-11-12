import { z } from "zod";
import { errorResponse } from "@/lib/api";
import { initDb } from "@/lib/db";
import { normaliseEmail, verifyCode } from "@/lib/auth/otp";
import { startSession } from "@/lib/auth/session";
import { findOrCreateUser } from "@/lib/onboarding";

const body = z.object({ email: z.email(), code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code") });

export async function POST(request: Request) {
  try {
    await initDb();
    const { email, code } = body.parse(await request.json());
    if (!(await verifyCode(email, code))) {
      return Response.json({ error: "That code is wrong or has expired." }, { status: 400 });
    }
    const { user, created } = await findOrCreateUser(normaliseEmail(email));
    await startSession(user.id);
    return Response.json({ ok: true, created });
  } catch (error) {
    return errorResponse(error);
  }
}
