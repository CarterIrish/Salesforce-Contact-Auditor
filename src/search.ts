// Phase 1: read the contact sheet, check each row against ZoomInfo Contact Search,
// derive ACTIVE / INACTIVE / NOT_FOUND, write the annotated sheet.
import { readContacts } from './excel';
import { contactSearch } from './zoominfo';

export const runSearch = async (inputFile: string): Promise<void> => {
  const contacts = await readContacts(inputFile);
  console.log(`Read ${contacts.length} contacts from ${inputFile}`);

  // TODO: loop over `contacts`, rate-limited per architecture.md §2 (send 25, wait a second, repeat)
  //   TODO: try contactSearch({ firstName, lastName, companyName }) first
  //   TODO: if totalResults === 0, fall back to contactSearch({ email }) — see §3 "Search field
  //         fallback". Only mark NOT_FOUND once every fallback with data available is exhausted.
  //   TODO: derive ACTIVE / INACTIVE / NOT_FOUND from the response per §3's "Deriving status" table
  //   TODO: collect each contact's result (status, personId, zi_company, zi_company_id, zi_title,
  //         accuracy, notes — see §3 "Output columns") for the write step below

  // TODO: excel.writeResults(inputFile, results) — writeResults() doesn't exist yet, see excel.ts
  // TODO: print the summary line (X active, Y inactive, Z not found) per §6 step 8
};

export default runSearch;