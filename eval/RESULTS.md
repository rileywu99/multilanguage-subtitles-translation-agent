# CSV Localizer: small evaluation (EN to zh-TW)

Run on 2026-11-02 (PT) against the real pipeline in `src/lib` (no mocks, no demo replay). Every number comes from the JSON files in `eval/results/`.

This file has three parts:
- **Round 3 (top):** the fixes Riley approved after round 2, measured with the same 40 rows × 3 runs. "Before" is in `eval/results/v2/`, "after" is in `eval/results/v3/`.
- **Round 2:** Riley's quality criteria and the first measurement against them.
- **Round 1 (bottom):** the first 26-row eval and the header locale fix.

## Before → after, every criterion (round 3)

- 40 rows × 3 runs = 120 row-translations on each side. Same harness, same judge (Claude Opus 5.5).
- "Before" = commit `0a52f5a`. "After" = commit `d594416`.
- The "before" runs were **rescored offline** with the final `checks.mjs`, so both sides use identical code checks. Rescoring makes no API calls. Two changes are behind this:
  - `numbers` and `units` now accept 「8 折」 for "20% off" and 「第三季」 for "Q3", which ends the false positives.
  - `currency` now fails a doubled marker such as 「$19.99 美元」.
- The round 2 table further down shows the raw numbers as first measured.

| # | Criterion | Check | Type | Before | After | Remaining failure (after) |
|---|---|---|---|---|---|---|
| 1 | Concise wording | No added words or padding | judge | 75.0% (90/120) | **90.8%** (109/120) | 「請」 on plain imperatives, 「可供…使用」, 「自動」 |
| 1 | | Length ratio inside file range | code | 99.1% (116/117) | **100%** (117/117) | None |
| 1 | | Within `max_chars` | code | 100% | 100% | None |
| 2 | Person names | Kept exactly as typed | code | 0/24 occurrences | **24/24** | None |
| 2 | | Kept or glossary (round 2 definition) | code | 66.7% (12/18 rows) | **100%** (18/18) | None |
| 2 | | Same in every row of a file | code | 18/18 | 18/18 | None |
| 2 | | Same across the 3 runs, and acceptable | code | 1/5 names | **5/5** | None |
| 3 | Proper nouns | Kept as-is or official zh-TW form | code | 84.3% (43/51), 8 misuses | **100%** (51/51), **0 misuses** | None |
| 3 | | Same rendering in one file | code | 97.3% (72/74), 2 inconsistencies | **100%** (75/75), 0 | None |
| 3 | | Same rendering across runs | code | 3 terms change | **0** | None |
| 4 | Format | Placeholders / HTML / line breaks | code | 100% each | 100% each | None |
| 4 | | Structure (rows, columns, pass-through, no empty cells) | code | 3/3 files | 3/3 files | None |
| 4 | | Numbers preserved | code | 100% | 100% | None |
| 4 | | Dates / times in Taiwan format | code | 9/9 / 3/3 | 9/9 / 3/3 | None |
| 4 | | Currency (one marker, same figure) | code | 33.3% (2/6) | **100%** (6/6) | None |
| 4 | | Units (kept, not doubled) | code | 85.7% (18/21) | **100%** (21/21) | None |
| 4 | | Full-width punctuation | code | 100% | 100% | None |
| 5 | Locale terms | No Mainland terms | code | 100% | 100% | None |
| 5 | Register | One form of "you" per file | code | 87.0% of rows (40/46), 2/3 files | **100%** (48/48), **3/3 files** (all 您) | None |
| 5 | Leftover English | No untranslated English | code | 96.7% (116/120) | **98.3%** (118/120) | 「Pro 方案」 (plan name kept; arguably correct) |
| 5 | Meaning accuracy | Full meaning, right word sense | judge | 93.3% (112/120) | **96.7%** (116/120) | 「grace period on the invoice」 still awkward; 「信用卡號碼」 for "card number" |
| 5 | Fluency | Natural Taiwan Mandarin | judge | 95.0% (114/120) | **98.3%** (118/120) | The same grace-period row |
| 5+ | Spacing | Same spacing next to Latin/digits | code | 82.9% (63/76) | 89.3% (75/84) | 「8個字元」, 「75%時」 (not targeted by the fixes) |
| | Speed | Time per row | measured | 775 ms (31.0 s / file) | **1,129 ms** (45.1 s / file) | Regression, see below |
| | Cost | Pipeline cost per 100 rows | measured | $0.168 | **$0.210** | Regression, see below |

