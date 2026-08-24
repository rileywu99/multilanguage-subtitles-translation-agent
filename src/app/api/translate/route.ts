import { NextResponse } from "next/server";
import { detectSourceLanguage, detectTranslatableColumns, parseCsv, toCsv } from "@/lib/csv";
import { analyzeContext } from "@/lib/context";
import { translateTable } from "@/lib/translate";
import type { TargetLanguage } from "@/lib/languages";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_ROWS = 500;

export async function POST(request: Request) {
  const body = (await request.json()) as { csv?: string; languages?: TargetLanguage[] };
  const { csv, languages } = body;

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
  const result = await translateTable(table, columns, languages, context);
  const outputCsv = toCsv(result);

  const summary =
    `Detected ${columns.length} ${sourceLanguage} column${columns.length === 1 ? "" : "s"} ` +
    `(${columns.join(", ")}) across ${table.rows.length} rows (domain: ${context.domain}, tone: ${context.tone}), ` +
    `and translated into ${languages.map((l) => l.name).join(", ")}. Output has ${result.headers.length} columns.` +
    (result.flaggedCount > 0
      ? ` ⚠ ${result.flaggedCount} cell${result.flaggedCount === 1 ? "" : "s"} came back empty and may need a manual check.`
      : "");

  return NextResponse.json({
    summary,
    csv: outputCsv,
    columns,
    languages,
    rowCount: table.rows.length,
    context,
    flaggedCount: result.flaggedCount,
  });
}
