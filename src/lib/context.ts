import { getAnthropicClient, stripJsonFences, UTILITY_MODEL } from "./anthropic";
import type { CsvTable } from "./csv";

export type TranslationContext = {
  domain: string;
  tone: string;
  notes: string;
};

const FALLBACK_CONTEXT: TranslationContext = {
  domain: "general",
  tone: "neutral",
  notes: "",
};

function sampleRows<T>(rows: T[], size: number): T[] {
  if (rows.length <= size) return rows;
  const indices = new Set<number>();
  while (indices.size < size) {
    indices.add(Math.floor(Math.random() * rows.length));
  }
  return [...indices].sort((a, b) => a - b).map((i) => rows[i]);
}

/**
 * Samples a few rows of the columns actually being translated and asks a
 * cheap model call to classify domain/tone/special considerations (honorifics,
 * name annotations, jargon, etc). The result becomes dynamic guidance injected
 * into the translation system prompt, instead of us hand-patching the prompt
 * every time a new domain surfaces a new quirk.
 */
export async function analyzeContext(
  table: CsvTable,
  columns: string[],
  sampleSize = 5,
): Promise<TranslationContext> {
  const sample = sampleRows(table.rows, sampleSize)
    .map((row) => columns.map((col) => row[col]).filter(Boolean).join(" / "))
    .filter(Boolean);

  if (sample.length === 0) return FALLBACK_CONTEXT;

  const client = getAnthropicClient();
  try {
    const response = await client.messages.create({
      model: UTILITY_MODEL,
      max_tokens: 512,
      system:
        "You are given sample cell values from a CSV column that is about to be machine-translated. " +
        "Classify the domain (e.g. cross-border e-commerce, anime/entertainment script, legal, medical, " +
        "technical documentation, general), the tone/register (e.g. formal, casual, technical/catalog), and " +
        "any special translation considerations a translator should know (e.g. contains honorific-heavy dialogue, " +
        "contains name annotations/furigana, contains legal boilerplate, contains brand names that shouldn't be " +
        'translated). Reply with ONLY JSON: {"domain": "...", "tone": "...", "notes": "..."}. Keep notes to one ' +
        'short sentence, or "" if nothing special stands out. No prose, no markdown fences.',
      messages: [{ role: "user", content: sample.map((s, i) => `${i + 1}. ${s}`).join("\n") }],
    });
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    const parsed = JSON.parse(stripJsonFences(text));
    if (typeof parsed.domain === "string" && typeof parsed.tone === "string") {
      return {
        domain: parsed.domain,
        tone: parsed.tone,
        notes: typeof parsed.notes === "string" ? parsed.notes : "",
      };
    }
  } catch {
    // fall through to default below — context analysis is a best-effort
    // enhancement, not a hard dependency for translation to proceed.
  }
  return FALLBACK_CONTEXT;
}
