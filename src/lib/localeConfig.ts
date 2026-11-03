// Terminology and register rules per target locale, in one place so users or
// new locales can extend them without touching the prompt code.
//
// A request can add its own entries through TranslationOptions (e.g. a
// customer's product and feature names); those are merged on top of these
// defaults by resolveLocaleRules().

export type Register = "您" | "你";

export type TranslationOptions = {
  /** Extra product/feature/brand names or acronyms that must stay exactly as written. */
  doNotTranslate?: string[];
  /** Extra fixed translations, source term -> target term. */
  termMap?: Record<string, string>;
  /** Fixed person-name renderings, source form -> target form. Without one, Latin-script names stay as typed. */
  nameMap?: Record<string, string>;
  /** zh-TW / zh-CN: which second-person form to use throughout the file. */
  register?: Register;
};

/** Brands and acronyms that never get translated, for every target language. */
export const DEFAULT_DO_NOT_TRANSLATE = [
  // acronyms
  "API", "SDK", "PRD", "SKU", "CSV", "PDF", "URL", "FAQ", "AI", "ID", "OTP", "USB-C",
  // brands and products without an official Chinese name
  "Notion", "Slack", "Stripe", "Shopify", "PayPal", "Apple Pay", "Google Pay", "iPhone", "iPad", "Mac",
  "App Store", "Google Play", "WhatsApp", "LINE", "Instagram", "YouTube", "Zoom", "Figma", "GitHub", "n8n",
];

/** Official / standard renderings per locale (product names with a localized name, place names). */
export const OFFICIAL_TERMS: Record<string, Record<string, string>> = {
  "zh-TW": {
    "Google Sheets": "Google 試算表",
    "Google Docs": "Google 文件",
    "Google Slides": "Google 簡報",
    "Google Calendar": "Google 日曆",
    "Google Drive": "Google 雲端硬碟",
    "Google Maps": "Google 地圖",
    "Los Angeles": "洛杉磯",
    "San Francisco": "舊金山",
    "New York": "紐約",
    "Seattle": "西雅圖",
    "Taipei": "台北",
    "Tokyo": "東京",
    "Seoul": "首爾",
  },
  "zh-CN": {
    "Google Sheets": "Google 表格",
    "Google Docs": "Google 文档",
    "Google Calendar": "Google 日历",
    "Google Drive": "Google 云端硬盘",
    "Los Angeles": "洛杉矶",
    "San Francisco": "旧金山",
    "New York": "纽约",
    "Taipei": "台北",
  },
};

/** Mainland-only vocabulary that must not appear in zh-TW output (checked in code, triggers a retry). */
export const AVOID_TERMS: Record<string, string[]> = {
  "zh-TW": ["文本", "字符", "軟件", "網絡", "信息", "默認", "視頻", "鏈接", "設置", "登錄", "賬"],
};

/** Default second-person form. 您 is the standard for Taiwan service UI. */
export const DEFAULT_REGISTER: Record<string, Register> = {
  "zh-TW": "您",
  "zh-CN": "您",
};

export const usesChineseScript = (code: string) => code.startsWith("zh");

export type LocaleRules = {
  doNotTranslate: string[];
  termMap: Record<string, string>;
  nameMap: Record<string, string>;
  register: Register | null;
  avoidTerms: string[];
};

export function resolveLocaleRules(code: string, options: TranslationOptions = {}): LocaleRules {
  return {
    doNotTranslate: [...new Set([...DEFAULT_DO_NOT_TRANSLATE, ...(options.doNotTranslate ?? [])])],
    termMap: { ...(OFFICIAL_TERMS[code] ?? {}), ...(options.termMap ?? {}) },
    nameMap: { ...(options.nameMap ?? {}) },
    register: usesChineseScript(code) ? options.register ?? DEFAULT_REGISTER[code] ?? null : null,
    avoidTerms: AVOID_TERMS[code] ?? [],
  };
}

/** Only the rules whose source term actually occurs in `text`, so prompts stay short. */
export function rulesForText(rules: LocaleRules, text: string): { keep: string[]; terms: [string, string][] } {
  const has = (t: string) => new RegExp(`(^|[^A-Za-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`).test(text);
  return {
    keep: rules.doNotTranslate.filter(has),
    terms: Object.entries(rules.termMap).filter(([src]) => has(src)),
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Deterministic output checks for one translated cell. Returns problem labels
 * (empty = fine). Used to retry a batch; never used to blank a cell.
 */
export function cellProblems(source: string, output: string, code: string, rules: LocaleRules, glossary: Record<string, string>): string[] {
  const problems: string[] = [];
  const { keep, terms } = rulesForText(rules, source);
  for (const k of keep) if (!output.includes(k)) problems.push(`dnt:${k}`);
  const nospace = (s: string) => s.replace(/\s+/g, "");
  for (const [src, tgt] of terms) if (!nospace(output).includes(nospace(tgt))) problems.push(`term:${src}`);
  for (const [form, tgt] of Object.entries(glossary)) {
    if (new RegExp(`\\b${escapeRe(form)}\\b`).test(source) && !output.includes(tgt)) problems.push(`name:${form}`);
  }
  if (rules.register === "您" && /你/.test(output)) problems.push("register");
  if (rules.register === "你" && /您/.test(output)) problems.push("register");
  for (const t of rules.avoidTerms) if (output.includes(t)) problems.push(`avoid:${t}`);
  if (usesChineseScript(code)) {
    // "$19.99 美元" states the currency twice; zh uses US$19.99 or 19.99 美元.
    if (/\$\s?\d[\d,]*(?:\.\d+)?\s*美元/.test(output)) problems.push("double-currency");
    // "攝氏0°C" states the unit twice.
    if ((/攝氏/.test(output) && output.includes("°C")) || (/華氏/.test(output) && output.includes("°F"))) problems.push("double-unit");
  }
  return problems;
}