### What changed in the product (commit `d594416`)

1. **Names.**
   - For zh targets, the glossary pass now lists every person name, not only recurring ones.
   - Any Latin-script name, English or pinyin, is mapped to itself, so "Zhang Wei" stays "Zhang Wei".
   - Every batch prompt says never to transliterate or guess characters.
   - A caller-supplied `nameMap` overrides this. CJK-source names keep the old glossary rules: the change only applies when `isLatinScriptName` is true.
2. **Proper nouns.**
   - New config file `src/lib/localeConfig.ts` holds:
     - a default do-not-translate list (brands and acronyms)
     - official term maps for zh-TW and zh-CN (Google 試算表, Google 日曆, city names)
     - the Mainland avoid-list
     - the default register per locale
   - Requests can extend all of it through `TranslationOptions` (the API route accepts an optional `options` field).
   - The glossary pass also fixes one translation for each recurring ordinary term (for example account → 帳戶), and every batch prompt enforces it.
3. **Register.** zh-TW and zh-CN default to 您, configurable through `options.register`. Every batch gets the same instruction.
4. **Concision and format.** The batch prompt now says:
   - Translate only what the source says, with no added 「請」, 「系統將於…進行」, 「功能」, 「方案」, 「自動」 or 「產品」 unless the source implies them.
   - Write a dollar amount once.
   - Keep unit symbols without repeating the unit in words.
5. **Code checks with retry** (`cellProblems` in `localeConfig.ts`).
   - After each batch, the code checks:
     - names kept
     - do-not-translate terms kept
     - official terms used
     - register
     - avoid-list
     - doubled currency
     - doubled units
   - Any failure re-runs the batch once, naming the failing rows and rules. The better attempt per row is kept, and a row is never blanked for one of these soft failures.
   - Column headers also get an avoid-list check with one retry. This was the next step listed at the end of round 1.
6. **What the eval passed in.** The eval passed the three made-up names in this test set (Smart Import, Workspace Pro, Lexingtonight) as the request's `doNotTranslate` list, the way a customer would. Everything else came from the defaults.

### Did the retries fire?

No. Across the 3 after runs there were 4 batch calls and 1 header call per run, with no retry logs. So the improvement comes from the prompt and glossary rules, and the code checks found nothing to correct. They are a safety net that this sample did not trigger.

### Regressions

1. **Slower: 775 → 1,129 ms per row.**
   - The cause is the glossary pass. Before each batch runs, it now lists every name plus the recurring terms, and it runs alone.
   - It went from 9 to 21 s (911 to 1,732 output tokens) up to 26 to 39 s (2,643 to 3,874 output tokens).
   - The batch calls themselves got faster (13 to 19 s down to 8 to 10 s).
   - Suggested next step, not applied: lower effort on the glossary call, or run it alongside the first batches.
2. **More expensive: $0.168 → $0.210 per 100 rows (+25%).**
   - Same cause: glossary output tokens.
   - Batch costs were flat ($0.046 to $0.057 before, $0.041 to $0.049 after).
3. **Header mistranslation seen once: 「鑰匙」 (a physical key) for the `key` column** (after, run 2).
   - It contains no Mainland term, so the avoid-list check passes it, and round 2 and 3 do not judge headers.
   - The header prompt did not change apart from the retry path, which did not fire. So this is most likely Haiku run-to-run noise, but it is a real output a user would see.
   - Other header variants: 「型別」 for type (run 3), 「最大字數」 (run 2).

### Round 3 limits
- The same 40 rows that drove the fixes were used to measure them. Some of the gain may be fitting to this set; a fresh held-out set is the honest next test.
- The judge has still not been compared with Riley's hand labels.
- 3 runs per side.

### Round 3 spend
- Round 3 cost **$0.844**: pipeline $0.252, judge $0.593.
- Rounds 1 to 3 together cost about **$2.77**, all from prepaid API credits.

