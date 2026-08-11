# Salesforce Contact Auditor

This tool audits a Salesforce contact export against ZoomInfo and flags each contact's employment status,
so a human only has to review the ambiguous cases instead of searching every name by hand.

You give it an `.xlsx` export and a worksheet tab name, and run one of two commands. `search`
checks every row against ZoomInfo's Contact Search API, verifies each candidate's identity
strictly (exact first + last name), and writes an annotated copy of the sheet with a status per
row — it never overwrites an existing column. `enrich` takes the confirmed `ACTIVE` rows from
that sheet and updates their phone/email/title fields by ZoomInfo person ID — an exact lookup, no
re-matching — writing straight into your original columns so the result is ready to reload into
Salesforce. Neither command modifies your input file or touches Salesforce directly.

**Design rationale and code-flow diagram:** [docs/architecture.md](docs/architecture.md)

---

## What the tool does vs. what you do

| The tool (automated) | You (human) |
| --- | --- |
| Searches every contact by name + company, with an email fallback | Adjudicate `INACTIVE` rows where the company names just differ in spelling |
| Rejects any candidate whose name isn't an exact match | Hand off `NAME_MISMATCH` and `NOT_FOUND` rows for manual review — one bucket for reviewers, but each keeps its own status |
| Flags each row `ACTIVE` / `INACTIVE` / `NAME_MISMATCH` / `NOT_FOUND` / `ERROR` | Treat the `NOT_FOUND` count as an upper bound, not a verdict |
| Captures the ZoomInfo person ID, current company, and job title for every match | Confirm `ACTIVE` rows (and any recovered `NAME_MISMATCH`/`INACTIVE` rows) before handing the sheet to `enrich` |
| Pulls current phone / email / job title by ZoomInfo person ID and writes them straight into your original columns | Load the result into Salesforce — the tool never touches Salesforce itself |

The strictness in `search` is deliberate: `enrich` updates real contact fields by ZoomInfo person
ID, so a wrong-person match doesn't just mislabel a row — it corrupts a real contact's data. The
tool fails toward the cheap error (a human review) rather than the expensive one (a bad record).

---

## Setup

