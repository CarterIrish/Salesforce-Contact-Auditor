import { EnrichResult, EnrichRow, readEnrichRows, writeEnrichResults } from './excel';
import { contactEnrich } from './zoominfo';
import * as cache from './cache';


const ENRICH_CACHE_FILE_PATH = 'data/cache/enrich_cache.store';



export const runEnrich = async (inputFile: string, worksheetName: string): Promise<void> => {

    cache.loadCache(ENRICH_CACHE_FILE_PATH);

    // Read the contacts from input file
    const excelContacts = await readEnrichRows(inputFile, worksheetName);
    console.log(`Read ${excelContacts.length} contacts from ${inputFile}`);

    // Process each contact and collect results
    const allResults: EnrichResult[] = await Promise.all(excelContacts.map(contact => processEnrichContact(contact)));
    // Save the cache after processing all contacts
    cache.saveCache(ENRICH_CACHE_FILE_PATH);

    // Build the summary of results
    let errorCount = 0;
    let enrichedCount = 0;
    let noDataCount = 0;
    for (const result of allResults) {
        if (result.notes && result.notes.startsWith('Error')) errorCount++;
        else if (result.email || result.jobTitle || result.phone || result.mobilePhone) enrichedCount++;
        else noDataCount++;
    }
    console.log(`Summary: ${enrichedCount} enriched, ${noDataCount} no data, ${errorCount} errors`);
    await writeEnrichResults(inputFile, `data/output/enriched_${worksheetName}.xlsx`, allResults, worksheetName);
}

const processEnrichContact = async (contact: EnrichRow): Promise<EnrichResult> => {
    try {
        // Build the cache key & check if contact already cached
        let cacheKey = cache.buildEnrichCacheKey(contact.personId);
        let cachedContact = cache.getCached<EnrichResult>(cacheKey);
        if (cachedContact) {
            return { ...cachedContact, rowNumber: contact.rowNumber };
        }
        // No cached result, call ZoomInfo Enrich endpoint
        const result = await contactEnrich({ personId: contact.personId });
        if (result.data.length === 0) {
            const enrichResult: EnrichResult = {
                rowNumber: contact.rowNumber,
                notes: 'No enrichment data found'
            };
            // Cache the API result
            cache.setCached(cacheKey, enrichResult);
            return enrichResult;
        }
        // A contact was found and enriched, cache and return the result
        const enrichData = result.data[0].attributes;
        const enrichResult: EnrichResult = {
            rowNumber: contact.rowNumber,
            email: enrichData.email,
            jobTitle: enrichData.jobTitle,
            phone: enrichData.phone,
            mobilePhone: enrichData.mobilePhone,
            notes: result.data[0].meta.matchStatus === 'FULL_MATCH' ? undefined : result.data[0].meta.matchStatus
        };
        if (result.data[0].meta.matchStatus !== 'LIMIT_EXCEEDED') {
            cache.setCached(cacheKey, enrichResult);
        }
        return enrichResult;
    } catch (error) {
        // An error occurred during enrichment, log it and return an error result with notes
        console.error(`Error processing contact: ${error}`);
        return {
            rowNumber: contact.rowNumber,
            notes: `Error during enrichment: ${error instanceof Error ? error.message : String(error)}`
        }
    }

}