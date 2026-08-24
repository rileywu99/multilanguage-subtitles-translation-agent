import Papa from "papaparse";

export type CsvTable = {
  headers: string[];
  rows: Record<string, string>[];
};

export function parseCsv(text: string): CsvTable {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  const headers = result.meta.fields ?? [];
  return { headers, rows: result.data };
}

export function toCsv(table: CsvTable): string {
  return Papa.unparse({ fields: table.headers, data: table.rows });
}

// Unicode ranges for the CJK scripts this product's supported languages use.
const HANGUL = /[가-힣]/g;
const KANA = /[぀-ヿ]/g;
const CJK_IDEOGRAPH = /[一-鿿㐀-䶿]/g;
const LATIN = /[A-Za-z]/g;
const NON_LATIN_ASIAN = /[一-鿿㐀-䶿぀-ヿ가-힣]/;
// Two or more alphabetic "words" side by side reads as a phrase/sentence
// ("Wireless Bluetooth Earbuds"), not a code/ID/unit ("SKU-1234", "USD",
// "N/A") — used to catch English-language content, since this product
// translates in any direction among its supported languages, not just
// out of Chinese.
const ENGLISH_PHRASE = /[A-Za-z]{2,}\s+[A-Za-z]{2,}/;

/**
 * A column "needs translation" if most of its non-empty cells look like
 * natural-language content in one of this product's supported source
 * languages — CJK/Kana/Hangul script, or an English-like phrase (as opposed
 * to a numeric/ID/code column such as SKU or price, which should pass
 * through untouched). Sampling (not full-column) keeps this cheap on large
 * files while staying accurate for typical CSV exports.
 */
export function detectTranslatableColumns(
  table: CsvTable,
  sampleSize = 30,
): string[] {
  const sample = table.rows.slice(0, sampleSize);
  return table.headers.filter((header) => {
    const cells = sample
      .map((row) => row[header])
      .filter((cell): cell is string => Boolean(cell && cell.trim()));
    if (cells.length === 0) return false;
    const hitCount = cells.filter(
      (cell) => NON_LATIN_ASIAN.test(cell) || ENGLISH_PHRASE.test(cell),
    ).length;
    return hitCount / cells.length > 0.5;
  });
}

/**
 * Identifies the dominant script across a sample of cells so the UI can show
 * what it actually detected, rather than assuming "Chinese" outright. Kana
 * presence is checked first since Japanese text mixes CJK ideographs with
 * kana, while Chinese text essentially never contains kana.
 */
export function detectSourceLanguage(table: CsvTable, sampleSize = 30): string {
  const sample = table.rows.slice(0, sampleSize);
  let hangul = 0;
  let kana = 0;
  let cjk = 0;
  let latin = 0;
  let total = 0;

  for (const row of sample) {
    for (const header of table.headers) {
      const cell = row[header];
      if (!cell) continue;
      hangul += (cell.match(HANGUL) ?? []).length;
      kana += (cell.match(KANA) ?? []).length;
      cjk += (cell.match(CJK_IDEOGRAPH) ?? []).length;
      latin += (cell.match(LATIN) ?? []).length;
    }
  }
  total = hangul + kana + cjk + latin;
  if (total === 0) return "Unknown";
  if (kana / total > 0.05) return "Japanese";
  if (hangul / total > 0.3) return "Korean";
  if (cjk / total > 0.3) return "Chinese";
  if (latin / total > 0.5) return "English";
  return "Unknown";
}
