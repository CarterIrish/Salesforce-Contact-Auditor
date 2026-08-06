# Salesforce Contact Auditor

Audits a Salesforce contact export against ZoomInfo and flags each contact's employment status,
so a human only has to review the ambiguous cases instead of searching every name by hand.

You give it an `.xlsx` export and a worksheet tab name. It searches every row against ZoomInfo's
Contact Search API, verifies each candidate's identity strictly (exact first + last name), and
writes an annotated copy of the sheet with a status per row. It never modifies your input file,
never touches Salesforce, and never overwrites an existing column.

**Design rationale and code-flow diagram:** [docs/architecture.md](docs/architecture.md)

---

## What the tool does vs. what you do

| The tool (automated) | You (human) |
| --- | --- |
| Searches every contact by name + company, with an email fallback | Adjudicate `INACTIVE` rows where the company names just differ in spelling |
| Rejects any candidate whose name isn't an exact match | Hand off `NAME_MISMATCH` and `NOT_FOUND` rows for manual review — one bucket for reviewers, but each keeps its own status |
| Flags each row `ACTIVE` / `INACTIVE` / `NAME_MISMATCH` / `NOT_FOUND` / `ERROR` | Treat the `NOT_FOUND` count as an upper bound, not a verdict |
| Captures the ZoomInfo person ID, current company, and job title for every match | Filter confirmed `ACTIVE` rows into `verified.xlsx` — the input for phase 2 (enrich) |

The strictness is deliberate: phase 2 will update Salesforce records by ZoomInfo person ID, so a
wrong-person match doesn't just mislabel a row — it corrupts a real contact's data. The tool fails
toward the cheap error (a human review) rather than the expensive one (a bad record).

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

Your original columns (A–U) are untouched — including Salesforce's own `Contact Status` column,
which belongs to the CRM, not this tool. The results are appended in new columns:

| Col | Header | What it holds |
| --- | --- | --- |
| V | `Inferred Contact Status` | The verdict — see the status table below |
| W | `ZoomInfo Person ID` | The key phase 2 will enrich by. Stored as text — **don't** reformat it as a number (Excel will mangle it into `1.4E+10`) |
| X | `ZoomInfo Company Name` | The person's *current* employer per ZoomInfo |
| Y | `ZoomInfo Company ID` | Ground-truth company identifier, for company-name adjudication |
| Z | `ZoomInfo Title` | Current job title (free with search) |
| AA | `Tool Notes` | Multi-match notes, rejection counts, or the error message on `ERROR` rows |
| AB | `ZoomInfo Rejected Candidates` | `NAME_MISMATCH` only: up to 5 near-miss candidates for eyeball review |

### The five statuses — and who resolves each one

| Status | Meaning | What to do |
| --- | --- | --- |
| `ACTIVE` | Identity verified, still at the company in your sheet | Nothing — this row is done. Goes into `verified.xlsx` |
| `INACTIVE` | Identity verified, but ZoomInfo shows a *different* current employer | Review: compare `Account Name` (I) against `ZoomInfo Company Name` (X). Company names differ across systems (`Acme Corp` vs `Acme Corporation`), so some of these are false — an AI-assisted diff pass is the plan of record (see architecture §4). A recovered row already has its person ID |
| `NAME_MISMATCH` | ZoomInfo returned candidates, but none matched the name exactly (nicknames land here on purpose: `Mike` vs `Michael`) | Reviewed together with the `NOT_FOUND` bucket (handed off to other reviewers), but kept as its own status so the rows stay identifiable. For the reviewer: compare column AB against the row's name; if it's the same person, change **column V** to `ACTIVE` — columns W–Z already hold that candidate's details. Never edit Salesforce's own columns |
| `NOT_FOUND` | Nothing came back from name+company *or* the email fallback | Manual / LinkedIn review. Treat as an upper bound, not a verdict — rows with no email address only got one search attempt |
| `ERROR` | A request failed; the message is in `Tool Notes` (AA) | Re-run the same command. Errors aren't cached but successes are, so a re-run only retries the failures |

**After review:** filter the confirmed `ACTIVE` rows into `verified.xlsx`. That file is the input
contract for phase 2 — nothing reaches enrichment without either passing the exact-name check or
being explicitly confirmed by a person.

## The cache

Every successful lookup is cached in `data/cache/cache.store` (keyed by name + company). This is
what makes re-runs cheap: if a run dies at row 2,700, fixing the problem and re-running costs zero
API calls for the rows already done.

**Delete the cache file** before re-running if:

- you changed any matching logic (normalization, fallback, name rules) — stale verdicts are
  otherwise served verbatim, or
- enough time has passed that you want fresh answers from ZoomInfo.

## Phase 2: enrich (not built yet)

```
npm run dev -- enrich <file>     # currently throws, on purpose
```

The planned second phase reads `verified.xlsx` and pulls each contact's current **phone, email,
and job title** by ZoomInfo person ID — an exact lookup, no re-matching. It's a separate explicit
subcommand so it can never fire by accident: Contact Enrich is ZoomInfo's billable tier, and an
accidental run burns credits. Until it's built, the `enrich` command throws.

## Troubleshooting

| Symptom | Cause & fix |
| --- | --- |
| `Missing expected column "..."` | The most likely break with a future export: the header row must contain **First Name**, **Last Name**, **Account Name**, and **Email** (any casing, any position). Rename the headers in the sheet to match |
| `Worksheet "X" not found ... Available worksheets: ...` | Typo in `--worksheet` — the error lists the workbook's actual tab names; pass one of those |
| Write fails at the end of a run | The output file is probably open in Excel. Close it and re-run — the cache makes the re-run free |
| `401` errors | Bad or expired credentials in `.env` |
| `429` errors | Rate limit. The built-in throttle normally prevents this — if it appears, something else is sharing the ZoomInfo account's quota. Wait and re-run |
| Person IDs display as `1.40628E+10` | Column W was reformatted as a number. The tool writes IDs as text; undo the formatting or re-run |
| Results look wrong after a code change | Stale cache — delete `data/cache/cache.store` and re-run |

## Project layout

```
src/
├── cli.ts        # entry point: arg parsing, subcommand routing, top-level error handling
├── search.ts     # phase 1 workflow: per-contact search, status derivation
├── auth.ts       # ZoomInfo token exchange + in-memory token cache
├── zoominfo.ts   # Contact Search API client + request-level rate throttle
├── excel.ts      # sheet reading (header-keyed) and annotated-output writing
└── cache.ts      # JSON result cache keyed by name+company
names.csv         # nickname → formal-name lookup, for a future nickname-matching rule (unused today)
```

`docs/architecture.md` records the full design, its rationale, and every decision that got
reversed along the way — read it before changing matching logic.
