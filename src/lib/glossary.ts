import { getAnthropicClient, stripJsonFences, TRANSLATION_MODEL } from "./anthropic";
import type { CsvTable } from "./csv";
import type { TargetLanguage } from "./languages";

/** Any surface form a name appears in across the file -> its one canonical translation. */
export type Glossary = Record<string, string>;

// Batches are translated independently and have no memory of each other, so
// nothing otherwise stops the same person's name from coming out differently
// in batch 1 vs. batch 20. This scans the FULL file (not a sample) once per
// language and pins down one canonical translation per recurring name, which
// then gets enforced as a hard lookup table in every batch's prompt.
const MAX_GLOSSARY_INPUT_CHARS = 60000;

export async function buildNameGlossary(
  table: CsvTable,
  columns: string[],
  language: TargetLanguage,
): Promise<Glossary> {
  const allText = table.rows
    .flatMap((row) => columns.map((col) => row[col]))
    .filter((v): v is string => Boolean(v && v.trim()))
    .join("\n")
    .slice(0, MAX_GLOSSARY_INPUT_CHARS);

  if (!allText.trim()) return {};

  const client = getAnthropicClient();
  try {
    const response = await client.messages.create({
      model: TRANSLATION_MODEL,
      max_tokens: 4096,
      system:
        "Scan the text below and find every named person/character that appears more than once — including " +
        "cases where the same person's name is written differently in different places (e.g. Kanji in one line, " +
        "Katakana in another, an English spelling in a third; or a title/nickname used alongside the real name for " +
        "the same person). For each distinct person, decide ONE canonical translation into " +
        `${language.name} (${language.code}), following these rules: if the target uses Chinese characters ` +
        "(Chinese, Japanese) and the name has a Kanji/Hanzi form — with or without an embedded Katakana/kana " +
        "particle (e.g. 三ツ谷, 一ツ橋) — keep the Kanji unchanged as the translation, dropping any embedded " +
        "particle (三ツ谷 → 三谷); if the target doesn't use Chinese characters (e.g. English), romanize the name's " +
        "reading instead — this applies to every case, including a plain Kanji/Hanzi name with no reading given " +
        "anywhere in the text (infer the most likely reading from context) — never leave Kanji/Hanzi " +
        "untransliterated in non-Kanji output. If the name is Katakana-only with no Kanji form anywhere, " +
        "transliterate it into a natural, commonly-used name in the target script. Then list every " +
        "surface form — every distinct way that person's name is actually written in the source text — that must " +
        'map to that same canonical translation. Reply with ONLY JSON: [{"surfaceForms": ["...", "..."], ' +
        '"translation": "..."}], no prose, no markdown fences. If no recurring names are found, reply with [].',
      messages: [{ role: "user", content: allText }],
    });
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    const parsed = JSON.parse(stripJsonFences(text)) as { surfaceForms?: string[]; translation?: string }[];
    const glossary: Glossary = {};
    for (const entry of parsed) {
      if (!entry.translation) continue;
      for (const form of entry.surfaceForms ?? []) {
        if (form) glossary[form] = entry.translation;
      }
    }
    return glossary;
  } catch {
    // Best-effort — translation proceeds without a glossary rather than failing the whole job.
    return {};
  }
}
