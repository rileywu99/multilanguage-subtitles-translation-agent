# Multilingual Translation Agent

CSV translation agent built for the CTW Inc. AI Product Manager technical assessment. Upload a CSV, it figures out on its own which columns need translating, and returns a translated copy — no manual column mapping, no per-file prompt engineering.

**Live demo:** https://translation-agent-rho.vercel.app

## What it does

- Auto-detects the source language (English, Chinese, or Japanese) and which columns are actually translatable, as opposed to IDs/prices/codes
- Translates into one of four target languages: English (USA), Chinese (Traditional), Chinese (Simplified), Japanese
- Translates every column header too — not just the columns whose values change — so the output reads as a fully localized file
- Keeps names consistent across an entire file (not just within one batch) via a dedicated glossary pass
- Flags unsupported source languages and hides same-language targets from the picker before you can submit a no-op request

## How it works

Four stages, each doing one job — deterministic code wherever the rule is crisp and cheap to check, a model call only where real judgment is required:

1. **Schema & Column Detector** (deterministic) — CJK/kana/hangul density or English-phrase density per column
2. **Context & Domain Analyzer** (Claude Haiku, 1 call per job) — samples 5 rows, classifies domain/tone to steer word choice
3. **Parallel Translation Engine** (Claude Sonnet) — a full-file glossary pass first, then 12-row batches at 10-way concurrency
4. **Validation & Quality Guard** (deterministic) — row-alignment and leftover-source-script checks, retries a batch once before flagging it

## Run locally

```bash
npm install
cp .env.example .env   # add your ANTHROPIC_API_KEY
npm run dev
```

## Tech stack

- Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4
- `@anthropic-ai/sdk` — `claude-sonnet-5` for translation/glossary, `claude-haiku-4-5` for domain analysis and header labels
- `papaparse` for CSV parsing/serialization (including quoted multi-line cells)
- Deployed on Vercel

## Limits

- 500 rows per request
- Single target language per request (the backend accepts an array; the UI is intentionally scoped to one at a time)
