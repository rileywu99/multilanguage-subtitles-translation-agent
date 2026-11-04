import { NextResponse } from "next/server";
import { detectSourceLanguage, detectTranslatableColumns, parseCsv, toCsv } from "@/lib/csv";
import { analyzeContext } from "@/lib/context";
import { translateTable } from "@/lib/translate";
import type { TargetLanguage } from "@/lib/languages";
import type { TranslationOptions } from "@/lib/localeConfig";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_ROWS = 500;

export async function POST(request: Request) {
  const body = (await request.json()) as { csv?: string; languages?: TargetLanguage[]; options?: TranslationOptions };
  const { csv, languages, options } = body;

  if (!csv || !csv.trim()) {
    return NextResponse.json({ error: "No CSV file content received." }, { status: 400 });
  }
  if (!languages || languages.length === 0) {
    return NextResponse.json({ error: "Select at least one target language." }, { status: 400 });
  }

  const table = parseCsv(csv);
  if (table.headers.length === 0 || table.rows.length === 0) {
    return NextResponse.json({ error: "Couldn't parse any rows from that CSV." }, { status: 400 });
  }
  if (table.rows.length > MAX_ROWS) {
    return NextResponse.json(
      { error: `This demo caps out at ${MAX_ROWS} rows (got ${table.rows.length}).` },
      { status: 400 },
    );
  }

  const sourceLanguage = detectSourceLanguage(table);
  const columns = detectTranslatableColumns(table);
  if (columns.length === 0) {
    return NextResponse.json(
      { error: `Couldn't find any translatable columns in that file (detected language: ${sourceLanguage}).` },
      { status: 400 },
    );
  }

  const context = await analyzeContext(table, columns);
  const result = await translateTable(table, columns, languages, context, options ?? {});
  // Every cell still failing a check is listed in its row, so the downloaded
  // file carries the review list too, not only the screen.
  const REVIEW_COLUMN = "Needs review";
  const notesByRow = new Map<number, string[]>();
  for (const issue of result.issues) {
    const notes = notesByRow.get(issue.row) ?? [];
    notes.push(`[${issue.language}] ${issue.column}: ${issue.problems.join("; ")}`);
    notesByRow.set(issue.row, notes);
  }
  const outputCsv = toCsv(
    result.issues.length === 0
      ? result
      : {
          headers: [...result.headers, REVIEW_COLUMN],
          rows: result.rows.map((row, i) => ({ ...row, [REVIEW_COLUMN]: (notesByRow.get(i + 1) ?? []).join(" | ") })),
        },
  );

  const summary =
    `Detected ${columns.length} ${sourceLanguage} column${columns.length === 1 ? "" : "s"} ` +
    `(${columns.join(", ")}) across ${table.rows.length} rows (domain: ${context.domain}, tone: ${context.tone}), ` +
    `and translated into ${languages.map((l) => l.name).join(", ")}. Output has ${result.headers.length} columns.` +
    (result.flaggedCount > 0
      ? ` ⚠ ${result.flaggedCount} cell${result.flaggedCount === 1 ? "" : "s"} still failed a check after the retry and need review ` +
        `(listed below and in the "Needs review" column).`
      : "") +
    (result.warnings.length > 0 ? ` ⚠ ${result.warnings.join(" ")}` : "");

  return NextResponse.json({
    summary,
    csv: outputCsv,
    columns,
    languages,
    rowCount: table.rows.length,
    context,
    flaggedCount: result.flaggedCount,
    issues: result.issues,
    warnings: result.warnings,
  });
}
