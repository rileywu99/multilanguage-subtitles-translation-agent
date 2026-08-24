import { getAnthropicClient, stripJsonFences, TRANSLATION_MODEL, UTILITY_MODEL } from "./anthropic";
import type { CsvTable } from "./csv";
import type { TargetLanguage } from "./languages";
import type { TranslationContext } from "./context";
import { buildNameGlossary, type Glossary } from "./glossary";

// Smaller batches keep each single model response short enough that quality
// (rule-adherence, register, name handling) doesn't drift for entries near
// the end of a long generation — a real failure mode observed around row 70
// of a 25-row-batch run. Concurrency is raised to compensate so overall
// latency on large files doesn't grow much even with more, smaller batches.
const BATCH_SIZE = 12;
const MAX_CONCURRENT_BATCHES = 10;

type BatchRecord = Record<string, string>;

export type TranslatedTable = CsvTable & {
  /** Rows where a source cell was non-empty but its translation came back empty/missing. */
  flaggedCount: number;
};

const LOCALE_REGISTER_NOTES: Record<string, string> = {
  "zh-TW": "使用台灣在地用語與口語習慣（例如「軟體」而非「軟件」、「網路」而非「網絡」），避免大陸用語與生硬的翻譯腔。",
  "zh-CN": "使用中國大陸普通話的標準書面用語與慣用表達。",
  en: "Use natural, idiomatic US English phrasing — avoid literal, word-for-word translationese.",
  ja: "自然で読みやすい日本語表現を使用し、直訳調を避けてください。",
};

function buildSystemPrompt(
  columns: string[],
  language: TargetLanguage,
  context: TranslationContext,
  glossary: Glossary,
): string {
  const contextLine = context.domain !== "general" || context.tone !== "neutral" || context.notes
    ? `Content domain: ${context.domain}. Tone/register: ${context.tone}.` +
      (context.notes ? ` Special considerations: ${context.notes}` : "")
    : "";
  const localeNote = LOCALE_REGISTER_NOTES[language.code] ?? "";
  const glossaryEntries = Object.entries(glossary);
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
    "Keep _id unchanged, preserve array order, do not add or drop entries, keep empty strings empty. " +
    "Reply with ONLY the resulting JSON array, no prose, no markdown fences."
  );
}

async function translateBatchOnce(
  records: BatchRecord[],
  columns: string[],
  language: TargetLanguage,
  context: TranslationContext,
  glossary: Glossary,
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
    system: buildSystemPrompt(columns, language, context, glossary),
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
): Promise<string[]> {
  const client = getAnthropicClient();
  const payload = headers.map((h, i) => ({ _id: String(i), text: h }));
  const contextLine = context.domain !== "general"
    ? ` The file's content domain is "${context.domain}" — use that to disambiguate words with multiple meanings ` +
      '(e.g. in a film/script context, "character" means a role/person, not a text glyph).'
    : "";

  try {
    const response = await client.messages.create({
      model: UTILITY_MODEL,
      max_tokens: 1024,
      system:
        `Translate the "text" value of each entry into a short, natural CSV column-header label in ` +
        `${language.name} (${language.code}).${contextLine} Generic identifiers that shouldn't be translated ` +
        '(e.g. "id", "SKU", "URL") may be kept as-is. Keep _id unchanged, preserve order, do not add or drop ' +
        'entries. Reply with ONLY the resulting JSON array of {"_id":...,"text":...} objects, no prose, no markdown fences.',
      messages: [{ role: "user", content: JSON.stringify(payload) }],
    });
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    const parsed = JSON.parse(stripJsonFences(text)) as { _id: string; text: string }[];
    const byId = new Map(parsed.map((p) => [p._id, p.text]));
    return headers.map((h, i) => byId.get(String(i)) || h);
  } catch {
    // Header translation is best-effort — fall back to the original labels rather than failing the whole job.
    return headers;
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
  missingCount: number;
};

/**
 * Quality guard: verifies every requested row (`_id`) came back AND that no
 * "translated" cell still looks like un-translated source text, retrying the
 * whole batch once on either failure. If it still doesn't hold up after the
 * retry, the offending rows are filled with empty strings and counted rather
 * than shipped as silently-wrong output.
 */
async function translateBatchValidated(
  records: BatchRecord[],
  columns: string[],
  language: TargetLanguage,
  context: TranslationContext,
  glossary: Glossary,
): Promise<ValidatedBatch> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const parsed = await translateBatchOnce(records, columns, language, context, glossary);
      const byId = new Map(parsed.map((entry) => [entry._id, entry]));
      let missingCount = 0;
      const aligned = records.map((_, i) => {
        const entry = byId.get(String(i));
        if (!entry) {
          missingCount++;
          return {};
        }
        const bad = columns.some((col) => entry[col] && looksUntranslated(entry[col], language));
        if (bad) {
          missingCount++;
          return {};
        }
        return entry;
      });
      if (missingCount === 0) return { records: aligned, missingCount: 0 };
      console.error(`[translate] batch attempt ${attempt}: ${missingCount}/${records.length} rows missing/untranslated`);
      if (attempt === 0) continue; // retry the whole batch once
      return { records: aligned, missingCount };
    } catch (err) {
      console.error(`[translate] batch attempt ${attempt} threw:`, err);
      if (attempt === 1) {
        return { records: records.map(() => ({})), missingCount: records.length };
      }
      // else fall through and retry
    }
  }
  return { records: records.map(() => ({})), missingCount: records.length };
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
): Promise<TranslatedTable> {
  if (columns.length === 0 || languages.length === 0) return { ...table, flaggedCount: 0 };

  const batches: BatchRecord[][] = [];
  for (let i = 0; i < table.rows.length; i += BATCH_SIZE) {
    batches.push(table.rows.slice(i, i + BATCH_SIZE));
  }

  const newHeaders = [...table.headers];
  const translatedByLanguage = new Map<string, BatchRecord[]>();
  const headerLabelsByLanguage = new Map<string, string[]>();

  for (const language of languages) {
    const [glossary, headerLabelsRaw] = await Promise.all([
      buildNameGlossary(table, columns, language),
      translateHeaders(table.headers, language, context),
    ]);
    const batchResults = await runWithConcurrency(batches, MAX_CONCURRENT_BATCHES, (batch) =>
      translateBatchValidated(batch, columns, language, context, glossary),
    );
    translatedByLanguage.set(language.code, batchResults.flatMap((b) => b.records));

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

  let emptyTranslationCount = 0;
  const columnSet = new Set(columns);
  const rows = table.rows.map((row, i) => {
    const newRow: BatchRecord = { ...row };
    for (const language of languages) {
      const translatedRow = translatedByLanguage.get(language.code)?.[i];
      const labels = headerLabelsByLanguage.get(language.code)!;
      table.headers.forEach((originalHeader, ci) => {
        const label = labels[ci];
        if (columnSet.has(originalHeader)) {
          const value = translatedRow?.[originalHeader] ?? "";
          if (!value && row[originalHeader]?.trim()) emptyTranslationCount++;
          newRow[label] = value;
        } else {
          newRow[label] = row[originalHeader] ?? "";
        }
      });
    }
    return newRow;
  });

  return { headers: newHeaders, rows, flaggedCount: emptyTranslationCount };
}
