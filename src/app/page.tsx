"use client";

import { useRef, useState } from "react";
import { detectSourceLanguage, detectTranslatableColumns, parseCsv, type CsvTable } from "@/lib/csv";
import { COMMON_LANGUAGES } from "@/lib/languages";

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

  const canSubmit =
    Boolean(csvText) && isSupportedSource && detectedColumns.length > 0 && selectedLanguage !== null && !loading;

  async function handleSubmit() {
    if (!csvText || !fileName || !selectedLanguage) return;
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
        <h1 className="text-lg font-semibold">Multilingual Translation Agent</h1>
        <p className="text-sm text-gray-500">Upload a CSV, pick a target language, get a translated CSV back. Supports English, Chinese (Traditional/Simplified), and Japanese source content.</p>
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
              Detected language: <span className="font-medium">{detectedLanguage}</span>. This language isn't
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
          {loading ? "Translating…" : "Translate"}
        </button>

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
      </div>
    </div>
  );
}
