import { getAnthropicClient, stripJsonFences, TRANSLATION_MODEL } from "./anthropic";
import type { CsvTable } from "./csv";
import type { TargetLanguage } from "./languages";
import { usesChineseScript, type LocaleRules } from "./localeConfig";

/** Any surface form a name appears in across the file -> its one canonical translation. */
export type Glossary = Record<string, string>;

export type FileGlossary = {
  /** Person names: surface form -> canonical rendering. */
  names: Glossary;
  /** Recurring ordinary terms (e.g. "account"): source term -> the one translation used in every row. */
  terms: Glossary;
};

// Batches are translated independently and have no memory of each other, so
// nothing otherwise stops the same person's name (or the same UI word) from
// coming out differently in batch 1 vs. batch 20. This scans the FULL file
// (not a sample) once per language and pins down one rendering per name and
// per recurring term, which then gets enforced as a hard lookup table in
// every batch's prompt and checked in code after each batch.
const MAX_GLOSSARY_INPUT_CHARS = 60000;

// Latin letters (incl. accents, so pinyin with tone marks counts), spaces,
// periods, hyphens, apostrophes. "Zhang Wei", "Mary-Jane O'Neil", "Lǚ Bù".
const LATIN_NAME = /^[\p{Script=Latin}][\p{Script=Latin}\s.'’\-]*$/u;
export const isLatinScriptName = (s: string) => LATIN_NAME.test(s.trim());

export async function buildGlossary(
  table: CsvTable,
  columns: string[],
  language: TargetLanguage,
  rules: LocaleRules,
): Promise<FileGlossary> {
  const allText = table.rows
    .flatMap((row) => columns.map((col) => row[col]))
    .filter((v): v is string => Boolean(v && v.trim()))
    .join("\n")
    .slice(0, MAX_GLOSSARY_INPUT_CHARS);

  const empty: FileGlossary = { names: { ...rules.nameMap }, terms: {} };
  if (!allText.trim()) return empty;

  const chineseTarget = usesChineseScript(language.code);
  // For Chinese targets every Latin-script name is kept as typed, so the
  // glossary must see names that appear only once too: those are the ones a
  // batch would otherwise guess characters for (Zhang Wei -> 張偉).
  const nameScope = chineseTarget
    ? "find every named person/character, including names that appear only once"
    : "find every named person/character that appears more than once";
  const fixedTerms = [...rules.doNotTranslate, ...Object.keys(rules.termMap)];

  const client = getAnthropicClient();
  try {
    const response = await client.messages.create({
      model: TRANSLATION_MODEL,
      max_tokens: 4096,
      system:
        `Scan the text below. Task 1: ${nameScope}, including ` +
        "cases where the same person's name is written differently in different places (e.g. Kanji in one line, " +
        "Katakana in another, an English spelling in a third; or a title/nickname used alongside the real name for " +
        "the same person). Only real people/characters: a common word that happens to be a name elsewhere (e.g. " +
        '"will" as a verb, "grace period") is not a name. For each distinct person, decide ONE canonical translation into ' +
        `${language.name} (${language.code}), following these rules: if the target uses Chinese characters ` +
        "(Chinese, Japanese) and the name has a Kanji/Hanzi form — with or without an embedded Katakana/kana " +
        "particle (e.g. 三ツ谷, 一ツ橋) — keep the Kanji unchanged as the translation, dropping any embedded " +
        "particle (三ツ谷 → 三谷); if the target doesn't use Chinese characters (e.g. English), romanize the name's " +
        "reading instead — this applies to every case, including a plain Kanji/Hanzi name with no reading given " +
        "anywhere in the text (infer the most likely reading from context) — never leave Kanji/Hanzi " +
        "untransliterated in non-Kanji output. If the name is Katakana-only with no Kanji form anywhere, " +
        "transliterate it into a natural, commonly-used name in the target script. Then list every " +
        "surface form — every distinct way that person's name is actually written in the source text — that must " +
        "map to that same canonical translation. " +
        "Task 2: find ordinary nouns or noun phrases (UI words such as account, file, plan, workspace) that appear in " +
        "two or more different lines, and choose ONE translation for each that fits every line it appears in. Skip " +
        `person names and skip these fixed terms: ${JSON.stringify(fixedTerms)}. ` +
        'Reply with ONLY JSON: {"names": [{"surfaceForms": ["...", "..."], "translation": "..."}], ' +
        '"terms": [{"source": "...", "translation": "..."}]}, no prose, no markdown fences. Use empty arrays when nothing is found.',
      messages: [{ role: "user", content: allText }],
    });
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    const raw = JSON.parse(stripJsonFences(text));
    const nameEntries = (Array.isArray(raw) ? raw : raw.names ?? []) as { surfaceForms?: string[]; translation?: string }[];
    const termEntries = (Array.isArray(raw) ? [] : raw.terms ?? []) as { source?: string; translation?: string }[];

    const names: Glossary = {};
    for (const entry of nameEntries) {
      if (!entry.translation) continue;
      for (const form of entry.surfaceForms ?? []) {
        if (!form) continue;
        // Chinese targets: a Latin-script name (English or pinyin) stays exactly as typed.
        names[form] = chineseTarget && isLatinScriptName(form) ? form : entry.translation;
      }
    }
    // A user-supplied mapping always wins.
    Object.assign(names, rules.nameMap);

    const terms: Glossary = {};
    for (const t of termEntries) {
      if (!t.source || !t.translation || names[t.source] || fixedTerms.includes(t.source)) continue;
      terms[t.source] = t.translation;
    }
    return { names, terms };
  } catch {
    // Best-effort — translation proceeds without a glossary rather than failing the whole job.
    return empty;
  }
}
