// Phase 1: read the contact sheet, check each row against ZoomInfo Contact Search,
// derive ACTIVE / INACTIVE / NOT_FOUND, write the annotated sheet.
import { ContactRow, readContacts } from './excel';
import { contactSearch } from './zoominfo';
import { getBearerToken } from './auth';

export const runSearch = async (inputFile: string): Promise<void> => {
  const contacts = await readContacts(inputFile);
  console.log(`Read ${contacts.length} contacts from ${inputFile}`);
  console.log(contacts.map(c => `${c.firstName} ${c.lastname} @ ${c.company} <${c.email}>`).join('\n'));

  const chunksize = 25;
  const chunks: ContactRow[][] = [];
  for (let i = 0; i < contacts.length; i += chunksize) {
    chunks.push(contacts.slice(i, i + chunksize));
  }

  const allResults: SearchResult[] = [];
  for (const [index, chunk] of chunks.entries()) {
    console.log(`Processing chunk ${index + 1} of ${chunks.length} (${chunk.length} contacts)`);
    const results = await Promise.all(chunk.map(processContact));
    allResults.push(...results);

    console.log(`Results for chunk ${index + 1}:`);
    console.table(results);
    await new Promise(resolve => setTimeout(resolve, 1000)); // 1s delay between chunks to avoid rate limits
  }

  // TODO: excel.writeResults(inputFile, results) — writeResults() doesn't exist yet, see excel.ts
  // TODO: print the summary line (X active, Y inactive, Z not found) per §6 step 8
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

const processContact = async (contact: ContactRow): Promise<SearchResult> => {
  try {
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
      return { rowNumber: contact.rowNumber, status: 'NOT_FOUND' };
    }

    let normalizeCompanyName = (name: string) => name.toLocaleLowerCase().trim();

    const contactMatch = response.data[0]; 
    const notes = response.meta.totalResults > 1 ? `${response.meta.totalResults} matches found, using the most relevant one.` : undefined;
    const isActive = normalizeCompanyName(contactMatch.attributes.company.name) === normalizeCompanyName(contact.company); 

    return {
      rowNumber: contact.rowNumber,
      status: isActive ? 'ACTIVE' : 'INACTIVE',
      personId: contactMatch.id,
      zi_company: contactMatch.attributes.company.name,
      zi_company_id: contactMatch.attributes.company.id,
      zi_title: contactMatch.attributes.jobTitle,
      notes
    }



  } catch (error) {
    return {
      rowNumber: contact.rowNumber,
      status: 'ERROR',
      notes: error instanceof Error ? error.message : String(error)
    };
  }
}

export default runSearch;