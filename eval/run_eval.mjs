// CSV Localizer eval harness.
//
// Runs the real pipeline (src/lib, compiled to eval/.build by tsc) on
// eval/dataset.csv -> zh-TW, then scores the output in two layers:
//   1. deterministic code checks (placeholders, HTML, numbers, brands, shape)
//   2. an LLM judge on a different model (Opus 5.5) for accuracy + fluency
// Tokens are counted from every API response's `usage` field.
//
// Usage (from translation-agent/):
//   env -u NODE_OPTIONS node_modules/.bin/tsc -p eval/tsconfig.eval.json
//   env -u NODE_OPTIONS node --env-file-if-exists=.env --env-file-if-exists=.env.local eval/run_eval.mjs <label>

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
const BRANDS = ["Notion", "Stripe", "Lexingtonight", "Slack", "n8n", "iPhone", "CSV"];

// ---------- usage metering ----------
const usage = []; // { stage, model, input, output, ms }
function meter(client, stage) {
  const orig = client.messages.create.bind(client.messages);
  client.messages.create = async (params, opts) => {
    const t0 = performance.now();
    const res = await orig(params, opts);
    usage.push({
      stage: stage(params),
      model: params.model,
      input: res.usage?.input_tokens ?? 0,
      output: res.usage?.output_tokens ?? 0,
      ms: Math.round(performance.now() - t0),
    });
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

function cost(rows) {
  return rows.reduce((sum, u) => {
    const p = PRICES[u.model];
    if (!p) throw new Error(`No price for ${u.model}`);
    return sum + (u.input * p.in + u.output * p.out) / 1e6;
  }, 0);
}

// ---------- code checks ----------
const PLACEHOLDER = /\{\{[^{}]+\}\}|\{[A-Za-z_][A-Za-z0-9_]*\}|%(?:\d+\$)?[sd]/g;
const TAG = /<\/?[a-zA-Z][^>]*>/g;
const NUMBER = /\d+(?:[.,:]\d+)*/g;
// Mainland-China UI terms that a zh-TW file should not contain (Taiwan form in comment).
const MAINLAND_TERMS = [
  "文本", // 文字
  "字符", // 字元
  "軟件", // 軟體
  "網絡", // 網路
  "信息", // 訊息/資訊
  "默認", // 預設
  "視頻", // 影片
  "鏈接", // 連結
  "設置", // 設定
  "登錄", // 登入
  "賬", // 帳
];
const mainlandHits = (s) => MAINLAND_TERMS.filter((t) => (s ?? "").includes(t));
const multiset = (arr) => arr.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
function sameMultiset(a, b) {
  const ma = multiset(a), mb = multiset(b);
  if (ma.size !== mb.size) return false;
  for (const [k, v] of ma) if (mb.get(k) !== v) return false;
  return true;
}
function subsetMultiset(a, b) {
  const mb = multiset(b);
  for (const [k, v] of multiset(a)) if ((mb.get(k) ?? 0) < v) return false;
  return true;
}

function codeChecks(src, out) {
  const checks = {};
  checks.non_empty = Boolean(out && out.trim());
  checks.placeholders = sameMultiset(src.match(PLACEHOLDER) ?? [], (out ?? "").match(PLACEHOLDER) ?? []);
  checks.html = JSON.stringify(src.match(TAG) ?? []) === JSON.stringify((out ?? "").match(TAG) ?? []);
  checks.numbers = subsetMultiset(src.match(NUMBER) ?? [], (out ?? "").match(NUMBER) ?? []);
  checks.brands = BRANDS.filter((b) => src.includes(b)).every((b) => (out ?? "").includes(b));
  checks.line_breaks = (src.match(/\n/g) ?? []).length === ((out ?? "").match(/\n/g) ?? []).length;
  checks.locale_terms = mainlandHits(out).length === 0;
  checks.translated = out !== src; // copied-through English counts as a miss
  return checks;
}

// ---------- judge ----------
const JUDGE_SYSTEM =
  "You are a professional English to Traditional Chinese (Taiwan, zh-TW) software localization reviewer. " +
  "You get one source UI string and its translation. Judge two things independently. " +
  "ACCURACY: pass only if the full meaning is kept with no omissions, additions or mistranslations. " +
  "Placeholders like {name}, %s, {{count}}, HTML tags, brand names and numbers are expected to stay as-is; " +
  "do not fail a row because they are untranslated. " +
  "FLUENCY: pass only if it reads like natural Taiwan-Mandarin product copy (Taiwan terms, Traditional characters, " +
  "no Mainland terms like 軟件/網絡/信息, no stiff translationese). Minor style preferences are not a fail. " +
  'Reply with ONLY JSON: {"accuracy":"pass"|"fail","fluency":"pass"|"fail","reason":"one short sentence"}';

async function judgeRow(src, out) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await judgeClient.messages.create({
        model: JUDGE_MODEL,
        max_tokens: 4000,
        output_config: { effort: "low" },
        system: JUDGE_SYSTEM,
        messages: [{ role: "user", content: JSON.stringify({ source: src, translation: out }) }],
      });
      const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      const json = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
      return json;
    } catch (err) {
      if (attempt === 1) return { accuracy: "error", fluency: "error", reason: String(err).slice(0, 200) };
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
const csvText = readFileSync(join(here, "dataset.csv"), "utf8");
const table = csvLib.parseCsv(csvText);

const t0 = performance.now();
const columns = csvLib.detectTranslatableColumns(table);
const context = await analyzeContext(table, columns);
const result = await translateTable(table, columns, [TARGET], context);
const pipelineMs = Math.round(performance.now() - t0);
const outCsv = csvLib.toCsv(result);
const reparsed = csvLib.parseCsv(outCsv);

// Translated column = the header appended for the "text" column.
const textIdx = table.headers.indexOf("text");
const translatedHeader = result.headers[table.headers.length + textIdx];

const shape = {
  input_rows: table.rows.length,
  output_rows: reparsed.rows.length,
  rows_match: reparsed.rows.length === table.rows.length,
  columns_match: reparsed.headers.length === table.headers.length * 2,
  passthrough_intact: table.rows.every((r, i) =>
    table.headers.filter((h) => !columns.includes(h)).every((h, j) => {
      const outHeader = result.headers[table.headers.length + table.headers.indexOf(h)];
      return reparsed.rows[i][h] === r[h] && reparsed.rows[i][outHeader] === r[h];
    })),
  detected_columns: columns,
  flagged_count: result.flaggedCount,
};

const rows = table.rows.map((r, i) => {
  const out = reparsed.rows[i]?.[translatedHeader] ?? "";
  return { key: r.key, source: r.text, output: out, checks: codeChecks(r.text, out) };
});

const judgments = await pool(rows, 6, (r) => judgeRow(r.source, r.output));
rows.forEach((r, i) => {
  r.judge = judgments[i];
  r.code_pass = Object.values(r.checks).every(Boolean) && shape.rows_match && shape.columns_match;
  r.judge_pass = r.judge.accuracy === "pass" && r.judge.fluency === "pass";
});

// Column headers are part of the localized file too: same locale check + judge.
const headerRows = table.headers.map((h, i) => ({ source: h, output: result.headers[table.headers.length + i] }));
const headerJudgments = await pool(headerRows, 4, (h) => judgeRow(`[CSV column header] ${h.source}`, h.output));
headerRows.forEach((h, i) => {
  h.mainland_terms = mainlandHits(h.output);
  h.judge = headerJudgments[i];
  h.pass = h.mainland_terms.length === 0 && h.judge.accuracy === "pass" && h.judge.fluency === "pass";
});

const pipelineUsage = usage.filter((u) => u.stage !== "judge");
const judgeUsage = usage.filter((u) => u.stage === "judge");
const n = rows.length;
const pct = (k) => Math.round((rows.filter(k).length / n) * 1000) / 10;
const checkNames = Object.keys(rows[0].checks);
const summary = {
  label,
  run_at: new Date().toISOString(),
  translation_model: TRANSLATION_MODEL,
  utility_model: UTILITY_MODEL,
  judge_model: JUDGE_MODEL,
  rows: n,
  shape,
  code_pass_rate: pct((r) => r.code_pass),
  code_check_pass_rates: Object.fromEntries(checkNames.map((c) => [c, pct((r) => r.checks[c])])),
  judge_pass_rate: pct((r) => r.judge_pass),
  judge_accuracy_rate: pct((r) => r.judge.accuracy === "pass"),
  judge_fluency_rate: pct((r) => r.judge.fluency === "pass"),
  header_pass: `${headerRows.filter((h) => h.pass).length}/${headerRows.length}`,
  header_locale_pass: `${headerRows.filter((h) => h.mainland_terms.length === 0).length}/${headerRows.length}`,
  headers: headerRows,
  both_layers_pass_rate: pct((r) => r.code_pass && r.judge_pass),
  time_total_s: pipelineMs / 1000,
  time_per_row_ms: Math.round(pipelineMs / n),
  api_calls: pipelineUsage.length,
  tokens: {
    input: pipelineUsage.reduce((s, u) => s + u.input, 0),
    output: pipelineUsage.reduce((s, u) => s + u.output, 0),
  },
  cost_pipeline_usd: +cost(pipelineUsage).toFixed(5),
  cost_per_100_rows_usd: +((cost(pipelineUsage) / n) * 100).toFixed(4),
  cost_judge_usd: +cost(judgeUsage).toFixed(5),
  usage_by_stage: pipelineUsage,
};

mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(join(here, "results", `${label}.json`), JSON.stringify({ summary, rows }, null, 2));
writeFileSync(join(here, "results", `${label}.output.csv`), outCsv);

console.log(JSON.stringify({ ...summary, usage_by_stage: undefined, headers: undefined }, null, 2));
for (const h of headerRows) console.log(`[header] ${h.source} -> ${h.output} mainland=${h.mainland_terms.join(",") || "-"} judge=${h.judge.accuracy}/${h.judge.fluency} (${h.judge.reason})`);
for (const r of rows) {
  const failed = Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k);
  if (failed.length || !r.judge_pass) {
    console.log(`\n[${r.key}] code_fail=${failed.join(",") || "-"} judge=${r.judge.accuracy}/${r.judge.fluency}`);
    console.log(`  src: ${JSON.stringify(r.source)}`);
    console.log(`  out: ${JSON.stringify(r.output)}`);
    console.log(`  why: ${r.judge.reason}`);
  }
}
