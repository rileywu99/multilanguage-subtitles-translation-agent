// Aggregates v2 runs into the criteria table, per-name table and term counts.
// Usage: node eval/aggregate.mjs eval/results/v2/v2_run1.json eval/results/v2/v2_run2.json eval/results/v2/v2_run3.json
import { readFileSync, writeFileSync } from "node:fs";
import { NAMES } from "./checks.mjs";

const files = process.argv.slice(2);
const runs = files.map((f) => JSON.parse(readFileSync(f, "utf8")));
const allRows = runs.flatMap((d, ri) => d.rows.map((r) => ({ ...r, run: ri + 1 })));

const codeRate = (c) => {
  const app = allRows.filter((r) => r.checks[c] !== null && r.checks[c] !== undefined);
  const pass = app.filter((r) => r.checks[c]);
  const fails = app.filter((r) => !r.checks[c]);
  return { check: c, type: "code", pass: pass.length, n: app.length, pct: +(100 * pass.length / app.length).toFixed(1),
    failing_keys: [...new Set(fails.map((r) => r.key))] };
};
const judgeRate = (j) => {
  const pass = allRows.filter((r) => r.judge[j] === "pass");
  const fails = allRows.filter((r) => r.judge[j] !== "pass");
  return { check: `judge_${j}`, type: "judge", pass: pass.length, n: allRows.length, pct: +(100 * pass.length / allRows.length).toFixed(1),
    failing_keys: [...new Set(fails.map((r) => r.key))] };
};
const checks = Object.keys(allRows[0].checks);
const rates = Object.fromEntries([...checks.map(codeRate), ...["accuracy", "fluency", "concise"].map(judgeRate)].map((x) => [x.check, x]));

// Structure (file level) across runs.
const structure = runs.map((d) => d.summary.shape);

// Per-name table: rendering per run (within-run renderings must all match).
const names = NAMES.map((name) => {
  const perRun = runs.map((d) => {
    const vals = d.rows.flatMap((r) => (r.name_renderings?.[name] ? [r.name_renderings[name]] : []));
    return { renderings: [...new Set(vals)], occurrences: vals.length, verbatim: vals.filter((v) => v === "verbatim").length, in_glossary: d.summary.glossary[name] ?? null };
  });
  const flat = perRun.flatMap((p) => p.renderings);
  return {
    name, perRun,
    verbatim_or_glossary: perRun.every((p) => p.renderings.every((x) => x !== "changed")),
    same_within_each_run: perRun.every((p) => p.renderings.length <= 1),
    same_across_runs: new Set(flat).size === 1,
    verbatim_occurrences: `${perRun.reduce((a, p) => a + p.verbatim, 0)}/${perRun.reduce((a, p) => a + p.occurrences, 0)}`,
  };
});

// Proper nouns: misuse + inconsistency counts.
const termOcc = allRows.flatMap((r) => Object.entries(r.term_renderings ?? {}).map(([t, v]) => ({ run: r.run, key: r.key, term: t, v })));
const misuse = termOcc.filter((o) => o.v.startsWith("MISUSE"));
const inconsistentInFile = runs.map((d, i) => ({ run: i + 1, items: d.summary.file.inconsistent_terms }));
const termsAcrossRuns = {};
termOcc.forEach((o) => { (termsAcrossRuns[o.term] ??= new Set()).add(o.v); });
const crossRunTerms = Object.entries(termsAcrossRuns).filter(([, s]) => s.size > 1).map(([t, s]) => ({ term: t, renderings: [...s] }));

const perRun = runs.map((d, i) => ({
  run: i + 1, time_s: d.summary.time_total_s, per_row_ms: d.summary.time_per_row_ms,
  cost_pipeline: d.summary.cost_pipeline_usd, cost_per_100: d.summary.cost_per_100_rows_usd, cost_judge: d.summary.cost_judge_usd,
  register: d.summary.file.register, spacing: d.summary.file.spacing, glossary: d.summary.glossary,
}));
const total = perRun.reduce((s, r) => s + r.cost_pipeline + r.cost_judge, 0);

const out = { files, rates, structure, names, misuse, inconsistentInFile, crossRunTerms, perRun, total_cost_usd: +total.toFixed(4) };
import("node:path").then(({ dirname, join }) => writeFileSync(join(dirname(files[0]), "aggregate.json"), JSON.stringify(out, null, 2)));
for (const r of Object.values(rates)) console.log(`${r.check.padEnd(18)} ${r.type.padEnd(5)} ${String(r.pass).padStart(3)}/${r.n} ${r.pct}%  ${r.failing_keys.join(", ")}`);
console.log("\nNAMES"); names.forEach((n) => console.log(n.name, JSON.stringify(n.perRun.map((p) => p.renderings)), n.verbatim_or_glossary, n.same_within_each_run, n.same_across_runs, "verbatim", n.verbatim_occurrences));
console.log("\nMISUSE", misuse.length, JSON.stringify(misuse.map((m) => `r${m.run} ${m.key} ${m.term} ${m.v}`)));
console.log("IN-FILE INCONSISTENT", JSON.stringify(inconsistentInFile));
console.log("CROSS-RUN", JSON.stringify(crossRunTerms));
console.log("PER RUN", JSON.stringify(perRun.map(({ glossary, ...r }) => r)));
console.log("TOTAL", out.total_cost_usd, "STRUCTURE", JSON.stringify(structure.map((s) => [s.rows_match, s.columns_match, s.passthrough_intact, s.flagged_count])));
