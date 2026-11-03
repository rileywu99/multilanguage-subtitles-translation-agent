// Deterministic checks for the CSV Localizer eval (harness v2).
// Pure functions, no API calls: safe to re-run on saved outputs.

export const PLACEHOLDER = /\{\{[^{}]+\}\}|\{[A-Za-z_][A-Za-z0-9_]*\}|%(?:\d+\$)?[sd]/g;
const TAG = /<\/?[a-zA-Z][^>]*>/g;
const NUMBER = /\d+(?:[.,:]\d+)*/g;
const CJK = "\\u4e00-\\u9fff";

// --- criteria config ---------------------------------------------------------
export const NAMES = ["Will Chen", "Grace Lin", "Zhang Wei", "Liu Yang", "Michael Johnson"];
// Product/feature names, brands and acronyms that must stay exactly as written.
export const KEEP_TERMS = ["API", "PRD", "SKU", "CSV", "Notion", "Stripe", "Slack", "n8n", "iPhone", "Lexingtonight",
  "Smart Import", "Workspace Pro", "Shopify", "Apple Pay", "PayPal"];
// Terms with an official / standard zh-TW form.
export const OFFICIAL_TERMS = {
  "Google Sheets": ["Google 試算表"],
  "Google Calendar": ["Google 日曆"],
  "Los Angeles": ["洛杉磯"],
  "San Francisco": ["舊金山"],
  "Taipei": ["台北", "臺北"],
};
// Recurring ordinary UI words: whichever rendering is used, it must be the same in every row of one file.
export const RECURRING_TERMS = {
  account: ["帳戶", "帳號", "賬戶", "賬號"],
  roadmap: ["Roadmap", "路線圖", "藍圖", "產品規劃"],
  file: ["檔案", "文件"],
  message: ["訊息", "消息", "簡訊"],
  email: ["電子郵件", "Email", "email", "E-mail", "郵件", "信件"],
  settings: ["設定", "設置"],
  plan: ["方案", "計畫", "計劃", "專案"],
  team: ["團隊"],
};
const MAINLAND_TERMS = ["文本", "字符", "軟件", "網絡", "信息", "默認", "視頻", "鏈接", "設置", "登錄", "賬"];
// English that may legitimately remain in zh-TW output.
const ENGLISH_ALLOW = [...NAMES, ...KEEP_TERMS, "Google", "App", "app", "PT", "ID", "GB", "USD", "US", "Q3", "Roadmap",
  "Workflow", "Email", "email"];

const MONTH = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b/;
const AMPM = /\b\d{1,2}(?::\d{2})?\s*(AM|PM)\b/i;

export const CHECKS = [
  // structure
  "non_empty", "placeholders", "html", "line_breaks", "translated",
  // format (Taiwan conventions)
  "numbers", "dates", "times", "currency", "units", "punctuation", "cjk_spacing",
  // language
  "locale_terms", "register", "leftover_english",
  // names + proper nouns
  "names", "name_consistency", "terms", "term_consistency",
  // concision
  "length_ratio", "max_chars",
];

// --- helpers -------------------------------------------------------------------
const multiset = (arr) => arr.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
const sameMultiset = (a, b) => {
  const ma = multiset(a), mb = multiset(b);
  if (ma.size !== mb.size) return false;
  for (const [k, v] of ma) if (mb.get(k) !== v) return false;
  return true;
};
const subsetMultiset = (a, b) => {
  const mb = multiset(b);
  for (const [k, v] of multiset(a)) if ((mb.get(k) ?? 0) < v) return false;
  return true;
};
const strip = (s) => (s ?? "").replace(TAG, "").replace(PLACEHOLDER, "");
const nospace = (s) => s.replace(/\s+/g, "");
const charLen = (s) => [...strip(s)].length;

export function nameRendering(name, out, glossary) {
  if (out.includes(name)) return "verbatim";
  const g = glossary?.[name];
  if (g && out.includes(g)) return `glossary:${g}`;
  return "changed";
}
export function termRendering(term, out) {
  if (KEEP_TERMS.includes(term)) return out.includes(term) ? "kept" : "MISUSE";
  const forms = OFFICIAL_TERMS[term];
  const hit = forms.find((f) => nospace(out).includes(nospace(f)));
  if (hit) return hit;
  return out.includes(term) ? "MISUSE:kept-English" : "MISUSE:other";
}
function recurringRendering(word, out) {
  const forms = RECURRING_TERMS[word].filter((f) => nospace(out).includes(nospace(f)));
  return forms.length ? forms.sort((a, b) => b.length - a.length)[0] : null;
}
const termsIn = (src) => [...KEEP_TERMS, ...Object.keys(OFFICIAL_TERMS)].filter((t) => new RegExp(`\\b${t}\\b`).test(src));
const recurringIn = (src) => Object.keys(RECURRING_TERMS).filter((w) => new RegExp(`\\b${w}s?\\b`, "i").test(src));

