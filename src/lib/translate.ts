import { getAnthropicClient, stripJsonFences, TRANSLATION_MODEL, UTILITY_MODEL } from "./anthropic";
import type { CsvTable } from "./csv";
import type { TargetLanguage } from "./languages";
import type { TranslationContext } from "./context";
import { buildGlossary, type FileGlossary } from "./glossary";
import { cellProblems, resolveLocaleRules, rulesForText, usesChineseScript, type LocaleRules, type TranslationOptions } from "./localeConfig";

// Smaller batches keep each single model response short enough that quality
// (rule-adherence, register, name handling) doesn't drift for entries near
// the end of a long generation — a real failure mode observed around row 70
// of a 25-row-batch run. Concurrency is raised to compensate so overall
// latency on large files doesn't grow much even with more, smaller batches.
const BATCH_SIZE = 12;
const MAX_CONCURRENT_BATCHES = 10;

type BatchRecord = Record<string, string>;

/** One translated cell that still breaks a check after the retry, for the user to review. */
export type ReviewIssue = {
  /** 1-based data row (the header row is not counted). */
  row: number;
  language: string;
  column: string;
  problems: string[];
};

export type TranslatedTable = CsvTable & {
  /** Number of cells in `issues`: every cell still failing a check after the retry. */
  flaggedCount: number;
  issues: ReviewIssue[];
  /** File-level problems that are not tied to one cell (name list incomplete, header fallback). */
  warnings: string[];
};

/** Turns cellProblems codes into plain sentences for the review list. */
function describeProblem(code: string): string {
  const [kind, ...rest] = code.split(":");
  const arg = rest.join(":");
  switch (kind) {
    case "untranslated": return "came back empty or still in the source language (left empty)";
    case "dnt": return `"${arg}" should be copied exactly but is missing`;
    case "term": return `"${arg}" is not translated with the fixed term`;
    case "name": return `name "${arg}" is not written as the name list says`;
    case "register": return "mixes 您 and 你";
    case "avoid": return `uses the wrong-locale term "${arg}"`;
    case "double-currency": return "states the currency twice";
    case "double-unit": return "states the unit twice";
    default: return code;
  }
}

const LOCALE_REGISTER_NOTES: Record<string, string> = {
  "zh-TW": "使用台灣在地用語與口語習慣（例如「軟體」而非「軟件」、「網路」而非「網絡」），避免大陸用語與生硬的翻譯腔。",
  "zh-CN": "使用中國大陸普通話的標準書面用語與慣用表達。",
  en: "Use natural, idiomatic US English phrasing — avoid literal, word-for-word translationese.",
  ja: "自然で読みやすい日本語表現を使用し、直訳調を避けてください。",
};

/**
 * File-level rules that every batch must get identically: names kept as
 * typed, do-not-translate terms, fixed term translations, one register, no
 * padding, single currency/unit markers. Only the entries that occur in this
 * batch are listed, so the prompt stays short.
 */
