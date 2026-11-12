import { readFileSync, writeFileSync } from "node:fs";

export const ENV_FILE = ".env.local";

/** Sets NAME=value in .env.local (adding or replacing the line) and in process.env. */
export function saveEnv(name: string, value: string) {
  let text = readFileSync(ENV_FILE, "utf8");
  const line = new RegExp(`^${name}=.*$`, "m");
  text = line.test(text) ? text.replace(line, `${name}=${value}`) : `${text.trimEnd()}\n${name}=${value}\n`;
  writeFileSync(ENV_FILE, text);
  process.env[name] = value;
}