### Reproduce round 3
```bash
cd translation-agent
env -u NODE_OPTIONS node_modules/.bin/tsc -p eval/tsconfig.eval.json
for i in 1 2 3; do EVAL_OUT=v3 env -u NODE_OPTIONS node --env-file-if-exists=.env --env-file-if-exists=.env.local eval/run_eval.mjs v3_run$i; done
env -u NODE_OPTIONS node eval/rescore.mjs eval/results/v2/v2_run*.json   # apply final checks to the before runs
env -u NODE_OPTIONS node eval/aggregate.mjs eval/results/v2/v2_run1.json eval/results/v2/v2_run2.json eval/results/v2/v2_run3.json
env -u NODE_OPTIONS node eval/aggregate.mjs eval/results/v3/v3_run1.json eval/results/v3/v3_run2.json eval/results/v3/v3_run3.json
```

---

# Round 2: Riley's quality criteria (first measurement)

## Criteria table (round 2: 40 rows × 3 runs = 120 row-translations)

A pass rate counts only the rows a check applies to. For example, `dates` only applies to rows that contain a date.

| # | Criterion | Check | Type | Pass rate | Main failure |
|---|---|---|---|---|---|
| 1 | Concise wording | No added words, padding or explanation | judge | **75.0%** (90/120) | Adds 「請」, 「系統將於…進行」, 「功能」/「方案」, 「自動」, 「產品」 that the source does not have |
| 1 | | zh/en length ratio inside the file's normal range (1.5 × IQR) | code | 99.1% (116/117) | One outlier: `term.pay` kept "USD" next to the amount |
| 1 | | Within `max_chars` | code | 100% (120/120) | None. The limits in this set are generous for Chinese |
| 2 | Person names | Kept verbatim or rendered by the pipeline's name glossary | code | **66.7%** (12/18) | Pinyin names turned into guessed characters: Zhang Wei → 張偉, Liu Yang → 劉洋, in all 3 runs |
| 2 | | Same rendering in every row of one file | code | 100% (18/18) | None |
| 2 | | Same rendering across the 3 runs | code | **3/5 names stable, 1/5 stable and acceptable** | English names are transliterated, differently each run: Will Chen → 陳威爾 / 陳威廉 / 威爾·陳 |
| 3 | Proper nouns | Kept as-is, or the official zh-TW form | code | **84.3%** (43/51), **8 misuses** | Google Sheets and Google Calendar left in English (4); Smart Import translated to 「智慧匯入」 (4) |
| 3 | | Same source term, same rendering in every row of one file | code | 97.3% (72/74), **2 inconsistencies** | "account" → 帳戶 in one row and 帳號 in another (runs 1 and 2) |
| 3 | | Same rendering across the 3 runs | code | **3 terms change** | Google Sheets, Google Calendar and Smart Import each come out differently depending on the run |
| 4 | Format | Placeholders | code | 100% (120/120) | None |
| 4 | | HTML tags | code | 100% (120/120) | None |
| 4 | | Line breaks | code | 100% (120/120) | None |
| 4 | | Structure (rows, columns, pass-through columns, no empty cells) | code | 3/3 files | None |
| 4 | | Numbers preserved | code | 95.8% (115/120) | Both misses are correct zh-TW: 「8 折」 for "20% off" and 「第三季」 for "Q3" (checker false positives) |
| 4 | | Dates in Taiwan format (2026 年 3 月 3 日) | code | 100% (9/9) | None |
| 4 | | Times (上午/下午/晚上, no AM/PM) | code | 100% (3/3) | None |
| 4 | | Currency (same USD figure, one currency marker) | code | **33.3%** (2/6) | 「$19.99 美元」 marks the currency twice, in all 3 runs |
| 4 | | Units (°C, °F, GB, % kept, not doubled) | code | 71.4% (15/21) | 「攝氏0°C」 in all 3 runs; the rest are the 「8 折」 false positive |
| 4 | | Full-width punctuation in Chinese text | code | 100% (120/120) | None |
| 5 | Locale terms | No Mainland terms (文本, 字符, 軟件…) | code | 100% (120/120) | None |
| 5 | Register | One form of "you" (您 or 你) per file | code | 87.0% of rows (40/46); **2/3 files** | Run 3 mixed 您 (8 rows) and 你 (6 rows) in one file |
| 5 | Leftover English | No untranslated English words | code | 96.7% (116/120) | "Sheets", "Calendar" (the Google product names above) |
| 5 | Meaning accuracy | Full meaning, right word sense | judge | 93.3% (112/120) | 「延長…寬限期」 adds "extend" to "asked for a grace period" (3/3 runs); 「自動」 added |
| 5 | Fluency | Natural Taiwan Mandarin | judge | 95.0% (114/120) | 「$19.99 美元」; 「攝氏0°C」; 「林格蕾絲」 as a name |
| 5+ | Spacing (added: the data showed it) | Chinese next to Latin letters or digits spaced the same way across the file | code | 82.9% (63/76) | One file has both 「8 個字元」 and 「錯誤404」 |

