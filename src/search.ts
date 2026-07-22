// Phase 1: read the contact sheet, check each row against ZoomInfo Contact Search,
// derive ACTIVE / INACTIVE / NOT_FOUND, write the annotated sheet.
import { ContactRow, readContacts } from './excel';
import { contactSearch } from './zoominfo';
import * as cache from './cache';

const CACHE_FILE_PATH = 'data/cache/cache.store';

export const runSearch = async (inputFile: string): Promise<void> => {
  cache.loadCache(CACHE_FILE_PATH);

  const contacts = await readContacts(inputFile);
  console.log(`Read ${contacts.length} contacts from ${inputFile}`);

  // Process each contact and collect results
  const allResults: SearchResult[] = await Promise.all(contacts.map(contact => processContact(contact)));

  cache.saveCache(CACHE_FILE_PATH);
  
  // Build the summary of results
  let errorCount = 0;
  let activeCount = 0;
  let inactiveCount = 0;
  let notFoundCount = 0;
  for (const result of allResults) {
    if (result.status === 'ERROR') errorCount++;
    else if (result.status === 'ACTIVE') activeCount++;
    else if (result.status === 'INACTIVE') inactiveCount++;
    else if (result.status === 'NOT_FOUND') notFoundCount++;
  }

  console.log(`Summary: ${activeCount} active, ${inactiveCount} inactive, ${notFoundCount} not found, ${errorCount} errors`);

  // TODO: excel.writeResults(inputFile, results) — writeResults() doesn't exist yet, see excel.ts
};

export interface SearchResult {
  rowNumber: number;
  status: 'ACTIVE' | 'INACTIVE' | 'NOT_FOUND' | 'ERROR';
  personId?: string;
  zi_company?: string;
  zi_company_id?: number;
  zi_title?: string;
  notes?: string;
}

  const normalizeCompanyName = (name: string) => 
    name.toLocaleLowerCase()
      .replace(/[.,]/g,'')
      .replace(/\b(inc|incorporated|corp|corporation|llc|ltd|co|company)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();

const processContact = async (contact: ContactRow): Promise<SearchResult> => {
  try {
    let cacheKey = cache.buildCacheKey(contact.firstName, contact.lastname, contact.company);
    let cachedContact = cache.getCached(cacheKey);
    if (cachedContact) {
      return cachedContact;
    }
    // First attempt: search by name + company
    let response = await contactSearch({
      firstName: contact.firstName,
      lastName: contact.lastname,
      companyName: contact.company
    });

    // If no results, fall back to searching by email
    if (response.meta.totalResults === 0 && contact.email) {
      response = await contactSearch({ emailAddress: contact.email });
    }

    // Derive status from the response
    if (response.meta.totalResults === 0) {
      cache.setCached(cacheKey, { rowNumber: contact.rowNumber, status: 'NOT_FOUND' });
      return { rowNumber: contact.rowNumber, status: 'NOT_FOUND' };
    }

    const contactMatch = response.data[0]; 
    const notes = response.meta.totalResults > 1 ? `${response.meta.totalResults} matches found, using the most relevant one.` : undefined;
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