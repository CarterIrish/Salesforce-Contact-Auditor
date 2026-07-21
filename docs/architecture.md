# Salesforce Contact Auditor — Architecture

**Scale:** Single-operator CLI script. ~2,880 contacts. Two phases, run as two separate commands.

---

## 1. What it does

Takes a spreadsheet of Salesforce contacts (name + company), checks each one against ZoomInfo,
and flags them `ACTIVE`, `INACTIVE`, or `NOT_FOUND`. The point is to remove the human from the
task — no manual ZoomInfo searching.

**Phase 1 — Search** _(build this)_
Contact Search, one call per row. Determines status. Writes an annotated sheet + prints a summary.

**Phase 2 — Enrich** _(later, separate command)_
Contact Enrich, run against a _trimmed_ sheet containing only contacts phase 1 confirmed exist.
Pulls current title / email / phone. Kept as a separate entry point so it cannot fire by accident
and burn credits.

Out of scope: web UI, Salesforce write-back, job queue, database. None of them earn their keep here.

---

## 2. Structure

```
salesforce-contact-auditor/
├── src/
│   ├── cli.ts         # The only entry point.  npm run dev -- search data/input/contacts.xlsx
│   ├── search.ts      # Phase 1 workflow — runSearch(inputFile), dispatched by cli.ts
│   ├── enrich.ts      # Phase 2 workflow — later. Until built, the subcommand throws.
│   ├── auth.ts        # getToken() — the token seam. See §6 step 3.
│   ├── zoominfo.ts    # contactSearch(), contactEnrich()
│   ├── excel.ts       # readRows(), writeResults()
│   └── cache.ts       # ~10 lines. Keyed JSON file. See §5.
├── dist/              # tsc output, gitignored. npm start runs dist/cli.js.
├── data/              # GITIGNORED — real people's PII. Verified: test.xlsx is ignored.
│   ├── input/
│   ├── output/
│   └── cache/
├── .env               # CLIENT_ID / CLIENT_SECRET — Client Credentials Flow, exchanged for a
│                      # short-lived bearer token by auth.ts and cached in memory until near expiry
├── .env.example       # Committed. No real values.
└── README.md          # The handoff artifact — see §7.
```

**Runtime dependencies:** `exceljs`, `dotenv`, `chalk`. Native `fetch`.
**Toolchain:** TypeScript strict; `tsx` runs the dev loop (`npm run dev -- <command> <file>`), `tsc`
builds to `dist/` (`npm start`). CommonJS package (ESM `import` syntax, compiled to `require`) with
`nodenext` module resolution — required because chalk 5 is ESM-only and Node ≥ 22 can `require()` it
natively; `node16` resolution rejects that.

No test framework, no CLI framework (arg parsing is `parseArgs` from `node:util`), no validation
library, no rate-limit library. Rate limiting is four lines: send 25, wait a second, repeat. At
2,880 rows the run takes ~2 minutes.

**One entry point, not two.** An earlier revision of this doc specced separate entry files per phase
so enrich could never fire by accident. The design moved to a single `cli.ts` routing `search` /
`enrich` subcommands — the guard survives because `enrich` is an explicit command that throws until
phase 2 is deliberately built. cli.ts validates user input at the boundary (file must exist, command
must be known) and owns the single top-level `.catch` that prints errors and sets the exit code;
workflow modules trust their inputs and communicate failure by throwing.

---

## 3. Phase 1: the status check

### Input schema (confirmed against the real export)

The real export (`data/input/ContactExport.xlsx`) is a multi-tab workbook, not a single sheet:
per-person contact tabs (`Carter`, `Zoe`, `Kylie`), plus `Account List` and `Summary` (unused).
`readExcelSheet()` currently hardcodes the `'Carter'` tab for development; expand to the others
later (CLI positional arg, or just hardcode per run — not yet decided).

Column layout on a contact tab, confirmed live (`B`, `E`, `K` are hidden in Excel — invisible when
reading the header row by eye, but present and readable via ExcelJS same as any other column):

