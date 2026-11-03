// CSV Localizer eval harness, v2 (Riley's quality criteria, 2026-11-02).
// v1 of this file (commit d0c37c4) produced the files in eval/results/*.json.
// v2 writes to eval/results/v2/.
//
// Runs the real pipeline (src/lib, compiled to eval/.build by tsc) on
// eval/dataset.csv -> zh-TW, then scores each row with deterministic code
// checks and an LLM judge on a different model (Opus 5.5). Tokens come from
// every API response's `usage` field.
//
// Usage (from translation-agent/):
//   env -u NODE_OPTIONS node_modules/.bin/tsc -p eval/tsconfig.eval.json
//   env -u NODE_OPTIONS node --env-file-if-exists=.env --env-file-if-exists=.env.local eval/run_eval.mjs <label>
//   env -u NODE_OPTIONS node eval/aggregate.mjs <label1> <label2> <label3>

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codeChecks, fileChecks, CHECKS } from "./checks.mjs";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const label = process.argv[2] ?? "run";

const csvLib = require("./.build/csv.js");
const { analyzeContext } = require("./.build/context.js");
const { translateTable } = require("./.build/translate.js");
const { getAnthropicClient, TRANSLATION_MODEL, UTILITY_MODEL } = require("./.build/anthropic.js");
const Anthropic = require("@anthropic-ai/sdk").default;

// USD per 1M tokens, from the claude-api skill model table (cached 2026-10-06).
const PRICES = {
  "claude-sonnet-5": { in: 2.0, out: 10.0 },
  "claude-haiku-4-5-20251001": { in: 1.0, out: 5.0 },
  "claude-opus-5-5": { in: 4.0, out: 20.0 },
};
const JUDGE_MODEL = "claude-opus-5-5";
const TARGET = { code: "zh-TW", name: "Chinese (Traditional)" };

// ---------- usage metering ----------
const usage = [];
let glossaryRaw = null;
function meter(client, stage) {
  const orig = client.messages.create.bind(client.messages);
  client.messages.create = async (params, opts) => {
    const t0 = performance.now();
    const res = await orig(params, opts);
    const st = stage(params);
    if (st === "glossary") glossaryRaw = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    usage.push({ stage: st, model: params.model, input: res.usage?.input_tokens ?? 0,
      output: res.usage?.output_tokens ?? 0, ms: Math.round(performance.now() - t0) });
    return res;
  };
}
const pipelineClient = getAnthropicClient();
meter(pipelineClient, (p) => {
  const s = typeof p.system === "string" ? p.system : "";
  if (s.startsWith("Scan the text")) return "glossary";
  if (s.startsWith("You are given sample")) return "context";
  if (s.includes("column-header label")) return "headers";
  return "translate";
});
const judgeClient = new Anthropic();
meter(judgeClient, () => "judge");
const cost = (rows) => rows.reduce((s, u) => s + (u.input * PRICES[u.model].in + u.output * PRICES[u.model].out) / 1e6, 0);

// ---------- judge ----------
const JUDGE_SYSTEM =
  "You are a professional English to Traditional Chinese (Taiwan, zh-TW) software localization reviewer. " +
  "You get one source UI string and its translation. Judge three things independently. " +
  "ACCURACY: pass only if the full meaning is kept with no omissions, additions or mistranslations, and every " +
  "word is read in the right sense (e.g. a person's name vs. the same word used as a common noun or verb). " +
  "Placeholders like {name}, %s, {{count}}, HTML tags, person names, brand/product names, acronyms and numbers " +
  "may stay as-is; do not fail a row for that. " +
  "FLUENCY: pass only if it reads like natural Taiwan-Mandarin product copy (Taiwan terms, Traditional characters, " +
  "no Mainland terms, no stiff translationese). Minor style preferences are not a fail. " +
  "CONCISE: pass only if the translation adds no words, padding, softeners or explanation the source does not " +
  "have (e.g. adding 「系統」, 「使用」, 「請」 or a clarifying clause that is not in the source is a fail when it " +
  "changes length or tone noticeably; normal grammatical particles are fine). " +
  'Reply with ONLY JSON: {"accuracy":"pass"|"fail","fluency":"pass"|"fail","concise":"pass"|"fail","reason":"one short sentence"}';

