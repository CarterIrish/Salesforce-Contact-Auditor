// Phase 1: read the contact sheet, check each row against ZoomInfo Contact Search,
// derive ACTIVE / INACTIVE / NOT_FOUND, write the annotated sheet.
import { SearchRow, readSearchRows, writeSearchResults } from './excel';
import { contactSearch, ContactSearchResponse, ContactSearchCandidate} from './zoominfo';
import * as cache from './cache';

const SEARCH_CACHE_FILE_PATH = 'data/cache/search_cache.store';

/**
 * Runs the phase 1 audit end to end: loads the cache, reads the contact sheet, searches every
 * contact against ZoomInfo, prints a status summary, and writes the annotated output sheet.
 * @param inputFile Path to the input contacts workbook.
 * @param worksheetName Name of the worksheet tab to audit; also names the output file.
 * @param fresh When true, ignores cached results and re-fetches every contact from ZoomInfo,
 * overwriting the cache with the fresh answers.
 */
export const runSearch = async (inputFile: string, worksheetName: string, fresh?: boolean): Promise<void> => {
  cache.loadCache(SEARCH_CACHE_FILE_PATH);

  const contacts = await readSearchRows(inputFile, worksheetName);
  console.log(`Read ${contacts.length} contacts from ${inputFile}`);

  // Process each contact and collect results
  const allResults: SearchResult[] = await Promise.all(contacts.map(contact => processContact(contact, fresh)));

  cache.saveCache(SEARCH_CACHE_FILE_PATH);

  // Build the summary of results
  let errorCount = 0;
  let activeCount = 0;
  let inactiveCount = 0;
  let nameMismatchCount = 0;
  let notFoundCount = 0;
  for (const result of allResults) {
    if (result.status === 'ERROR') errorCount++;
    else if (result.status === 'ACTIVE') activeCount++;
    else if (result.status === 'INACTIVE') inactiveCount++;
    else if (result.status === 'NAME_MISMATCH') nameMismatchCount++;
    else if (result.status === 'NOT_FOUND') notFoundCount++;
  }

  console.log(`Summary: ${activeCount} active, ${inactiveCount} inactive, ${nameMismatchCount} name mismatch, ${notFoundCount} not found, ${errorCount} errors`);

  // Per-tab output filename so runs against different tabs don't overwrite each other.
  await writeSearchResults(inputFile, `data/output/annotated_${worksheetName}.xlsx`, allResults, worksheetName);
};

export interface SearchResult {
  rowNumber: number;
  status: 'ACTIVE' | 'INACTIVE' | 'NAME_MISMATCH' | 'NOT_FOUND' | 'ERROR';
  personId?: string;
  zi_company?: string;
  zi_company_id?: number;
  zi_title?: string;
  notes?: string;
  rejectedCandidates?: string;
}

/**
 * Normalizes a company name for cross-system comparison: lowercases, strips periods and commas and
 * common suffixes (Inc / Corp / LLC / Ltd / Co / Company), and collapses whitespace.
 * @param name Raw company name.
 * @returns The normalized name, suitable for an equality compare.
 */
const normalizeCompanyName = (name: string) =>
  name.toLocaleLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(inc|incorporated|corp|corporation|llc|ltd|co|company)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Case-insensitive, whitespace-trimmed name equality used for match verification.
 */
const namesEqual = (a: string | undefined, b: string | undefined): boolean =>
  (a ?? '').toLocaleLowerCase().trim() === (b ?? '').toLocaleLowerCase().trim();

/**
 * Returns the first ZoomInfo candidate whose first AND last name equal the sheet row's, or
 * undefined when none passes. Identity is verified here because phase 2 enriches by personId -
 * a wrong-person match would overwrite the contact's real info in Salesforce.
 * @param response Raw ZoomInfo contact search response.
 * @param contact The sheet row the candidates must match.
 */
const selectMatch = (response: ContactSearchResponse, contact: SearchRow) =>
  response.data.find((candidate: ContactSearchCandidate) =>
    namesEqual(candidate.attributes.firstName, contact.firstName) &&
    namesEqual(candidate.attributes.lastName, contact.lastName));

/**
 * Formats candidates as "First Last (Company)", capped at 5, so rejected candidates can be
 * eyeballed against the sheet row's own name during NAME_MISMATCH review.
 * @param candidates Raw ZoomInfo candidate objects.
 */
