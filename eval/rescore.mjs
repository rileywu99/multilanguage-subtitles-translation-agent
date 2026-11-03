// Re-applies checks.mjs to saved v2 runs (no API calls; judge results kept).
import { readFileSync, writeFileSync } from "node:fs";
import { codeChecks, fileChecks } from "./checks.mjs";
for (const f of process.argv.slice(2)) {
  const d = JSON.parse(readFileSync(f, "utf8"));
  d.rows.forEach((r) => { r.checks = codeChecks(r, d.summary.glossary); });
  d.summary.file = fileChecks(d.rows);
  writeFileSync(f, JSON.stringify(d, null, 2));
  console.log("rescored", f);
}