| Col | Header                  | Col | Header                           | Col | Header             |
| --- | ----------------------- | --- | -------------------------------- | --- | ------------------ |
| A   | Account Last Update     | H   | Account ID                       | O   | Phone              |
| B   | Contact ID _(hidden)_   | I   | Account Name                     | P   | Mobile             |
| C   | First Name              | J   | Account Owner                    | Q   | Email              |
| D   | Last Name               | K   | Account: Created Date _(hidden)_ | R   | Last Modified By   |
| E   | Contact Name _(hidden)_ | L   | Contact Status                   | S   | Last Modified Date |
| F   | Created Date            | M   | Title                            | T   | Email Opt Out      |
| G   | Created By              | N   | Department                       | U   | NOTES              |

`V` through `AC` are confirmed empty — that's where this tool writes. **Existing columns (A–U) are
never modified**, including `L` (`Contact Status`) — that's a CRM-managed field, not this tool's to
overwrite. See Output columns below.

**Endpoint:** `POST https://api.zoominfo.com/gtm/data/v1/contacts/search` (JSON:API —
`content-type: application/vnd.api+json`). One contact per request; **no batching**. 2,880 rows =
2,880 requests ≈ 2 minutes at 25/sec.

```jsonc
{
  "data": {
    "type": "ContactSearch",
    "attributes": {
      "fullName": "Paul Adams",
      "companyName": "CrunchTime! Information Systems Inc",
      "companyPastOrPresent": "pastAndPresent", // ← the whole design rests on this
    },
  },
}
```

`pastAndPresent` widens _what the search matches on_ (present **or** past employment) while the
response still reports _where the person is now_. That collapses all three statuses into one call.

**Verified against the live API.** Searching a contact who has left `CrunchTime!` returns:

```jsonc
{
  "data": [
    {
      "id": "14062844524", // ← personId. Phase 2's key.
      "attributes": {
        "company": { "id": 557414001, "name": "Blue Mountain" }, // ← PRESENT company, not the matched one
        "jobTitle": "Chief Information Security Officer", // ← free. Capture it.
        "contactAccuracyScore": 98,
        "hasEmail": true,
        "hasMobilePhone": true, // ← booleans, not values. Enrich is the billable tier.
        "lastUpdatedDate": "2026-06-18T20:59:00Z",
        "validDate": "2026-07-08T20:38:00Z",
      },
    },
  ],
  "meta": { "totalResults": 1 },
}
```

The response reports the **present** employer, not the company that caused the match. This was the
one assumption that could have silently invalidated the design. It holds.

### Deriving status

| Condition                      | Status                                                                    |
| ------------------------------ | ------------------------------------------------------------------------- |
| `meta.totalResults == 0`       | `NOT_FOUND` — no record of this person at this company, ever              |
| `company` **==** input company | `ACTIVE`                                                                  |
| `company` **!=** input company | `INACTIVE` — matched on past employment; they've moved on                 |
| `totalResults > 1`             | Take `data[0]` (default sort, `-relevance`); flag in `notes` for human review |

> **Not sorting by `contactAccuracyScore`** (decided 2026-07-21): the score measures ZoomInfo's
> confidence in a single profile's own data quality (employment + email currency), not whether that
> profile is the person actually being searched for — it can't tell two different same-named people
> at the same company apart any better than relevance can. Relying on the API's default `-relevance`
> sort and flagging every multi-match row in `notes` is honest about the ambiguity rather than
> pretending accuracy resolves it.

### Search field fallback (found live, 2026-07-20)

A single `firstName` + `lastName` + `companyName` search misses real contacts, because Salesforce
and ZoomInfo each carry an independent, sometimes-stale record of the same person — no one field is
reliably correct across every contact:

- One contact returned no hit on name alone, name + company, name + phone, or name + email — but hit
  immediately on email alone or phone alone. Cause: the Salesforce `First Name` is a nickname
  ("Cc"); ZoomInfo's record uses a different (likely formal) first name, so every name-based
  combination failed.
