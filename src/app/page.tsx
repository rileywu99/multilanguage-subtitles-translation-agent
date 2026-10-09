"use client";

import { useRef, useState } from "react";
import { detectSourceLanguage, detectTranslatableColumns, parseCsv, toCsv, type CsvTable } from "@/lib/csv";
import { COMMON_LANGUAGES } from "@/lib/languages";
import { DEMO, DEMO_STAGES, PREPARED, SAMPLE_CSV, SAMPLE_FILE_NAME } from "@/lib/demo";

type Result = { summary: string; csv: string; fileName: string; flaggedCount: number };

// What detectSourceLanguage(...) is allowed to return before we call it
// "supported" — it can also return "Korean" or "Unknown", neither of which
// this product handles yet.
const SUPPORTED_SOURCE_LANGUAGES = new Set(["Chinese", "Japanese", "English"]);
// Only English and Japanese map to exactly one target option, so a file
// detected as one of those hides that same option from the target dropdown
// (translating a language into itself is a no-op). Chinese is deliberately
// left alone: detection can't tell Traditional from Simplified, and blocking
// both options would break the legitimate Traditional<->Simplified use case.
const SAME_LANGUAGE_TARGET_CODE: Record<string, string> = {
  English: "en",
  Japanese: "ja",
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function downloadCsv(csv: string, fileName: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Home() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [table, setTable] = useState<CsvTable | null>(null);
  const [detectedColumns, setDetectedColumns] = useState<string[]>([]);
  const [detectedLanguage, setDetectedLanguage] = useState<string | null>(null);
  const [selectedCode, setSelectedCode] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [stage, setStage] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isSupportedSource = detectedLanguage !== null && SUPPORTED_SOURCE_LANGUAGES.has(detectedLanguage);
  const availableTargetLanguages = COMMON_LANGUAGES.filter(
    (l) => l.code !== (detectedLanguage ? SAME_LANGUAGE_TARGET_CODE[detectedLanguage] : undefined),
  );
  const selectedLanguage = availableTargetLanguages.find((l) => l.code === selectedCode) ?? null;

  async function handleFile(f: File) {
    setError(null);
    setResult(null);
    const text = await f.text();
    const parsed = parseCsv(text);
    const columns = detectTranslatableColumns(parsed);
    const language = detectSourceLanguage(parsed);
    setFileName(f.name);
    setCsvText(text);
    setTable(parsed);
    setDetectedColumns(columns);
    setDetectedLanguage(language);
    if (language && SAME_LANGUAGE_TARGET_CODE[language] === selectedCode) setSelectedCode("");
  }

  function loadSample() {
    handleFile(new File([SAMPLE_CSV], SAMPLE_FILE_NAME, { type: "text/csv" }));
  }

  // Static demo: replay the prepared output for the sample file, walking
  // through the same four stages the real pipeline runs.
  async function runDemo() {
    if (!table || !selectedLanguage || !fileName) return;
    if (csvText !== SAMPLE_CSV) {
      setError(
        "This hosted demo replays one sample file. Load the sample CSV to see a full run — to localize your own files, run the app locally with an Anthropic API key (instructions on GitHub).",
      );
      return;
    }
    const prepared = PREPARED[selectedLanguage.code];
    setLoading(true);
    setError(null);
    setResult(null);
    for (let i = 0; i < DEMO_STAGES.length; i++) {
      setStage(i);
      await wait(900);
    }
    setStage(null);
    const columnIndex = { product_name: 0, description: 1, category: 2 } as Record<string, number>;
    const out: CsvTable = {
      headers: [...table.headers, ...prepared.headers],
      rows: table.rows.map((row, ri) => {
        const next = { ...row };
        table.headers.forEach((h, ci) => {
          const idx = columnIndex[h];
          next[prepared.headers[ci]] = idx === undefined ? (row[h] ?? "") : prepared.rows[ri][idx];
        });
        return next;
      }),
    };
    const summary =
      `Detected ${detectedColumns.length} ${detectedLanguage} columns (${detectedColumns.join(", ")}) across ${table.rows.length} rows ` +
      `(domain: ${prepared.context.domain}, tone: ${prepared.context.tone}), and translated into ${selectedLanguage.name}. ` +
      `Output has ${out.headers.length} columns.`;
    const baseName = fileName.replace(/\.csv$/i, "");
    setResult({
      summary,
      csv: toCsv(out),
      fileName: `${baseName}__${detectedLanguage}_to_${selectedLanguage.name}.csv`,
      flaggedCount: 0,
    });
    setLoading(false);
  }

  const canSubmit =
    Boolean(csvText) && isSupportedSource && detectedColumns.length > 0 && selectedLanguage !== null && !loading;

  async function handleSubmit() {
    if (!csvText || !fileName || !selectedLanguage) return;
    if (DEMO) return runDemo();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: csvText, languages: [selectedLanguage] }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong.");
        return;
      }
      const baseName = fileName.replace(/\.csv$/i, "");
      const outName = `${baseName}__${detectedLanguage}_to_${selectedLanguage.name}.csv`;
      setResult({ summary: data.summary, csv: data.csv, fileName: outName, flaggedCount: data.flaggedCount ?? 0 });
    } catch {
      setError("Request failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col px-4 py-10">
      <header className="mb-6">
        <h1 className="text-lg font-semibold">CSV Localizer</h1>
        <p className="text-sm text-gray-500">Upload a CSV, pick a target language, get a localized CSV back. Supports English, Chinese (Traditional/Simplified), and Japanese source content.</p>
        {DEMO && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <span>
              Demo mode — no live API here. Load the sample product catalog, pick a language, and watch a full run.
            </span>
            <button
              onClick={loadSample}
              className="rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700"
            >
              Load sample CSV
            </button>
          </div>
        )}
      </header>

      <div className="space-y-5 rounded-lg border border-gray-200 bg-white p-6">
        {/* Step 1: Upload */}
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">1. CSV file</label>
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              const f = e.dataTransfer.files?.[0];
              if (f) handleFile(f);
            }}
            className={
              "flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors " +
              (dragActive ? "border-gray-900 bg-gray-50" : "border-gray-300 hover:border-gray-400")
            }
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
            {fileName ? (
              <div className="text-sm text-gray-700">
                📎 <span className="font-medium">{fileName}</span>
                <div className="mt-1 text-xs text-gray-400">Click or drop to replace</div>
              </div>
            ) : (
              <div className="text-sm text-gray-500">
                Drag & drop a CSV here, or <span className="font-medium text-gray-700">click to browse</span>
              </div>
            )}
          </div>
        </div>

        {/* Step 2: Detected Language (auto) */}
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">2. Detected Language</label>
          {!table ? (
            <div className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-400">
              Upload a CSV to auto-detect its language and translatable columns.
            </div>
          ) : !isSupportedSource ? (
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Detected language: <span className="font-medium">{detectedLanguage}</span>. This language isn&apos;t
              supported yet — supported source languages are English, Chinese, and Japanese.
            </div>
          ) : detectedColumns.length > 0 ? (
            <div className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
              <span className="font-medium">{detectedLanguage}</span> · {table.rows.length} rows ·{" "}
              {detectedColumns.length} translatable column{detectedColumns.length === 1 ? "" : "s"}:{" "}
              <span className="font-medium">{detectedColumns.join(", ")}</span>
            </div>
          ) : (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              No translatable columns detected in this file (detected language: {detectedLanguage}).
            </div>
          )}
        </div>

        {/* Step 3: Target language */}
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">3. Target language</label>
          <select
            value={selectedCode}
            onChange={(e) => setSelectedCode(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
          >
            <option value="">Select target language…</option>
            {availableTargetLanguages.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.name}
              </option>
            ))}
          </select>
        </div>

        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {loading ? (stage !== null ? `${DEMO_STAGES[stage]}…` : "Translating…") : "Translate"}
        </button>

        {DEMO && loading && stage !== null && (
          <ol className="space-y-1 text-sm">
            {DEMO_STAGES.map((label, i) => (
              <li key={label} className={i < stage ? "text-gray-400" : i === stage ? "font-medium text-gray-900" : "text-gray-300"}>
                {i < stage ? "✓" : i === stage ? "●" : "○"} {i + 1}. {label}
              </li>
            ))}
          </ol>
        )}

        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        {result && (
          <div
            className={
              "rounded-lg px-3 py-2 text-sm " +
              (result.flaggedCount > 0 ? "bg-amber-50 text-amber-800" : "bg-green-50 text-green-800")
            }
          >
            <div>{result.summary}</div>
            <button
              onClick={() => downloadCsv(result.csv, result.fileName)}
              className="mt-2 rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700"
            >
              Download {result.fileName}
            </button>
          </div>
        )}

        {result && <ResultPreview csv={result.csv} sourceColumns={table?.headers.length ?? 0} />}
      </div>
    </div>
  );
}

// The translated half of the output, so the result is visible without
// downloading the file.
function ResultPreview({ csv, sourceColumns }: { csv: string; sourceColumns: number }) {
  const out = parseCsv(csv);
  const headers = out.headers.slice(sourceColumns);
  if (headers.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="w-full text-left text-xs">
        <thead className="bg-gray-50 text-gray-500">
          <tr>
            {headers.map((h) => (
              <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {out.rows.slice(0, 6).map((row, i) => (
            <tr key={i} className="border-t border-gray-100">
              {headers.map((h) => (
                <td key={h} className="px-3 py-2 align-top text-gray-700">
                  {row[h]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