## Round 2 details

### What changed from round 1
- **14 new rows, 40 in total.**
  - 6 rows with person names: English names (Will Chen, Grace Lin, Michael Johnson) and pinyin names (Zhang Wei, Liu Yang). "Will" also appears as a verb ("Will Chen will review") and "grace" as a common word ("a grace period").
  - 8 rows with proper nouns: product and feature names (Smart Import, Workspace Pro, Shopify, Apple Pay, PayPal), products with an official zh-TW name (Google Sheets → Google 試算表, Google Calendar → Google 日曆), places (Los Angeles → 洛杉磯, San Francisco → 舊金山, Taipei → 台北/臺北) and acronyms (API, PRD, SKU, CSV).
  - The new rows have tighter, realistic `max_chars` limits.
- **New checks.** All code checks are in `eval/checks.mjs`. They are pure functions, so `eval/rescore.mjs` can re-apply them to saved outputs with no API calls.
- **Judge.** Still Claude Opus 5.5, effort `low`, one call per row. It now answers three pass/fail questions: accuracy, fluency and a new **concise** question (no added words, padding or explanation).
- **Code under test.** Current `main`, including the round 1 header fix. No product code changed in round 2.
- **Policy used for proper nouns.** Product, feature and brand names stay exactly as written. A term with an official zh-TW form must use it. Recurring UI words (account, file, message, email, settings, plan, team, roadmap) may use any reasonable rendering, but only one per file.
- **Policy used for names.** A name must be kept verbatim, or rendered with whatever the pipeline's own glossary pass decided for that run. It must also be the same in every row and in every run.

### Per-name results

| Name | Rows | Run 1 | Run 2 | Run 3 | Kept or glossary | Same in file | Same across runs |
|---|---|---|---|---|---|---|---|
| Will Chen | 2 | 陳威爾 (glossary) | 陳威廉 (glossary) | 威爾·陳 (glossary) | yes | yes | **no** |
| Grace Lin | 2 | 林格雷絲 (glossary) | 林格蕾絲 (glossary) | 葛瑞絲·林 (glossary) | yes | yes | **no** |
| Michael Johnson | 2 | 麥可·強森 (glossary) | 麥可·強森 (glossary) | 麥可·強森 (glossary) | yes | yes | yes |
| Zhang Wei | 1 | 張偉 | 張偉 | 張偉 | **no** (not in glossary) | n/a | same, but a guess |
| Liu Yang | 1 | 劉洋 | 劉洋 | 劉洋 | **no** (not in glossary) | n/a | same, but a guess |

- "Will" as a verb and "grace period" were read correctly in all 3 runs (寬限期, not a name).
- **Why names drift.** The glossary pass (`src/lib/glossary.ts`) is told to transliterate names "into a natural, commonly-used name in the target script". So it turns English names into Chinese, and each run picks different characters.
- **Why pinyin names fail.** Zhang Wei and Liu Yang appear only once, so they are not in the glossary. The batch model then picks characters on its own. 張偉 is only one of several possible spellings (章偉, 張威…), so the output can name the wrong person.
- **Suggested fix (not applied).** For zh targets, keep Latin-script names verbatim unless the user supplies a mapping. This is a product decision for Riley. Many Taiwan apps show account names as typed.

### Proper-noun misuse and inconsistency counts

- **Misuse: 8 of 51 term occurrences.**
  - Google Sheets left in English (runs 1 and 2).
  - Google Calendar left in English (runs 2 and 3).
  - Smart Import translated to 「智慧匯入」 (runs 1 and 2, both rows each time).
  - Acronyms, brands and places were always right: API, PRD, SKU, CSV, Shopify, Apple Pay, PayPal, 洛杉磯, 舊金山, 台北.
- **In-file inconsistency: 2.** "account" was 帳戶 in the Settings row and 帳號 in the privacy row (runs 1 and 2).
- **Cross-run inconsistency: 3 terms.** Google Sheets, Google Calendar and Smart Import each depend on the run.

