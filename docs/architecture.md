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
│   ├── search.ts      # Phase 1 entry.  node src/search.js data/input/contacts.xlsx
│   ├── enrich.ts      # Phase 2 entry.  node src/enrich.js data/output/verified.xlsx
│   ├── zoominfo.ts    # getToken(), contactSearch(), contactEnrich()
│   ├── excel.ts       # readRows(), writeResults()
│   └── cache.ts       # ~10 lines. Keyed JSON file. See §5.
├── data/              # GITIGNORED — real people's PII. Add to .gitignore in the first commit.
│   ├── input/
│   ├── output/
│   └── cache/
├── .env               # ZOOMINFO_USERNAME, ZOOMINFO_PASSWORD
├── .env.example       # Committed. No real values.
└── README.md          # The handoff artifact — see §7.
```

**Dependencies:** `exceljs`, `dotenv`. Native `fetch`. That's it.

No test framework, no CLI framework, no validation library, no rate-limit library. Rate limiting is
four lines: send 25, wait a second, repeat. At 2,880 rows the run takes ~2 minutes.

---

## 3. Phase 1: the status check

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
| `totalResults > 1`             | Take the highest `contactAccuracyScore`; flag in `notes` for human review |

### Output columns

Original sheet columns, plus:

| Column          | Source                 | Notes                                                                                        |
| --------------- | ---------------------- | -------------------------------------------------------------------------------------------- |
| `status`        | derived                | `ACTIVE` / `INACTIVE` / `NOT_FOUND` / `ERROR`                                                |
| `personId`      | `data[0].id`           | **Phase 2's key.** Write as **text** — `"14062844524"` as a number renders as `1.40628E+10`. |
| `zi_company`    | `company.name`         | Lets a human sanity-check every `INACTIVE`                                                   |
| `zi_company_id` | `company.id`           | Powers the exact company compare — see §4                                                    |
| `zi_title`      | `jobTitle`             | Free in search. Part of phase 2, already paid for.                                           |
| `accuracy`      | `contactAccuracyScore` | Confidence signal                                                                            |
| `notes`         | derived                | Multiple matches, low accuracy, etc.                                                         |

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

> **Resolved by the live response:** search accepts `fullName`, so there is no first/last name
> splitting to get wrong. And the present-company assumption (previously the biggest risk) is
> confirmed.

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

0. ~~Verify the search response returns the _present_ company.~~ **Done** — see §3.
1. `.gitignore` `data/` and `.env` — **first commit, before any real sheet lands in the repo.**
2. `excel.ts` — read the real sheet, print the rows. Confirm every row has a usable company value.
   _(A wall of rows with no company means `NOT_FOUND` will be meaningless — find that out now, not
   at row 400.)_
3. `zoominfo.ts` — programmatic auth (replacing the manual bearer token), then `contactSearch()`.
4. Status logic + `cache.ts`. Run on **10 rows**. Check every result by hand.
5. Then 100 rows — this is where you eyeball for false `INACTIVE`s and decide whether §4's pass-2
   company-ID compare is needed. Then all 2,880.
6. Write the output sheet + summary line (`X active, Y inactive, Z not found`).
7. Trim to `ACTIVE`, and stop. Phase 1 is done.

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
