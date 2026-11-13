import { existsSync, readFileSync, writeFileSync } from "node:fs";

// MINT_ENV_FILE points it elsewhere, for example at the Docker volume.
export const ENV_FILE = process.env.MINT_ENV_FILE || ".env.local";

/** Sets NAME=value in the env file (adding or replacing the line) and in process.env. */
export function saveEnv(name: string, value: string) {
  let text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const line = new RegExp(`^${name}=.*$`, "m");
  text = line.test(text) ? text.replace(line, `${name}=${value}`) : `${text.trimEnd()}\n${name}=${value}\n`;
  writeFileSync(ENV_FILE, text);
  process.env[name] = value;
}