### Time and cost (round 2, 40 rows)

| | Run 1 | Run 2 | Run 3 | Mean |
|---|---|---|---|---|
| Total time | 28.0 s | 35.5 s | 29.4 s | 31.0 s |
| Per row | 701 ms | 887 ms | 736 ms | 775 ms |
| Pipeline cost, 40 rows | $0.0635 | $0.0670 | $0.0704 | $0.0670 |
| Pipeline cost per 100 rows | $0.159 | $0.168 | $0.176 | **$0.168** |
| Judge cost | $0.231 | $0.230 | $0.224 | $0.228 |

Round 2 spend: **$0.886** (pipeline $0.201, judge $0.685). Round 1 was $1.03, so the whole eval cost **about $1.92** in prepaid API credits.

### Round 2 limits
- **Checker false positives.** `numbers` and `units` flag correct localizations (「8 折」, 「第三季」). They are counted as failures in the table but named in the "Main failure" column.
- **Rules are encoded policy.** "Smart Import stays English" and "Google Sheets must be Google 試算表" are rules this eval sets, not facts. Riley may decide otherwise.
- **The concise judge is strict by design.** It fails 「請」 on imperatives, which many Taiwan UI style guides accept. That is why it is the right thing for Riley to hand-label.
- **Small sample.** 3 runs; cross-run results are based on 3 samples per name or term.

### Rows for Riley to hand-label on the new criteria

Mark pass or fail for each column, then compare with the judge and code results. Run files are in `results/v2/`.

| # | Run | key | Source | Translation | Judge (acc / flu / concise) | Code flags | Riley: names / terms / concise / register |
|---|---|---|---|---|---|---|---|
| 1 | 1 | name.share | Grace Lin shared the Q3 Roadmap with you. | 林格雷絲與您分享了第三季路線圖。 | pass / pass / pass | numbers (Q3 → 第三季) | |
| 2 | 2 | name.welcome | Thanks, Zhang Wei! Your API key is ready. | 謝謝您，張偉！您的 API 金鑰已經準備好了。 | pass / pass / pass | names (pinyin → 張偉) | |
| 3 | 1 | term.import | Smart Import is included in Workspace Pro. | 智慧匯入功能已包含在Workspace Pro方案中。 | pass / pass / fail | terms (Smart Import translated), spacing | |
| 4 | 3 | pricing.pro | Pro plan: $19.99/month, billed annually at $199. | 專業方案：每月 $19.99 美元，年繳 $199 美元。 | pass / fail / fail | currency (double marker) | |
| 5 | 3 | term.calendar | Add this meeting to Google Calendar. | 把這個會議加到 Google Calendar 裡吧！ | pass / pass / fail | terms (official form is Google 日曆), leftover English | |

Row 5 is also a register check: 「吧！」 is casual, and that run mixed 您 and 你.

### Reproduce round 2

```bash
cd translation-agent
env -u NODE_OPTIONS node_modules/.bin/tsc -p eval/tsconfig.eval.json
for i in 1 2 3; do env -u NODE_OPTIONS node --env-file-if-exists=.env --env-file-if-exists=.env.local eval/run_eval.mjs v2_run$i; done
env -u NODE_OPTIONS node eval/rescore.mjs eval/results/v2/v2_run*.json   # optional, offline
env -u NODE_OPTIONS node eval/aggregate.mjs eval/results/v2/v2_run1.json eval/results/v2/v2_run2.json eval/results/v2/v2_run3.json
```

The double-currency rule was added to `checks.mjs` after the 3 runs, once the judge had pointed out the problem. The saved runs were rescored offline with `rescore.mjs`, which makes no API calls.

---

# Round 1: first eval and the header locale fix

The harness for round 1 is `eval/run_eval.mjs` at commit `d0c37c4`. The current file is the round 2 version.

## 1. What was tested

- **Pipeline under test:** the same functions the `/api/translate` route calls: `detectTranslatableColumns` (rules), `analyzeContext` (Claude Haiku 4.5), `translateTable` (glossary pass and 12-row batches on Claude Sonnet 5, header labels on Claude Haiku 4.5, then the built-in validation and retry).
- **Target language:** Chinese (Traditional), `zh-TW`, so Riley can spot-check as a native speaker.
- **Harness:** `tsc -p eval/tsconfig.eval.json` compiles `src/lib/*.ts` to `eval/.build/`, and `eval/run_eval.mjs` imports those modules directly. It wraps the Anthropic client to read `usage` from every API response.

