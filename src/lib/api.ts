import "server-only";
import { unstable_rethrow } from "next/navigation";
import { connection } from "next/server";
import { ZodError } from "zod";
import { requireUser, type SessionUser, Unauthorized } from "./auth/session";
import { initDb } from "./db";

// Wraps a route handler: resolves the signed-in user and turns errors into JSON responses.
export function authed<C>(handler: (user: SessionUser, request: Request, context: C) => Promise<unknown>) {
  return async (request: Request, context: C) => {
    try {
      // Request-time only: bail out of build-time prerendering before touching the database.
      await connection();
      await initDb();
      const user = await requireUser();
      const result = await handler(user, request, context);
      return result instanceof Response ? result : Response.json(result);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function errorResponse(error: unknown) {
  // Let Next's own control-flow errors (prerender bailouts, redirects) through.
  unstable_rethrow(error);
  if (error instanceof Unauthorized) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (error instanceof ZodError) {
    return Response.json({ error: error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }
  console.error("[mint]", error);
  // Driver/database errors carry a `code`; never echo those internals to the client.
  const internal = !(error instanceof Error) || "code" in error;
  return Response.json(
    { error: internal ? "Something went wrong — please try again." : error.message },
    { status: internal ? 500 : 400 },
  );
}