async function judgeRow(src, out) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await judgeClient.messages.create({
        model: JUDGE_MODEL, max_tokens: 4000, output_config: { effort: "low" }, system: JUDGE_SYSTEM,
        messages: [{ role: "user", content: JSON.stringify({ source: src, translation: out }) }],
      });
      const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch (err) {
      if (attempt === 1) return { accuracy: "error", fluency: "error", concise: "error", reason: String(err).slice(0, 200) };
    }
  }
}
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ---------- run ----------
const table = csvLib.parseCsv(readFileSync(join(here, "dataset.csv"), "utf8"));
const t0 = performance.now();
const columns = csvLib.detectTranslatableColumns(table);
const context = await analyzeContext(table, columns);
const result = await translateTable(table, columns, [TARGET], context);
const pipelineMs = Math.round(performance.now() - t0);
const outCsv = csvLib.toCsv(result);
const reparsed = csvLib.parseCsv(outCsv);
const translatedHeader = result.headers[table.headers.length + table.headers.indexOf("text")];

let glossary = {};
try {
  const parsed = JSON.parse(glossaryRaw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  for (const e of parsed) for (const f of e.surfaceForms ?? []) glossary[f] = e.translation;
} catch { glossary = { _unparsed: glossaryRaw }; }

const shape = {
  input_rows: table.rows.length,
  output_rows: reparsed.rows.length,
  rows_match: reparsed.rows.length === table.rows.length,
  columns_match: reparsed.headers.length === table.headers.length * 2,
  passthrough_intact: table.rows.every((r, i) =>
    table.headers.filter((h) => !columns.includes(h)).every((h) => {
      const outHeader = result.headers[table.headers.length + table.headers.indexOf(h)];
      return reparsed.rows[i][h] === r[h] && reparsed.rows[i][outHeader] === r[h];
    })),
  detected_columns: columns,
  flagged_count: result.flaggedCount,
  headers_out: result.headers.slice(table.headers.length),
};

const rows = table.rows.map((r, i) => {
  const out = reparsed.rows[i]?.[translatedHeader] ?? "";
  return { key: r.key, source: r.text, output: out, max_chars: Number(r.max_chars) || null };
});
rows.forEach((r) => { r.checks = codeChecks(r, glossary); });
const file = fileChecks(rows, glossary); // adds file-relative checks (ratio, register, spacing, term + name consistency) to rows

const judgments = await pool(rows, 8, (r) => judgeRow(r.source, r.output));
rows.forEach((r, i) => { r.judge = judgments[i]; });

const pipelineUsage = usage.filter((u) => u.stage !== "judge");
const judgeUsage = usage.filter((u) => u.stage === "judge");
const summary = {
  label, run_at: new Date().toISOString(), harness: "v2",
  translation_model: TRANSLATION_MODEL, utility_model: UTILITY_MODEL, judge_model: JUDGE_MODEL,
  rows: rows.length, shape, context, glossary, file,
  time_total_s: pipelineMs / 1000, time_per_row_ms: Math.round(pipelineMs / rows.length),
  tokens: { input: pipelineUsage.reduce((s, u) => s + u.input, 0), output: pipelineUsage.reduce((s, u) => s + u.output, 0) },
  cost_pipeline_usd: +cost(pipelineUsage).toFixed(5),
  cost_per_100_rows_usd: +((cost(pipelineUsage) / rows.length) * 100).toFixed(4),
  cost_judge_usd: +cost(judgeUsage).toFixed(5),
  usage_by_stage: pipelineUsage,
};
mkdirSync(join(here, "results", "v2"), { recursive: true });
writeFileSync(join(here, "results", "v2", `${label}.json`), JSON.stringify({ summary, rows }, null, 2));
writeFileSync(join(here, "results", "v2", `${label}.output.csv`), outCsv);

const n = rows.length;
const rate = (f) => `${rows.filter(f).length}/${n}`;
console.log(label, "time", summary.time_total_s, "s, pipeline $", summary.cost_pipeline_usd, "judge $", summary.cost_judge_usd);
for (const c of CHECKS) console.log(`  ${c.padEnd(18)} ${rate((r) => r.checks[c] !== false)}`);
for (const j of ["accuracy", "fluency", "concise"]) console.log(`  judge_${j.padEnd(12)} ${rate((r) => r.judge[j] === "pass")}`);
console.log("  glossary", JSON.stringify(glossary), "register", JSON.stringify(file.register));