## 2. Eval set (`eval/dataset.csv`)

Round 1 used the first 26 rows (rows 27 to 40 were added in round 2). 4 columns: `key`, `type`, `text`, `max_chars`. Only `text` should be translated; `key`, `type` and `max_chars` must pass through untouched.

| Category | Rows | Examples |
|---|---|---|
| Short UI strings | 4 | `Save changes`, `Cancel`, `Error 404: Page not found` |
| Placeholders | 6 | `{name}`, `%d`, `%s`, `{{count}}`, `%1$s / %2$s`, `{first_name} #{order_id} {date}` |
| HTML | 3 | `<a href="/terms">`, `<strong>`/`<em>`, `<br>` |
| Numbers, units, dates, money | 5 | `$19.99`, `50 GB`, `March 3, 2026 9:30 PM PT`, `0°C (32°F)`, `75%` |
| Brand names (must stay as-is) | 5 | Notion, Stripe, Lexingtonight, Slack + n8n, iPhone |
| Longer descriptions | 2 | onboarding paragraph, privacy notice with a `Settings > Privacy` path |
| Multi-line cell | 1 | quoted CSV cell with a real line break |

Some rows cover more than one category (for example, the onboarding row also has "CSV").

## 3. Method

**Layer 1: code checks (deterministic), per row.** A row passes only if all of these hold:
- `non_empty`: translation is not blank
- `placeholders`: the same multiset of `{x}`, `{{x}}`, `%s`, `%d`, `%1$s` tokens as the source
- `html`: the exact same tag sequence, attributes included
- `numbers`: every number in the source appears in the output
- `brands`: every brand name in the source appears verbatim
- `line_breaks`: same number of `\n`
- `locale_terms`: no Mainland-China UI terms (文本, 字符, 軟件, 網絡, 信息, 默認, 視頻, 鏈接, 設置, 登錄, 賬)
- `translated`: output is not just the English copied through

File-level checks on every run: output row count = input row count, output column count = 2 × input, pass-through columns identical in both the original and the translated copy, `flaggedCount` from the pipeline.

**Layer 2: LLM judge, per row.** Claude Opus 5.5 (a different model from the Sonnet 5 translator), effort `low`, one call per row. It returns pass/fail for **accuracy** (full meaning, no additions or omissions) and **fluency** (natural Taiwan Mandarin, Taiwan terms), plus a one-sentence reason. A row passes the judge only if both pass. The judge also scored the 4 translated column headers.

**Time:** wall clock from column detection to the finished table (all model calls included, judge excluded), divided by 26 for per row.

**Cost:** input and output tokens from each response's `usage`, times list price (from the claude-api skill model table, cached 2026-10-06): Sonnet 5 $2 / $10 per 1M tokens in / out, Haiku 4.5 $1 / $5, Opus 5.5 (judge) $4 / $20. Cost per 100 rows = pipeline cost / 26 × 100. Judge cost is reported separately because it is not part of the product.

Each condition was run **3 times** because model output changes from run to run.

## 4. Results

### The four headline numbers (mean of 3 runs, range in brackets)

| Metric | Before fix | After fix |
|---|---|---|
| (a1) Code-check pass rate, rows | **97.5%** [96.2 to 100] | **97.5%** [96.2 to 100] |
| (a2) LLM-judge pass rate, rows | **97.5%** [96.2 to 100] | **93.6%** [84.6 to 100] |
| (a3) Column headers free of Mainland terms | **9 / 12 (75%)** | **11 / 12 (92%)** |
| (b) Processing time, total for 26 rows | **14.8 s** [10.6 to 17.3] | **20.3 s** [15.2 to 26.9] |
| (b) Processing time, per row | **569 ms** | **782 ms** |
| (c) Pipeline cost, 26 rows | **$0.0311** | **$0.0382** |
| (c) Pipeline cost per 100 rows | **$0.120** | **$0.147** |

File-level checks passed on all 6 runs: 26 rows in, 26 out; 8 columns out; `key`, `type`, `max_chars` untouched; only `text` detected as translatable; `flaggedCount` 0.