function termRulesLine(language: TargetLanguage, glossary: FileGlossary, rules: LocaleRules, batchText: string): string {
  const parts: string[] = [];
  const chinese = usesChineseScript(language.code);
  if (chinese) {
    parts.push(
      "Person names written in Latin letters (English names, and pinyin names such as \"Zhang Wei\") must be copied " +
      "exactly as typed. Never transliterate them and never guess Chinese characters for them, unless the name lookup " +
      "table above gives a different rendering.",
    );
  }
  const { keep, terms } = rulesForText(rules, batchText);
  const fileTerms = Object.entries(glossary.terms).filter(([src]) => new RegExp(`\\b${src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(batchText));
  if (keep.length) parts.push(`Copy these names and terms exactly as written, never translate them: ${keep.map((k) => `"${k}"`).join(", ")}.`);
  if (terms.length || fileTerms.length) {
    parts.push(
      "Use exactly these translations every time the term appears (case-insensitive, plural forms included): " +
      [...terms, ...fileTerms].map(([a, b]) => `"${a}" → "${b}"`).join("; ") + ".",
    );
  }
  if (rules.register) {
    const other = rules.register === "您" ? "你" : "您";
    parts.push(`Address the reader as 「${rules.register}」 in every entry; never use 「${other}」.`);
  }
  parts.push(
    "Be concise: translate only what the source says. Do not add words, softeners or explanations the source does " +
    "not have" +
    (chinese
      ? " — no 「請」 unless the source says please or is a polite request, no 「系統將於…進行」 framing, and no added " +
        "「功能」, 「方案」, 「自動」 or 「產品」 unless the source implies them."
      : ".") ,
  );
  if (chinese) {
    parts.push(
      "Write a US-dollar amount once: \"$19.99\" or \"19.99 美元\", never \"$19.99 美元\". Keep unit symbols without " +
      "repeating the unit in words: \"0°C\", never \"攝氏0°C\". A percentage discount may be written as 折 (20% off → 8 折).",
    );
  }
  return parts.join(" ") + " ";
}

function buildSystemPrompt(
  columns: string[],
  language: TargetLanguage,
  context: TranslationContext,
  glossary: FileGlossary,
  rules: LocaleRules,
  batchText: string,
): string {
  const contextLine = context.domain !== "general" || context.tone !== "neutral" || context.notes
    ? `Content domain: ${context.domain}. Tone/register: ${context.tone}.` +
      (context.notes ? ` Special considerations: ${context.notes}` : "")
    : "";
  const localeNote = LOCALE_REGISTER_NOTES[language.code] ?? "";
  const glossaryEntries = Object.entries(glossary.names);
  const glossaryLine = glossaryEntries.length > 0
    ? "This file is translated in independent chunks, so the following name lookup table is the ONLY way the same " +
      "person comes out identically everywhere — treat it as a strict override that beats any general name-handling " +
      "reasoning below: " +
      glossaryEntries.map(([form, translation]) => `"${form}" → "${translation}"`).join("; ") + ". "
    : "";

  return (
    `Translate the values of ${JSON.stringify(columns)} in the given JSON array into ${language.name} (${language.code}). ` +
    (contextLine ? contextLine + " Let this inform word choice and formality, but still follow the rules below. " : "") +
    glossaryLine +
    "Before finalizing each translation, internally run a draft → review → final self-check: (1) draft a quick " +
    "translation preserving full meaning; (2) review it for mistranslation, omissions, inconsistent terminology " +
    "across entries, or stiff/machine-translated phrasing; (3) revise into the most natural, idiomatic final " +
    "wording. Do this silently — never output the draft or review, only the polished final text, in the exact " +
    "JSON array shape specified below (this keeps the self-check free of extra output tokens). " +
    (localeNote ? localeNote + " " : "") +
    "Translate faithfully and preserve the register/tone of the source text. Do not add honorifics, " +
    "titles, or suffixes (e.g. Japanese さん/君/様) that aren't present or implied in the source, and do not " +
    "substitute trendy or informal slang unless the source itself is informal — keep neutral, catalog-style wording " +
    "unless the detected domain/tone above calls for something else. " +
    "Name-handling rules — apply consistently across every entry so the same name is never rendered two different " +
    "ways in one batch: " +
    "(a) Kanji/Hanzi name with an attached parenthetical phonetic reading (furigana), e.g. 拓耶（タクヤ）: when the " +
    "target language uses Chinese characters, output just the base Kanji/Hanzi name and drop the reading; when it " +
    "doesn't (e.g. English), output a romanization of the reading instead of translating the Kanji's meaning " +
    "(拓耶（タクヤ） → \"Takuya\"). " +
    "(b) Kanji/Hanzi name with NO attached reading, e.g. 愛美愛主: when the target language uses Chinese characters " +
    "(Chinese, Japanese), keep it exactly as-is in the original Kanji/Hanzi — do not romanize it just because no " +
    "reading was given; when the target doesn't use Chinese characters (e.g. English), romanize it using your best " +
    "inference of its intended reading from context (e.g. 愛美愛主 → \"Aimi Aishu\"), the same as you would for any " +
    "other name — do not leave Kanji/Hanzi untransliterated in non-Kanji output. " +
    "(c) A name written only in Katakana with no Kanji at all, e.g. ケリー: when the target language uses Chinese " +
    "characters, transliterate the sound into a natural, commonly-used Chinese name (ケリー \"Kelly\" → 凱莉), not " +
    "the raw Katakana or Latin letters; when the target is English, romanize it directly (ケリー → \"Kelly\"). " +
    "(d) A mostly-Kanji Japanese name with a small embedded Katakana/kana particle stitched into it (common in " +
    "Japanese surnames, e.g. 三ツ谷, 一ツ橋, 四ツ谷): when the target language uses Chinese characters, drop the " +
    "kana particle and output the remaining Kanji as a natural-looking name (三ツ谷 → 三谷); when it doesn't, " +
    "romanize the full reading including the particle's sound (三ツ谷 → \"Mitsuya\"). " +
    "Preserve line breaks: if a value contains \\n, keep line/paragraph breaks in the same relative positions in the translation. " +
    "Apply every rule above with identical rigor to every entry in the array, regardless of position — do not " +
    "let quality, the draft/review/final self-check, or rule-adherence relax for entries later in the list; the " +
    "last entry gets exactly the same care as the first. " +
    termRulesLine(language, glossary, rules, batchText) +
    "Keep _id unchanged, preserve array order, do not add or drop entries, keep empty strings empty. " +
    "Reply with ONLY the resulting JSON array, no prose, no markdown fences."
  );
}

async function translateBatchOnce(
  records: BatchRecord[],
  columns: string[],
  language: TargetLanguage,
  context: TranslationContext,
  glossary: FileGlossary,
  rules: LocaleRules,
  feedback = "",
): Promise<BatchRecord[]> {
  const client = getAnthropicClient();
  const payload = records.map((record, i) => {
    const entry: Record<string, string> = { _id: String(i) };
    for (const col of columns) entry[col] = record[col] ?? "";
    return entry;
  });

  const response = await client.messages.create({
    model: TRANSLATION_MODEL,
    max_tokens: 8192,
    system:
      buildSystemPrompt(columns, language, context, glossary, rules, records.flatMap((r) => columns.map((c) => r[c] ?? "")).join("\n")) +
      feedback,
    messages: [{ role: "user", content: JSON.stringify(payload) }],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  const parsed = JSON.parse(stripJsonFences(text)) as Record<string, string>[];
  if (!Array.isArray(parsed)) throw new Error("Model reply was not a JSON array");
  return parsed;
}

async function translateHeaders(
  headers: string[],
  language: TargetLanguage,
  context: TranslationContext,
  rules: LocaleRules,
): Promise<{ labels: string[]; warning?: string }> {
  const client = getAnthropicClient();
  const payload = headers.map((h, i) => ({ _id: String(i), text: h }));
  const contextLine = context.domain !== "general"
    ? ` The file's content domain is "${context.domain}" — use that to disambiguate words with multiple meanings ` +
      '(e.g. in a film/script context, "character" means a role/person, not a text glyph).'
    : "";
  // Headers need the same locale rules as cell values; without them a zh-TW
  // file came back with Mainland headers (文本, 最大字符數) over Taiwan cells.
  const localeNote = LOCALE_REGISTER_NOTES[language.code];
  const localeLine = localeNote ? ` ${localeNote}` : "";

  const ask = async (feedback: string): Promise<string[]> => {
    const response = await client.messages.create({
      model: UTILITY_MODEL,
      max_tokens: 1024,
      system:
        `Translate the "text" value of each entry into a short, natural CSV column-header label in ` +
        `${language.name} (${language.code}).${contextLine}${localeLine} Generic identifiers that shouldn't be translated ` +
        '(e.g. "id", "SKU", "URL") may be kept as-is. Keep _id unchanged, preserve order, do not add or drop ' +
        'entries. Reply with ONLY the resulting JSON array of {"_id":...,"text":...} objects, no prose, no markdown fences.' +
        feedback,
      messages: [{ role: "user", content: JSON.stringify(payload) }],
    });
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    const parsed = JSON.parse(stripJsonFences(text)) as { _id: string; text: string }[];
    const byId = new Map(parsed.map((p) => [p._id, p.text]));
    return headers.map((h, i) => byId.get(String(i)) || h);
  };
  // Code check with one retry: the locale note alone still let 文本 through
  // about 1 time in 12 (eval round 1), so labels are checked against the
  // locale's avoid-list and re-asked with the offending words named.
  const badTerms = (labels: string[]) =>
    labels.flatMap((l, i) => rules.avoidTerms.filter((t) => l.includes(t)).map((t) => `"${headers[i]}" used ${t}`));

  const leftover = (bad: string[]) =>
    bad.length ? `${language.name} headers still use wrong-locale terms: ${bad.join("; ")}.` : undefined;
  try {
    const first = await ask("");
    const bad = badTerms(first);
    if (bad.length === 0) return { labels: first };
    try {
      const second = await ask(
        ` A previous attempt used vocabulary that is wrong for ${language.code}: ${bad.join("; ")}. Use the local term instead.`,
      );
      const labels = badTerms(second).length < bad.length ? second : first;
      return { labels, warning: leftover(badTerms(labels)) };
    } catch {
      return { labels: first, warning: leftover(bad) };
    }
  } catch {
    // Fall back to the original labels rather than failing the whole job, but tell the user.
    return { labels: headers, warning: `${language.name} headers could not be translated; the original labels were kept.` };
  }
}

// Neither Chinese nor English (nor most target scripts) legitimately contain
// Hiragana/Katakana — so if the target isn't Japanese and a "translated"
// cell still contains kana, the model didn't actually translate it, no
// matter how well-formed the JSON response otherwise looks. This catches the
// symptom directly (leftover source-language text) instead of hoping prompt
// wording alone prevents it.
const KANA_PATTERN = /[ぁ-ゟ゠-ヿ]/;

function looksUntranslated(value: string, language: TargetLanguage): boolean {
  if (language.code === "ja") return false;
  return KANA_PATTERN.test(value);
}

type ValidatedBatch = {
  records: BatchRecord[]; // aligned 1:1 with the input records, in order
  /** Cells still failing a check after the retry; index is the record's position in this batch. */
  issues: { index: number; column: string; problems: string[] }[];
};

/**
 * Quality guard: verifies every requested row (`_id`) came back, that no
 * "translated" cell still looks like un-translated source text (hard
 * failures), and that the file-level rules hold (soft failures, checked in
 * code by cellProblems: kept names and terms, fixed term translations, one
 * register, no Mainland terms in zh-TW, no doubled currency/units). Any
 * failure retries the whole batch once, telling the model which rows broke
 * which rule. Per row the better attempt wins. Rows that still fail a hard
 * check are filled with empty strings; soft failures keep the best
 * translation. Every cell still failing either kind is returned as an issue
 * for the user to review, never only logged.
 */
async function translateBatchValidated(
  records: BatchRecord[],
  columns: string[],
  language: TargetLanguage,
  context: TranslationContext,
  glossary: FileGlossary,
  rules: LocaleRules,
): Promise<ValidatedBatch> {
  type Candidate = { entry: BatchRecord | null; hard: boolean; soft: { column: string; code: string }[] };
  const best: Candidate[] = records.map(() => ({ entry: null, hard: true, soft: [] }));
  const better = (a: Candidate, b: Candidate) =>
    a.hard !== b.hard ? !a.hard : a.soft.length < b.soft.length;
  let feedback = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    let parsed: BatchRecord[] | null = null;
    try {
      parsed = await translateBatchOnce(records, columns, language, context, glossary, rules, feedback);
    } catch (err) {
      console.error(`[translate] batch attempt ${attempt} threw:`, err);
    }
    if (parsed) {
      const byId = new Map(parsed.map((entry) => [entry._id, entry]));
      records.forEach((record, i) => {
        const entry = byId.get(String(i)) ?? null;
        const hard = !entry || columns.some((col) =>
          entry[col] ? looksUntranslated(entry[col], language) : Boolean(record[col]?.trim()));
        const soft = entry && !hard
          ? columns.flatMap((col) =>
              record[col]
                ? cellProblems(record[col], entry[col] ?? "", language.code, rules, glossary.names).map((code) => ({ column: col, code }))
                : [])
          : [];
        const candidate = { entry, hard, soft };
        if (best[i].entry === null || better(candidate, best[i])) best[i] = candidate;
      });
    }
    const failing = best.map((c, i) => ({ c, i })).filter(({ c }) => c.hard || c.soft.length > 0);
    if (failing.length === 0) break;
    console.error(`[translate] batch attempt ${attempt}: ${failing.length}/${records.length} rows failed checks`);
    feedback =
      " A previous attempt at this batch broke these rules; fix them in this reply: " +
      failing.map(({ c, i }) => `_id ${i}: ${c.hard ? "missing or untranslated" : c.soft.map((p) => `${p.column} ${p.code}`).join(", ")}`).join("; ") + ".";
  }

  const issues: ValidatedBatch["issues"] = [];
  const aligned = best.map((c, index) => {
    if (c.hard || !c.entry) {
      for (const column of columns) {
        if (records[index][column]?.trim()) issues.push({ index, column, problems: [describeProblem("untranslated")] });
      }
      return {};
    }
    for (const column of columns) {
      const problems = c.soft.filter((p) => p.column === column).map((p) => describeProblem(p.code));
      if (problems.length) issues.push({ index, column, problems });
    }
    return c.entry;
  });
  return { records: aligned, issues };
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function next(): Promise<void> {
    const index = cursor++;
    if (index >= items.length) return;
    results[index] = await worker(items[index]);
    await next();
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => next()),
  );
  return results;
}

