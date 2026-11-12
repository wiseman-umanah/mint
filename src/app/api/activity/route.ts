import { desc, eq } from "drizzle-orm";
import { authed } from "@/lib/api";
import { db, schema } from "@/lib/db";

export const GET = authed((user) =>
  db().query.activity.findMany({
    where: eq(schema.activity.userId, user.id),
    orderBy: desc(schema.activity.createdAt),
    limit: 100,
  }),
);