const describeCandidates = (candidates: ContactSearchCandidate[]): string => {
  const names = candidates.slice(0, 5).map((candidate: ContactSearchCandidate) =>
    `${candidate.attributes.firstName ?? ''} ${candidate.attributes.lastName ?? ''} (${candidate.attributes.company.name})`.trim());
  const more = candidates.length > 5 ? `; +${candidates.length - 5} more` : '';
  return names.join('; ') + more;
};

/**
 * Resolves one contact's status against ZoomInfo: returns a cached result if present, otherwise
 * searches by name + company, falls back to an email-only search when no candidate passed the
 * name check, and derives the status. A candidate only counts as a match when its first and last
 * name equal the sheet row's (selectMatch): an accepted match is ACTIVE / INACTIVE by company
 * compare, rejected-only candidates are NAME_MISMATCH (best candidate's details kept for review),
 * and zero candidates is NOT_FOUND. Never throws - failures are returned as an ERROR result.
 * @param contact The contact row to resolve.
 * @param fresh When true, skips the cache read (a fresh result is still cached, overwriting any
 * existing entry).
 * @returns The SearchResult for this contact.
 */
const processContact = async (contact: SearchRow, fresh?: boolean): Promise<SearchResult> => {
  try {
    // Cache is keyed by name+company only. A hit reuses ZoomInfo's answer but must be re-stamped
    // with THIS contact's rowNumber - the cached rowNumber belongs to whichever row first populated
    // the key, and reusing it would misplace (or blank) duplicate-name rows on write. See §5.
    let cacheKey = cache.buildSearchCacheKey(contact.firstName, contact.lastName, contact.company);
    let cachedContact = cache.getCached<SearchResult>(cacheKey);
    if (!fresh && cachedContact) {
      return { ...cachedContact, rowNumber: contact.rowNumber };
    }
    // First attempt: search by name + company
    let response = await contactSearch({
      firstName: contact.firstName,
      lastName: contact.lastName,
      companyName: contact.company
    });
    let contactMatch = selectMatch(response, contact);
    let rejected: ContactSearchCandidate[] = contactMatch ? [] : response.data;

    // Fall back to email when nothing was accepted - not just when nothing was returned -
    // so a rejected wrong-person hit still gets the email attempt.
    if (!contactMatch && contact.email) {
      response = await contactSearch({ emailAddress: contact.email });
      contactMatch = selectMatch(response, contact);
      if (!contactMatch) {
        // A candidate can come back from both searches - don't list it twice.
        rejected = rejected.concat(response.data.filter((c: ContactSearchCandidate) => !rejected.some(r => r.id === c.id)));
      }
    }

    // Nothing returned at all: truly not found.
    if (!contactMatch && rejected.length === 0) {
      const result: SearchResult = { rowNumber: contact.rowNumber, status: 'NOT_FOUND' };
      cache.setCached(cacheKey, result);
      return result;
    }

    // Candidates returned but none passed the name check: surface the best candidate's details
    // for manual review. The row only reaches stage 2 if a human flips it to ACTIVE.
    if (!contactMatch) {
      const best = rejected[0];
      const result: SearchResult = {
        rowNumber: contact.rowNumber,
        status: 'NAME_MISMATCH',
        personId: best.id,
        zi_company: best.attributes.company.name,
        zi_company_id: best.attributes.company.id,
        zi_title: best.attributes.jobTitle,
        notes: `${rejected.length} candidate(s) rejected: name mismatch.`,
        rejectedCandidates: describeCandidates(rejected)
      };
      cache.setCached(cacheKey, result);
      return result;
    }

    const notes = response.meta.totalResults > 1 ? `${response.meta.totalResults} matches found; used the first name-verified one.` : undefined;
    const isActive = normalizeCompanyName(contactMatch.attributes.company.name) === normalizeCompanyName(contact.company);

    // Build the SearchResult object and cache it
    const result: SearchResult = {
      rowNumber: contact.rowNumber,
      status: isActive ? 'ACTIVE' : 'INACTIVE',
      personId: contactMatch.id,
      zi_company: contactMatch.attributes.company.name,
      zi_company_id: contactMatch.attributes.company.id,
      zi_title: contactMatch.attributes.jobTitle,
      notes
    };
    cache.setCached(cacheKey, result);

    return result; // Return the result for this contact

  } catch (error) {
    return {
      rowNumber: contact.rowNumber,
      status: 'ERROR',
      notes: error instanceof Error ? error.message : String(error)
    };
  }
}

export default runSearch;