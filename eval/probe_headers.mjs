// Header-only probe: calls the pipeline's own translateHeaders() from three
// builds of src/lib/translate.ts, N times each, and counts Mainland-China
// terms in zh-TW header labels. Needed because the header slip is stochastic
// and a 4-header CSV run is too small to see it.
//   v0 = original code (git HEAD before the fix): Haiku 4.5, no locale note
//   v1 = locale note added, still Haiku 4.5
//   v2 = locale note + headers on the translation model (Sonnet 5)
// Builds live in eval/.build-probe/<v>/out (see RESULTS.md for how they were made).
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const REPS = Number(process.argv[2] ?? 10);
const PRICES = { "claude-sonnet-5": { in: 2, out: 10 }, "claude-haiku-4-5-20251001": { in: 1, out: 5 } };
const MAINLAND = ["文本", "字符", "軟件", "網絡", "信息", "默認", "視頻", "鏈接", "設置", "登錄", "賬", "文件名", "用戶"];
const MODE = process.argv[3] ?? "wide"; // "wide" = 14 tempting headers, "dataset" = the 4 eval headers + live context
const WIDE_HEADERS = ["key", "type", "text", "max_chars", "description", "file_name", "user_settings", "network_status",
  "default_value", "video_url", "link", "login_count", "account_balance", "message"];
const TARGET = { code: "zh-TW", name: "Chinese (Traditional)" };
let HEADERS = WIDE_HEADERS;
let CONTEXT = { domain: "software UI localization", tone: "neutral", notes: "" };
if (MODE === "dataset") {
  const csvLib = require("./.build/csv.js");
  const { readFileSync } = await import("node:fs");
  const table = csvLib.parseCsv(readFileSync(join(here, "dataset.csv"), "utf8"));
  HEADERS = table.headers;
  // One real context-analyzer call (Haiku), shared by all variants so only the header code differs.
  CONTEXT = await require("./.build/context.js").analyzeContext(table, csvLib.detectTranslatableColumns(table));
  console.log("context", JSON.stringify(CONTEXT));
}

const report = {};
for (const v of ["v0", "v1", "v2"]) {
  const { translateHeaders } = require(`./.build-probe/${v}/out/translate.js`);
  const client = require(`./.build-probe/${v}/out/anthropic.js`).getAnthropicClient();
  let cost = 0;
  const orig = client.messages.create.bind(client.messages);
  client.messages.create = async (p, o) => {
    const r = await orig(p, o);
    const pr = PRICES[p.model];
    cost += (r.usage.input_tokens * pr.in + r.usage.output_tokens * pr.out) / 1e6;
    return r;
  };
  const runs = await Promise.all(Array.from({ length: REPS }, () => translateHeaders(HEADERS, TARGET, CONTEXT)));
  const hits = [];
  runs.forEach((labels) => labels.forEach((l, i) => {
    const bad = MAINLAND.filter((t) => l.includes(t));
    if (bad.length) hits.push(`${HEADERS[i]} -> ${l} (${bad.join(",")})`);
  }));
  const untranslated = runs.flat().filter((l, i) => l === HEADERS[i % HEADERS.length]).length;
  report[v] = { labels: runs.length * HEADERS.length, mainland_labels: hits.length,
    mainland_rate_pct: +((hits.length / (runs.length * HEADERS.length)) * 100).toFixed(1),
    fell_back_or_kept_english: untranslated, cost_usd: +cost.toFixed(5), hits, sample: runs[0] };
  console.log(v, JSON.stringify({ ...report[v], sample: undefined }));
}
writeFileSync(join(here, "results", `header_probe_${MODE}.json`), JSON.stringify({ reps: REPS, headers: HEADERS, context: CONTEXT, report }, null, 2));
