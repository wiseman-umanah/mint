import { rmSync } from "node:fs";
import path from "node:path";
import { assertDbFree, LOCAL_DB_DIR } from "../src/lib/db/lock";

// Deletes the local PGlite database; refuses while a server or studio still has it open.
assertDbFree("reset the local database");
rmSync(LOCAL_DB_DIR, { recursive: true, force: true });
rmSync(`${LOCAL_DB_DIR}.lock`, { force: true });
console.log(`removed ${path.relative(process.cwd(), LOCAL_DB_DIR)}`);
