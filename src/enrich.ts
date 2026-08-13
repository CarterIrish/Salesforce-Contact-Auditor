import { EnrichResult, EnrichRow, EnrichStatus, readEnrichRows, writeEnrichResults } from './excel';
import { contactEnrich } from './zoominfo';
import * as cache from './cache';


const ENRICH_CACHE_FILE_PATH = 'data/cache/enrich_cache.store';



export const runEnrich = async (inputFile: string, worksheetName: string, fresh?: boolean): Promise<void> => {

    cache.loadCache(ENRICH_CACHE_FILE_PATH);

    // Read the contacts from input file
    const excelContacts = await readEnrichRows(inputFile, worksheetName);
    console.log(`Read ${excelContacts.length} contacts from ${inputFile}`);

    // Process each contact and collect results
    const allResults: EnrichResult[] = await Promise.all(excelContacts.map(contact => processEnrichContact(contact, fresh)));
    // Save the cache after processing all contacts
    cache.saveCache(ENRICH_CACHE_FILE_PATH);

    const tally: Record<EnrichStatus, number> = { ENRICHED: 0, NO_DATA: 0, LIMIT_EXCEEDED: 0, ERROR: 0 };
    for (const result of allResults) {
        tally[result.status]++;
    }
    console.log(`Summary: ${tally.ENRICHED} enriched, ${tally.NO_DATA} no data, ${tally.ERROR} errors`);
    if (tally.LIMIT_EXCEEDED > 0) {
        console.error(`RUN TRUNCATED BY CREDIT LIMIT: ${tally.LIMIT_EXCEEDED} of ${allResults.length} rows came back LIMIT_EXCEEDED and are not enriched. Top up ZoomInfo credits and re-run to finish them.`);
    }
    await writeEnrichResults(inputFile, `data/output/enriched_${worksheetName}.xlsx`, allResults, worksheetName);
}

const deriveCachedStatus = (result: EnrichResult): EnrichStatus => {
    if (result.email || result.jobTitle || result.phone || result.mobilePhone) return 'ENRICHED';
    return result.notes === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : 'NO_DATA';
}

const processEnrichContact = async (contact: EnrichRow, fresh?: boolean): Promise<EnrichResult> => {
    try {
        // Build the cache key & check if contact already cached
        let cacheKey = cache.buildEnrichCacheKey(contact.personId);
        let cachedContact = cache.getCached<EnrichResult>(cacheKey);
        if (!fresh && cachedContact) {
            // Entries written before EnrichResult carried `status` have none. Without this the
            // summary tallies them under `undefined` and reports zeros across the board.
            const status = cachedContact.status ?? deriveCachedStatus(cachedContact);
            return { ...cachedContact, rowNumber: contact.rowNumber, status };
        }
        // No cached result, call ZoomInfo Enrich endpoint
        const result = await contactEnrich({ personId: contact.personId });
        if (result.data.length === 0 || !result.data[0].attributes) {
            const matchStatus = result.data[0]?.meta?.matchStatus;
            const enrichResult: EnrichResult = {
                rowNumber: contact.rowNumber,
                status: matchStatus === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : 'NO_DATA',
                notes: matchStatus || 'NO_DATA'
            };
            // Cache the API result
            cache.setCached(cacheKey, enrichResult);
            return enrichResult;
        }
        // A contact was found and enriched, cache and return the result
        const enrichData = result.data[0].attributes;
        const matchStatus = result.data[0].meta.matchStatus;
        const hasFields = Boolean(enrichData.email || enrichData.jobTitle || enrichData.phone || enrichData.mobilePhone);
        const enrichResult: EnrichResult = {
            rowNumber: contact.rowNumber,
            status: matchStatus === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : hasFields ? 'ENRICHED' : 'NO_DATA',
            email: enrichData.email,
            jobTitle: enrichData.jobTitle,
            phone: enrichData.phone,
            mobilePhone: enrichData.mobilePhone,
            notes: matchStatus === 'FULL_MATCH' ? undefined : matchStatus
        };
        if (matchStatus !== 'LIMIT_EXCEEDED') {
            cache.setCached(cacheKey, enrichResult);
        }
        return enrichResult;
    } catch (error) {
        // An error occurred during enrichment, log it and return an error result with notes
        console.error(`Error processing contact: ${error}`);
        return {
            rowNumber: contact.rowNumber,
            status: 'ERROR',
            notes: `Error during enrichment: ${error instanceof Error ? error.message : String(error)}`
        }
    }

}