**How to read the after column.** The fix only touches the header call. Row translations, time and most of the cost come from the Sonnet batch calls, which the fix does not change. So the row and time differences between the columns are run-to-run noise, not an effect of the fix:
- Output tokens on the same input ranged from 1,427 to 2,967 across the six runs. That alone explains the cost and time spread.
- The fix itself adds about 62 input tokens to one Haiku call: $0.00006 per file.
- after_3 had the lowest judge score (84.6%). In that run Sonnet left `Share`, `Add to Home Screen` and `Settings > Privacy` in English. Those rows passed in the other 5 runs.

### Per-run detail

| Run | Code pass | Judge pass | Both | Headers clean | Time | Out tokens | $ / 100 rows |
|---|---|---|---|---|---|---|---|
| baseline_initial | 96.2% | 100% | 96.2% | 2/4 (文本, 最大字符數) | 16.5 s | 1,999 | 0.122 |
| baseline_1 | 100% | 96.2% | 96.2% | 3/4 (最大字符數) | 10.6 s | 1,427 | 0.100 |
| baseline_2 | 96.2% | 96.2% | 92.3% | 4/4 | 17.3 s | 2,383 | 0.137 |
| after_1 | 96.2% | 100% | 96.2% | 4/4 | 15.2 s | 2,201 | 0.130 |
| after_2 | 96.2% | 96.2% | 92.3% | 3/4 (文本) | 18.8 s | 2,735 | 0.151 |
| after_3 | 100% | 84.6% | 84.6% | 4/4 | 26.9 s | 2,967 | 0.160 |

`baseline_initial` ran before the `locale_terms` check and the header judge were added to the harness. Its cells were re-checked from the saved output afterwards (0 Mainland terms), so its row numbers are comparable. Its headers were checked for Mainland terms but not judged.

Per code check, across all 156 row-translations (6 runs × 26): placeholders 100%, HTML 100%, brands 100%, line breaks 100%, non-empty 100%, Mainland terms in cells 0, untranslated 0. The only code-check failure was `numbers` on the promo banner (4 of 6 runs): "save 20%" became 「8折」. That is correct Taiwan retail wording, and the judge passed it every time. It is a false positive of a strict check, but it is also worth a human look, because a promo number that changes form can matter legally.

### Header probe (bigger sample for the fix)

Four headers per run is too few to measure a slip that happens a few percent of the time. So `eval/probe_headers.mjs` calls the pipeline's own `translateHeaders()` many times, from builds of the original code (v0) and the fixed code (v1):

| Probe | Original code (v0) | Fixed code (v1) |
|---|---|---|
| The 4 dataset headers × 30 runs, with a real context-analyzer result | **5 / 120 Mainland labels (4.2%)**: 文本 ×3, 最大字符數 ×2 | **0 / 120** |
| 14 tempting headers (file_name, video_url, login_count...) × 10 runs, fixed context | **2 / 140 (1.4%)**: 最大字符數, 最大字符 | **0 / 140** |

A third build (v2: fixed prompt plus headers on Sonnet 5) also scored 0/120 and 0/140 at about 3× the header cost, so it was not adopted.

## 5. The failure and the fix

**Failure.** The translated column headers sometimes used Mainland-China terms in a zh-TW file: 「文本」 for *text* and 「最大字符數」 for *max_chars* (Taiwan: 文字, 字元). The cells underneath were always in Taiwan usage, so the file came out mixed.

**Root cause.** `translate.ts` has a `LOCALE_REGISTER_NOTES` table that tells the model to use Taiwan terms for zh-TW. The cell-translation prompt includes it. The header prompt (`translateHeaders`, on Haiku) never did.

**Fix (5 lines in `src/lib/translate.ts`).** `translateHeaders` now adds the same locale note to its system prompt. No new rules, no eval-specific word list in the product.

**Effect.** Mainland header labels went from 5/120 to 0/120 in the probe, and from 3/12 to 1/12 in the full runs. The one slip that remained after the fix (文本 in after_2) means a prompt note alone is not a guarantee. The next step would be a deterministic header check with a retry, the same pattern the pipeline already uses for leftover kana in cells.

## 6. Other things the eval surfaced (not fixed)

