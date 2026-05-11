// Tiny .env loader. Called for its side effect: import "./load-env".
import { readFileSync } from "node:fs";
import { join } from "node:path";

try {
  const env = readFileSync(join(process.cwd(), ".env"), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
} catch {
  // no .env
}
