import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
import { acquireDbLock, LOCAL_DB_DIR } from "./src/lib/db/lock";

config({ path: ".env.local" });

// studio, migrate and push open the local database, so they take the same lock as the app.
if (!process.env.DATABASE_URL && process.argv.some((arg) => ["studio", "migrate", "push"].includes(arg))) acquireDbLock();

// Neon when DATABASE_URL is set; otherwise the local PGlite database.
export default process.env.DATABASE_URL
  ? defineConfig({
      schema: "./src/lib/db/schema.ts",
      out: "./drizzle",
      dialect: "postgresql",
      dbCredentials: { url: process.env.DATABASE_URL },
    })
  : defineConfig({
      schema: "./src/lib/db/schema.ts",
      out: "./drizzle",
      dialect: "postgresql",
      driver: "pglite",
      dbCredentials: { url: LOCAL_DB_DIR },
    });