1. **Formal vs informal "you" flips between runs.** Four runs used 您 throughout, two used 你 throughout. Each file is consistent inside itself, but two uploads of the same file can come back in different registers. A fixed register per locale (or per user choice) in the prompt would fix it.
2. **"Scheduled maintenance" became 「例行維護」 (routine maintenance)** in 4 of 6 runs; 「預定維護」 would be accurate. The judge failed it in 3 of those 4 and passed it once, so the judge is not fully consistent either.
3. **UI labels left in English** (`Settings > Privacy`, `Share`) in 1 of 6 runs.
4. **Unit doubled:** 「攝氏0°C」 says Celsius twice. The judge flagged it once.
5. **Spacing between Chinese and numbers is inconsistent** (「8個字元」 next to 「50 GB 儲存空間」). Not measured by any check yet.

## 7. Limits

- **Small sample.** 26 rows, one language pair, one domain (software UI). 3 runs per condition. The row-level differences between before and after are inside run-to-run noise.
- **The LLM judge has not been checked against a human yet.** Per run it passed 84.6 to 100% of rows, and it scored the same 「例行維護」 output as a pass once and a fail three times. It may be lenient and it is not fully consistent. The 5 rows below are for that comparison.
- **Synthetic set.** Rows were written for this eval, not taken from a real customer file.
- **Code checks are strict proxies.** The number check flagged a correct 「8折」; the Mainland-term list is short and hand-picked.
- **Prices are list prices** from the skill's model table, not an invoice.
- **Time is API latency from one laptop**, sequential runs, no load.

## 8. Rows for Riley to spot-check by hand

Please mark each as pass or fail for accuracy and for fluency, then compare with the judge column. All five are from `results/after_3.json` (the run with the most judge failures).

| # | key | Source | Translation | Judge (acc / flu) | Riley (acc / flu) |
|---|---|---|---|---|---|
| 1 | notice.maintenance | Scheduled maintenance on March 3, 2026 from 9:30 PM to 11:00 PM PT. | 系統將於 2026 年 3 月 3 日晚上 9:30 至 11:00（PT）進行例行維護。 | fail / pass | |
| 2 | help.iphone | Open the app on your iPhone and tap Share, then Add to Home Screen. | 在 iPhone 上開啟 App，點一下「Share」，然後選擇「Add to Home Screen」。 | fail / fail | |
| 3 | legal.privacy | We only use your data to provide the service. You can export or delete your account at any time from Settings > Privacy. | 我們只會將你的資料用於提供服務。你可以隨時從 Settings > Privacy 匯出或刪除你的帳號。 | fail / fail | |
| 4 | onboarding.intro | Start by importing a CSV file. We will detect which columns need translation, keep IDs and prices untouched, and return a localized copy you can download in under a minute. | 先匯入一個 CSV 檔案，我們會自動偵測哪些欄位需要翻譯，保留 ID 和價格不變，並在一分鐘內提供可下載的在地化版本。 | pass / pass | |
| 5 | email.shipped | Hi {first_name}, your order #{order_id} has shipped and should arrive by {date}. | 嗨 {first_name}，你的訂單 #{order_id} 已出貨，預計 {date} 前送達。 | pass / pass | |

## 9. Spend

| Item | USD |
|---|---|
| 6 full runs, pipeline | 0.208 |
| 6 full runs, judge (Opus 5.5) | 0.672 |
| Header probes (2 probes × 3 builds) | 0.150 |
| One context-analyzer call in the dataset probe (Haiku, not metered) | under 0.001 |
| **Total** | **about $1.03** |

## 10. Reproduce

```bash
cd translation-agent
env -u NODE_OPTIONS node_modules/.bin/tsc -p eval/tsconfig.eval.json
env -u NODE_OPTIONS node --env-file-if-exists=.env --env-file-if-exists=.env.local eval/run_eval.mjs <label>
```

`env -u NODE_OPTIONS` is only needed on this machine (a terminal preload breaks `node`). The probe needs the three builds in `eval/.build-probe/` (git-ignored): v0 = `git show c3f2fff:src/lib/translate.ts`, v1 = current `translate.ts`, v2 = v1 with `UTILITY_MODEL` swapped for `TRANSLATION_MODEL` in `translateHeaders`. Each gets `export { translateHeaders };` appended and is compiled with `tsc` to `.build-probe/<v>/out`. Then `node eval/probe_headers.mjs 30 dataset` or `node eval/probe_headers.mjs 10 wide`.