- A second contact hit cleanly on name + company but returned nothing once `email` was added to the
  same request. Cause: likely a stale Salesforce email — exactly the population this tool cares about
  most (people who've moved on).

Together these rule out "throw more fields into one request." ZoomInfo's search behaves like an
**AND** across whatever fields are provided, not an OR — combining fields narrows the match rather
than broadening it, so one wrong/stale field bundled in with correct ones can sink an otherwise-good
match.

**Design: sequential fallback, not a combined request.** Try `firstName` + `lastName` +
`companyName` first (cheapest, correct for the common case). If `totalResults === 0`, retry with
`email` alone. Only mark `NOT_FOUND` once every fallback with data available has come back empty.
`contactSearch()` needs to accept partial criteria (not a fixed argument list) so `search.ts` can
call it multiple times with different subsets — each attempt is its own request, not a combined one.
Phone is a candidate third fallback (it hit for the nickname case above); hold off building it until
email-only has been tried against the real run and judged insufficient.

### Output columns

Existing columns (A–U) untouched, per the input schema note above. New columns append starting at `V`:

| Column          | Col | Source                 | Notes                                                                                        |
| --------------- | --- | ---------------------- | -------------------------------------------------------------------------------------------- |
| `status`        | V   | derived                | `ACTIVE` / `INACTIVE` / `NOT_FOUND` / `ERROR`                                                |
| `personId`      | W   | `data[0].id`           | **Phase 2's key.** Write as **text** — `"14062844524"` as a number renders as `1.40628E+10`. |
| `zi_company`    | X   | `company.name`         | Lets a human sanity-check every `INACTIVE`                                                   |
| `zi_company_id` | Y   | `company.id`           | Powers the exact company compare — see §4                                                    |
| `zi_title`      | Z   | `jobTitle`             | Free in search. Part of phase 2, already paid for.                                           |
| `notes`         | AA  | derived                | Multiple matches, or the error message when `status` is `ERROR`.                             |

Then: filter to `status = ACTIVE`, save as `verified.xlsx` — that's phase 2's input.

**Why `personId` matters:** Enrich accepts it as a match input, so phase 2 becomes an exact lookup.
Without it, phase 2 redoes phase 1's name+company matching from scratch — and can arrive at a
_different_ answer than phase 1 did.

---

## 4. The one design risk left: company names don't match across systems

`Acme Corp` · `Acme Corporation` · `Acme Corp.` · `ACME`

Salesforce and ZoomInfo do not agree on company names. A naive `===` marks an active contact as
`INACTIVE`. This is now the **only** remaining soft spot in the design — and the API response hands
over the fix: **`company.id`**. Compare IDs, not strings.

Build the ID map for free, in two passes, with zero extra API calls:

1. **Pass 1** — normalized string compare (lowercase, strip punctuation and `Inc / Corp / LLC / Ltd
/ Co`). Every clean match teaches you `"CrunchTime! Information Systems Inc" → 557414001`. The
   2,880 contacts map to only a few hundred unique accounts, so most accounts will have at least one
   clean hit that reveals their `companyId`.
2. **Pass 2** — re-check _only_ the rows that came out `INACTIVE`, comparing `company.id` against the
   learned map. Any that flip to `ACTIVE` were never gone — just spelled differently.

For accounts that never get a clean hit, fall back to a company-search lookup for those few.

> **Present-company assumption confirmed** against the live response. (Superseded: this used to also
> claim `fullName` search avoided first/last name issues — the design switched to separate
> `firstName`/`lastName` fields since ZoomInfo's API accepts them individually, and live testing then
> surfaced a real first-name failure mode. See §3's Search field fallback note.)

---

## 5. Two small things worth building anyway

**The cache (~10 lines).** A JSON file keyed by `name|company`, checked before each call. It exists
for one scenario: you run all 2,880 rows and the Excel writer throws on row 2,700. Without a cache,
fixing that bug and re-running costs another 2,880 lookups. With one, it costs zero. It's what lets
you iterate on the output format freely.

**Keeping `NOT_FOUND` genuinely distinct from `INACTIVE`.** A missing or misspelled company in the
input produces an empty response — identical to "this person left." Same result, opposite meaning.
Keeping them separate is what stops the tool from confidently reporting good contacts as dead.

---

## 6. Build order

> **Status (end of day, 2026-07-20):** steps 0–4 done. `cli.ts`, `auth.ts` unchanged from prior
> status — both verified working. **Step 4 (`excel.ts`) is done:** `readContacts(filePath)` is now
> the only exported entry point — it opens the workbook, grabs the `Carter` tab, builds the header →
> column map, and returns `ContactRow[]` (`rowNumber`, `firstName`, `lastname`, `company`, `email`),
> keyed off header text rather than hardcoded columns. `readExcelSheet`/`getHeaders`/`readRows` are
> now private helpers, not exported. Dev cap is currently 200 rows (`getRows(2, 200)`) — raise this
> when doing a full run. Multi-tab expansion (`Zoe`/`Kylie`) is still an open, undecided question.
> **Step 5 (`zoominfo.ts`) is partly done:** `contactSearch()` sends a live, working request (fixed a
> `400` caused by sending `"type": "contactSearch"` instead of the required `"ContactSearch"` casing)
> and is verified against real data. **Live testing today surfaced a real gap** — see §3's new
> "Search field fallback" note — so `contactSearch()`'s fixed 4-argument shape needs to change to
> accept partial criteria before it's usable in the real per-contact loop. `search.ts` is currently
> just ad-hoc single-contact test wiring, not the real workflow.
>
> **Pick up here tomorrow, in order:**
> 1. Change `contactSearch()` to take partial criteria (e.g. `{ firstName?, lastName?, companyName?,
>    email? }`), building the request `attributes` from whatever's provided instead of always four
>    fixed fields.
> 2. In `search.ts`, build the real per-contact loop over all loaded contacts: try name+company,
>    fall back to email-alone if `totalResults === 0`, rate-limit per §2 (25, wait a second, repeat).
>    Add phone as a third fallback only if email-only proves insufficient once judged against a real
>    run — not before.
> 3. Derive `ACTIVE`/`INACTIVE`/`NOT_FOUND` per §3's table — not built yet at all.
> 4. Build `writeResults()` in `excel.ts` (doesn't exist yet) — this is the piece needed to actually
>    produce an output workbook, which is tomorrow's goal.
> `cache.ts` (§5) is still unstarted — worth doing before a full 2,880-row run, not required to hit
> tomorrow's goal of one full pass with output.

0. ~~Verify the search response returns the _present_ company.~~ **Done** — see §3.
1. ~~`.gitignore` `data/` and `.env` — first commit, before any real sheet lands in the repo.~~
   **Done.** `data/input/test.xlsx` confirmed ignored.
2. ~~`cli.ts` — subcommand router, error net, toolchain (tsx dev loop / tsc build).~~ **Done.**
3. ~~`auth.ts` — `getBearerToken()`, the token seam.~~ **Done.** Implements ZoomInfo's Client
   Credentials Flow: `CLIENT_ID` / `CLIENT_SECRET` from `.env`, exchanged via HTTP Basic auth for a
   bearer token (`POST /gtm/oauth/v1/token`, `grant_type=client_credentials`). The token is cached
   in memory and re-minted automatically once it's within 60s of `expires_in` — `zoominfo.ts` just
   calls `getBearerToken()` and never learns where tokens come from. `.env.example` committed with
   placeholder keys; live smoke test against the token endpoint passed.
4. ~~`excel.ts` — reads the real sheet into `ContactRow[]`, keyed off the header row.~~ **Done.**
   `readContacts(filePath)` is the sole export; `readExcelSheet`/`getHeaders`/`readRows` are private
   helpers underneath it. No pre-flight existence check — cli.ts already gated the path; `excel.ts`'s
   job is making the _open_ failure readable (locked-by-Excel, vanished file, missing column) by
   rethrowing with the path and a hint. Still open: multi-tab expansion, and `writeResults()` (step 8)
   doesn't exist yet.
5. `zoominfo.ts` — **partly done.** `contactSearch()` sends a live, working request and is verified
   against real data. **Still needed:** change its signature to accept partial criteria so it can be
   called with just name+company, or just email, per §3's fallback design — see the build-order
   status note above for tomorrow's exact order of operations.
6. Status logic + fallback loop + `cache.ts`. Run on the current 200-row dev cap first. Check results
   by hand, paying particular attention to `NOT_FOUND`s — confirm the fallback is actually catching
   the nickname/stale-email cases from §3, not just the name+company common case.
7. Then raise the cap toward all 2,880 — this is where you eyeball for false `INACTIVE`s and decide
   whether §4's pass-2 company-ID compare is needed.
8. Write the output sheet + summary line (`X active, Y inactive, Z not found`). Not built yet —
   needed to hit the "run the sheet through the tool and get an output" goal.
9. Trim to `ACTIVE`, and stop. Phase 1 is done.

**Phase 2, later:** `enrich.ts` reads `verified.xlsx`, enriches by `personId`, writes title / email /
phone.

---

## 7. Handoff

The tool outlives the internship, so `README.md` is a real deliverable, not an afterthought:

- What it does and what the three statuses mean
- How to get ZoomInfo credentials and what goes in `.env`
- How to run each phase
- **What to do when the column names in a future spreadsheet don't match** — the most likely reason
  it breaks for the next person