/**
 * Translates `table` into every target language. Every original column gets a
 * twin column per language — its header always translated, its values
 * translated only if the column was flagged as needing translation (other
 * columns, e.g. numeric IDs/prices, are copied through as-is under a
 * translated header, so the output reads as a fully localized file rather
 * than a mix of translated and untouched column labels).
 */
export async function translateTable(
  table: CsvTable,
  columns: string[],
  languages: TargetLanguage[],
  context: TranslationContext,
  options: TranslationOptions = {},
): Promise<TranslatedTable> {
  if (columns.length === 0 || languages.length === 0) return { ...table, flaggedCount: 0, issues: [], warnings: [] };

  const batches: BatchRecord[][] = [];
  for (let i = 0; i < table.rows.length; i += BATCH_SIZE) {
    batches.push(table.rows.slice(i, i + BATCH_SIZE));
  }

  const newHeaders = [...table.headers];
  const translatedByLanguage = new Map<string, BatchRecord[]>();
  const headerLabelsByLanguage = new Map<string, string[]>();
  const issues: ReviewIssue[] = [];
  const warnings: string[] = [];

  for (const language of languages) {
    const rules = resolveLocaleRules(language.code, options);
    const [glossary, headerResult] = await Promise.all([
      buildGlossary(table, columns, language, rules),
      translateHeaders(table.headers, language, context, rules),
    ]);
    const batchResults = await runWithConcurrency(batches, MAX_CONCURRENT_BATCHES, (batch) =>
      translateBatchValidated(batch, columns, language, context, glossary, rules),
    );
    translatedByLanguage.set(language.code, batchResults.flatMap((b) => b.records));
    batchResults.forEach((b, bi) => {
      for (const issue of b.issues) {
        issues.push({ row: bi * BATCH_SIZE + issue.index + 1, language: language.name, column: issue.column, problems: issue.problems });
      }
    });
    if (glossary.warning) warnings.push(glossary.warning);
    if (headerResult.warning) warnings.push(headerResult.warning);
    const headerLabelsRaw = headerResult.labels;

    // De-dupe against headers already in the output (original + earlier languages).
    // Common case: an identifier translates to itself (e.g. "id" → "id") and
    // collides with the original column — prefer tagging it with the language
    // name over an opaque "(2)" suffix.
    const used = new Set(newHeaders);
    const finalLabels = headerLabelsRaw.map((label) => {
      let candidate = label || "Column";
      if (used.has(candidate)) candidate = `${label} (${language.name})`;
      let n = 2;
      while (used.has(candidate)) {
        candidate = `${label} (${language.name}) (${n})`;
        n++;
      }
      used.add(candidate);
      return candidate;
    });
    headerLabelsByLanguage.set(language.code, finalLabels);
    newHeaders.push(...finalLabels);
  }

  const columnSet = new Set(columns);
  const rows = table.rows.map((row, i) => {
    const newRow: BatchRecord = { ...row };
    for (const language of languages) {
      const translatedRow = translatedByLanguage.get(language.code)?.[i];
      const labels = headerLabelsByLanguage.get(language.code)!;
      table.headers.forEach((originalHeader, ci) => {
        const label = labels[ci];
        if (columnSet.has(originalHeader)) {
          newRow[label] = translatedRow?.[originalHeader] ?? "";
        } else {
          newRow[label] = row[originalHeader] ?? "";
        }
      });
    }
    return newRow;
  });

  issues.sort((a, b) => a.row - b.row || a.language.localeCompare(b.language) || a.column.localeCompare(b.column));
  return { headers: newHeaders, rows, flaggedCount: issues.length, issues, warnings };
}