1. **Node.js 22 or newer** (the tool uses Node's built-in `fetch`; developed and tested on 24).
2. Install dependencies:

   ```
   npm install
   ```

3. **ZoomInfo credentials.** The tool authenticates with ZoomInfo's Client Credentials Flow — a
   `CLIENT_ID` / `CLIENT_SECRET` pair issued from the ZoomInfo admin portal (Admin → API). Copy
   `.env.example` to `.env` and fill in both values. The tool exchanges them for a short-lived
   bearer token automatically; you never handle tokens yourself.

   > `.env` is gitignored. Keep it that way — never commit real credentials.

4. **Input file.** Place the export under `data/input/` (the whole `data/` directory is gitignored
   because it contains real people's information). Requirements:
   - `.xlsx` workbook; each contact list is a worksheet tab (you name the tab at run time)
   - Row 1 is a header row containing at least these headers (any casing, any column position):
     **First Name**, **Last Name**, **Account Name**, **Email**
   - Columns **V through AB must be empty** — the tool writes its results there

## Running an audit

```
npm run dev -- search data/input/ContactExport.xlsx --worksheet Carter
```

- `--worksheet` (`-w`) is required — it picks the tab to audit, and names the output file.
- Or run the compiled build: `npm run build`, then `npm start -- search <file> -w <tab>`.
- A ~2,900-row tab takes **2.5–5 minutes**. Requests are paced at 20/second to stay under
  ZoomInfo's rate limits — this is normal, don't kill it.
- When it finishes you get a summary line
  (`X active, Y inactive, Z name mismatch, N not found, E errors`) and an annotated copy of the
  sheet at **`data/output/annotated_<tab>.xlsx`**.

## Reading the output

Your original columns (A–U) are untouched during the `-- search` operation. The search results are appended in new columns:

| Col | Header | What it holds |
| --- | --- | --- |
| V | `Inferred Contact Status` | The verdict — see the status table below |
| W | `ZoomInfo Person ID` | The key `enrich` looks up by. Stored as text — **don't** reformat it as a number (Excel will mangle it into `1.4E+10`) |
| X | `ZoomInfo Company Name` | The person's *current* employer per ZoomInfo |
| Y | `ZoomInfo Company ID` | The internal ZoomInfo ID for a requested company. Useful with manual API lookups. |
| Z | `ZoomInfo Title` | Current job title (free with search) |
| AA | `Tool Notes` | Multi-match notes, rejection counts, or the error message on `ERROR` rows |
| AB | `ZoomInfo Rejected Candidates` | `NAME_MISMATCH` only: up to 5 near-miss candidates for eyeball review |

### The five statuses — and who resolves each one

| Status | Meaning | What to do |
| --- | --- | --- |
| `ACTIVE` | Identity verified, still at the company in your sheet | Nothing to review — this row is ready for `enrich` as-is |
| `INACTIVE` | Identity verified, but ZoomInfo shows a *different* current employer | Review: compare `Account Name` (I) against `ZoomInfo Company Name` (X). Company names differ across systems (`Acme Corp` vs `Acme Corporation`), so some of these are false — an AI-assisted diff pass is the plan of record (see architecture §4). A recovered row already has its person ID |
| `NAME_MISMATCH` | ZoomInfo returned candidates, but none matched the name exactly (nicknames land here on purpose: `Mike` vs `Michael`) | Reviewed together with the `NOT_FOUND` bucket (handed off to other reviewers), but kept as its own status so the rows stay identifiable. For the reviewer: compare column AB against the row's name; if it's the same person, change **column V** to `ACTIVE` — columns W–Z already hold that candidate's details. Never edit Salesforce's own columns |
| `NOT_FOUND` | Nothing came back from name+company *or* the email fallback | Manual / LinkedIn review. Treat as an upper bound, not a verdict — rows with no email address only got one search attempt |
| `ERROR` | A request failed; the message is in `Tool Notes` (AA) | Re-run the same command. Errors aren't cached but successes are, so a re-run only retries the failures |

**Before enrichment:** make sure every row you want enriched is actually marked `ACTIVE` in column
V — `enrich` only processes rows with status `ACTIVE` and a non-blank `ZoomInfo Person ID` (W);
everything else is silently skipped. Nothing reaches enrichment without either passing the
exact-name check in `search` or being explicitly flipped to `ACTIVE` by a person.

## The cache

Every successful lookup is cached, keyed differently per command:

| Command | Cache file | Keyed by |
| --- | --- | --- |
| `search` | `data/cache/search_cache.store` | name + company |
| `enrich` | `data/cache/enrich_cache.store` | ZoomInfo person ID |

This is what makes re-runs cheap: if a run dies partway through (or, for `enrich`, hits a bug on
some rows), fixing the problem and re-running costs zero API calls for the rows already cached.
Errors are never cached, so a re-run only retries the rows that failed.

**Delete the relevant cache file** before re-running if:

- you changed any matching/enrichment logic (normalization, fallback, name rules, output fields) —
  stale verdicts are otherwise served verbatim, or
- enough time has passed that you want fresh answers from ZoomInfo.

## Phase 2: enrich

```
npm run dev -- enrich data/input/ContactExport.xlsx --worksheet ACTIVE
```

Reads the given tab, keeps only rows already marked `ACTIVE` with a ZoomInfo Person ID, and looks
each one up by that ID via ZoomInfo's Contact Enrich endpoint — an exact lookup, no re-matching.
It's a separate explicit subcommand so it can never fire by accident: Contact Enrich is ZoomInfo's
billable tier, and an accidental run burns credits.

**Unlike `search`, `enrich` overwrites your original columns** — `Email`, `Title`, `Phone`, and
`Mobile` are updated in place with ZoomInfo's current values (located by header name, not fixed
column letters), so the output is ready to reload into Salesforce as-is. Only fields ZoomInfo
actually returns are written; a field it doesn't return is left untouched, so no cell is ever
blanked. Each written cell gets a light-orange highlight so a reviewer can see exactly what
changed. `Tool Notes` (AA) is appended to (with a ` | ` separator) rather than overwritten, so a
note left by `search` survives alongside anything `enrich` adds.

DoNotCall flags (`directPhoneDoNotCall` / `mobilePhoneDoNotCall`) are **not** checked — every
number ZoomInfo returns gets written. That's a deliberate choice: the manual audit process never
considered the DNC flag either, and enforcement belongs to Salesforce's own DNC settings once the
sheet is loaded back in, not to this tool.

Output: `data/output/enriched_<tab>.xlsx`.

### Notes you may see in the `Tool Notes` column

ZoomInfo's match status is only noted when it isn't a full, clean match — most rows get no note at
all. Two different situations produce a note:

| Note | Meaning | Are Email/Title/Phone/Mobile updated? |
| --- | --- | --- |
| `CONTACT_ONLY_MATCH` (and similar non-`FULL_MATCH` statuses) | ZoomInfo matched the person but flagged the match as less than fully confident | Yes — fields are written, note is just informational |
| `NO_MATCH` | ZoomInfo can no longer resolve this person ID — the record was likely merged, deduplicated, or retired since `search` ran | No — row is left as-is |
| `OPT_OUT` | The person opted out of ZoomInfo's data collection | No — row is left as-is |
| `Error during enrichment: ...` | The API request itself failed | No — not cached, so a re-run retries it automatically |

None of these indicate a problem with the tool or with the person ID captured during `search` —
ZoomInfo's underlying data simply changes over time. A handful out of a few thousand rows is
normal churn, not something to chase down.

## Troubleshooting

| Symptom | Cause & fix |
| --- | --- |
| `Missing expected column "..."` | The most likely break with a future export: the header row must contain **First Name**, **Last Name**, **Account Name**, and **Email** (any casing, any position). Rename the headers in the sheet to match |
| `Worksheet "X" not found ... Available worksheets: ...` | Typo in `--worksheet` — the error lists the workbook's actual tab names; pass one of those |
| Write fails at the end of a run | The output file is probably open in Excel. Close it and re-run — the cache makes the re-run free |
| `401` errors | Bad or expired credentials in `.env` |
| `429` errors | Rate limit. The built-in throttle normally prevents this — if it appears, something else is sharing the ZoomInfo account's quota. Wait and re-run |
| Person IDs display as `1.40628E+10` | Column W was reformatted as a number. The tool writes IDs as text; undo the formatting or re-run |
| Results look wrong after a code change | Stale cache — delete `data/cache/search_cache.store` (or `enrich_cache.store`) and re-run |
| `enrich` skips rows you expected it to process | Row isn't marked `ACTIVE` in column V, or `ZoomInfo Person ID` (W) is blank — both are required |

## Project layout

```
src/
├── cli.ts        # entry point: arg parsing, subcommand routing, top-level error handling
├── search.ts     # phase 1 workflow: per-contact search, status derivation
├── enrich.ts     # phase 2 workflow: per-contact enrich by ZoomInfo person ID
├── auth.ts       # ZoomInfo token exchange + in-memory token cache
├── zoominfo.ts   # Contact Search + Contact Enrich API clients + request-level rate throttle
├── excel.ts      # sheet reading (header-keyed), annotated-output writing, enrich write-back
└── cache.ts      # JSON result cache, shared file format for both search and enrich results
names.csv         # nickname → formal-name lookup, for a future nickname-matching rule (unused today)
```

`docs/architecture.md` records the full design, its rationale, and every decision that got
reversed along the way — read it before changing matching logic.