// --- per-row checks ------------------------------------------------------------
export function codeChecks(row, glossary) {
  const src = row.source, out = row.output ?? "";
  const c = {};
  const notes = [];
  c.non_empty = Boolean(out.trim());
  c.placeholders = sameMultiset(src.match(PLACEHOLDER) ?? [], out.match(PLACEHOLDER) ?? []);
  c.html = JSON.stringify(src.match(TAG) ?? []) === JSON.stringify(out.match(TAG) ?? []);
  c.line_breaks = (src.match(/\n/g) ?? []).length === (out.match(/\n/g) ?? []).length;
  c.translated = out !== src;

  c.numbers = subsetMultiset(src.match(NUMBER) ?? [], out.match(NUMBER) ?? []);

  // Dates: zh-TW writes 2026 年 3 月 3 日 / 3 月 3 日, never an English month name.
  if (MONTH.test(src)) {
    c.dates = !MONTH.test(out) && /\d{1,2}\s*月\s*\d{1,2}\s*日/.test(out) &&
      (!/\b\d{4}\b/.test(src) || /\d{4}\s*年/.test(out));
  } else c.dates = null;

  // Times: no AM/PM left; 上午/下午/晚上 or a 24-hour time.
  if (AMPM.test(src)) {
    c.times = !/\b(AM|PM)\b/i.test(out) && (/(上午|下午|晚上|中午|凌晨|早上)/.test(out) || /\b(1[3-9]|2[0-3]):\d{2}\b/.test(out));
  } else c.times = null;

  // Currency: a USD amount stays USD ($, US$ or 美元) with the same figure, never converted to NT$.
  const amounts = [...src.matchAll(/\$(\d[\d,]*(?:\.\d+)?)/g)].map((m) => m[1]);
  if (amounts.length) {
    c.currency = amounts.every((a) => out.includes(`$${a}`) || new RegExp(`${a.replace(".", "\\.")}\\s*美元`).test(out)) &&
      !/(NT\$|新台幣|台幣)/.test(out) &&
      // "$19.99 美元" marks the currency twice; zh-TW uses either US$19.99 or 19.99 美元.
      !/\$\s?\d[\d,]*(?:\.\d+)?\s*美元/.test(out);
  } else c.currency = null;

  // Units: unit symbols kept, and not doubled with a Chinese unit word (攝氏0°C).
  const units = ["°C", "°F", "GB", "%"].filter((u) => src.includes(u));
  if (units.length) {
    c.units = units.every((u) => out.includes(u)) && !(/攝氏/.test(out) && out.includes("°C")) && !(/華氏/.test(out) && out.includes("°F"));
  } else c.units = null;

  // Punctuation: after/inside Chinese text use full-width ，。！？：；（）.
  const half = new RegExp(`[${CJK}][,!?;:]|[${CJK}]\\.(?!\\d)|\\([^()]*[${CJK}][^()]*\\)`);
  c.punctuation = !half.test(strip(out));
  if (!c.punctuation) notes.push(`half-width punct: ${strip(out).match(half)[0]}`);

  c.locale_terms = !MAINLAND_TERMS.some((t) => out.includes(t));

  // Leftover English: Latin words that are not placeholders, tags, names, kept terms or allowed tokens.
  let rest = strip(out);
  for (const a of [...ENGLISH_ALLOW].sort((x, y) => y.length - x.length)) rest = rest.split(a).join(" ");
  const leftover = rest.match(/[A-Za-z]{2,}/g) ?? [];
  c.leftover_english = leftover.length === 0;
  if (leftover.length) notes.push(`leftover English: ${leftover.join(", ")}`);

  // Names: each name kept verbatim or rendered with the pipeline's glossary entry.
  const names = NAMES.filter((n) => src.includes(n));
  row.name_renderings = Object.fromEntries(names.map((n) => [n, nameRendering(n, out, glossary)]));
  c.names = names.length ? Object.values(row.name_renderings).every((r) => r !== "changed") : null;
  // A common word that is also a name ("grace period", "will review") must not be turned into a name.
  if (/\bgrace period\b/.test(src) && /Grace|葛瑞絲|葛蕾絲/.test(out.replace("Grace Lin", ""))) c.names = false;

  const terms = termsIn(src);
  row.term_renderings = Object.fromEntries(terms.map((t) => [t, termRendering(t, out)]));
  c.terms = terms.length ? Object.values(row.term_renderings).every((r) => !r.startsWith("MISUSE")) : null;
  row.recurring_renderings = Object.fromEntries(recurringIn(src).map((w) => [w, recurringRendering(w, out)]));

  if (row.max_chars) {
    c.max_chars = [...out].length <= row.max_chars;
    if (!c.max_chars) notes.push(`${[...out].length} chars > max ${row.max_chars}`);
  } else c.max_chars = null;

  row.notes = notes;
  return c;
}

// --- file-relative checks (need every row of one output file) -----------------------
export function fileChecks(rows) {
  // Length ratio: zh chars / en chars, outliers beyond 1.5 × IQR of this file (rows with >= 12 English chars).
  const ratios = rows.map((r) => (charLen(r.source) >= 12 ? charLen(r.output) / charLen(r.source) : null));
  const sorted = ratios.filter((x) => x !== null).sort((a, b) => a - b);
  const q = (p) => sorted[Math.floor(p * (sorted.length - 1))];
  const [q1, q3] = [q(0.25), q(0.75)];
  const lo = q1 - 1.5 * (q3 - q1), hi = q3 + 1.5 * (q3 - q1);
  rows.forEach((r, i) => {
    r.length_ratio = ratios[i] === null ? null : +ratios[i].toFixed(3);
    r.checks.length_ratio = ratios[i] === null ? null : ratios[i] >= lo && ratios[i] <= hi;
    if (r.checks.length_ratio === false) r.notes.push(`zh/en ratio ${ratios[i].toFixed(2)} outside ${lo.toFixed(2)}–${hi.toFixed(2)}`.replace("–", " to "));
  });

  // Register: one form of "you" per file.
  const reg = (s) => (s.includes("您") && /你(?!們)/.test(s.replace(/您/g, "")) ? "both" : s.includes("您") ? "您" : /你/.test(s) ? "你" : null);
  const counts = { "您": 0, "你": 0, both: 0 };
  rows.forEach((r) => { const g = reg(r.output ?? ""); if (g) counts[g]++; });
  const major = counts["您"] >= counts["你"] ? "您" : "你";
  rows.forEach((r) => {
    const g = reg(r.output ?? "");
    r.checks.register = g === null ? null : g === major;
  });

  // CJK spacing: a file should either space Chinese next to Latin/digits or not, not both.
  const spaced = new RegExp(`[${CJK}] [A-Za-z0-9]|[A-Za-z0-9] [${CJK}]`, "g");
  const tight = new RegExp(`[${CJK}][A-Za-z0-9]|[A-Za-z0-9][${CJK}]`, "g");
  let sp = 0, ti = 0;
  const per = rows.map((r) => {
    const s = strip(r.output);
    const a = (s.match(spaced) ?? []).length, b = (s.match(tight) ?? []).length;
    sp += a; ti += b;
    return [a, b];
  });
  const spacingMajor = sp >= ti ? "spaced" : "tight";
  rows.forEach((r, i) => {
    const [a, b] = per[i];
    r.checks.cjk_spacing = a + b === 0 ? null : spacingMajor === "spaced" ? b === 0 : a === 0;
  });

  // Consistency: names, proper nouns and recurring UI words rendered the same way in every row.
  const collect = (field) => {
    const m = {};
    rows.forEach((r) => Object.entries(r[field] ?? {}).forEach(([k, v]) => { (m[k] ??= []).push(v); }));
    return m;
  };
  const names = collect("name_renderings");
  const terms = { ...collect("term_renderings"), ...collect("recurring_renderings") };
  const majority = (vals) => {
    const c = multiset(vals);
    return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };
  const inconsistentNames = Object.entries(names).filter(([, v]) => new Set(v).size > 1).map(([k, v]) => ({ name: k, renderings: v }));
  const inconsistentTerms = Object.entries(terms).filter(([, v]) => new Set(v.filter(Boolean)).size > 1).map(([k, v]) => ({ term: k, renderings: v }));
  rows.forEach((r) => {
    const n = Object.entries(r.name_renderings ?? {});
    r.checks.name_consistency = n.length ? n.every(([k, v]) => v === majority(names[k])) : null;
    const t = [...Object.entries(r.term_renderings ?? {}), ...Object.entries(r.recurring_renderings ?? {})].filter(([, v]) => v);
    r.checks.term_consistency = t.length ? t.every(([k, v]) => v === majority(terms[k].filter(Boolean))) : null;
  });

  return {
    length_ratio_fence: [+lo.toFixed(3), +hi.toFixed(3)],
    register: counts,
    register_major: major,
    spacing: { spaced: sp, tight: ti },
    names,
    terms,
    inconsistent_names: inconsistentNames,
    inconsistent_terms: inconsistentTerms,
  };
}
