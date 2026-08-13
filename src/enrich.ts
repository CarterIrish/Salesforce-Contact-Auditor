// Phase 2: read the ACTIVE rows of an annotated sheet, pull current title/email/phone/mobile from
// ZoomInfo Contact Enrich, write the enriched sheet. Enrich is the endpoint that spends credits.
import { EnrichResult, EnrichRow, EnrichStatus, readEnrichRows, writeEnrichResults } from './excel';
import { contactEnrich } from './zoominfo';
import * as cache from './cache';

const ENRICH_CACHE_FILE_PATH = 'data/cache/enrich_cache.store';

/**
 * Runs the phase 2 enrichment end to end: loads the cache, reads the annotated sheet's ACTIVE rows,
 * enriches each against ZoomInfo, prints a summary, and writes the enriched output sheet. Rows are
 * filtered inside readEnrichRows, so anything not marked ACTIVE with a person ID never reaches the
 * API and is not reported here.
 * @param inputFile Path to the annotated workbook phase 1 produced.
 * @param worksheetName Name of the worksheet tab to enrich; also names the output file.
 * @param fresh When true, ignores cached results and re-enriches every row, overwriting the cache
 * with the fresh answers. Every row it re-fetches spends a credit.
 */
export const runEnrich = async (inputFile: string, worksheetName: string, fresh?: boolean): Promise<void> => {

    cache.loadCache(ENRICH_CACHE_FILE_PATH);

    const excelContacts = await readEnrichRows(inputFile, worksheetName);
    console.log(`Read ${excelContacts.length} contacts from ${inputFile}`);

    const allResults: EnrichResult[] = await Promise.all(excelContacts.map(contact => processEnrichContact(contact, fresh)));
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

/**
 * Classifies a cached result written before EnrichResult carried a `status`. The store holds no
 * schema version, so one warm run can mix entries from both shapes.
 * @param result A cached result whose status is missing.
 * @returns The status its populated fields and notes imply.
 */
const deriveCachedStatus = (result: EnrichResult): EnrichStatus => {
    if (result.email || result.jobTitle || result.phone || result.mobilePhone) return 'ENRICHED';
    return result.notes === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : 'NO_DATA';
}

/**
 * Caches a result unless it is a credit-limit failure. LIMIT_EXCEEDED means the account ran out of
 * credits, not that this person has no data, so caching it would pin an empty result to that
 * personId and every later run would serve it instead of retrying, until someone passes --fresh or
 * edits the store by hand. Both response branches route through here so the rule cannot drift.
 * @param key The enrich cache key for this person.
 * @param result The result to store.
 */
const cacheUnlessCreditLimited = (key: string, result: EnrichResult): void => {
    if (result.status !== 'LIMIT_EXCEEDED') {
        cache.setCached(key, result);
    }
}

/**
 * Resolves one contact's current details: returns a cached result if present, otherwise calls
 * ZoomInfo Contact Enrich by person ID. A response can carry a matchStatus with no attributes
 * object at all, so a non-empty response does not imply fields came back. Never throws - failures
 * are returned as an ERROR result, so one bad row cannot reject the whole Promise.all.
 * @param contact The row to enrich, carrying the person ID phase 1 resolved.
 * @param fresh When true, skips the cache read; the fresh result is still cached.
 * @returns The EnrichResult for this contact.
 */
const processEnrichContact = async (contact: EnrichRow, fresh?: boolean): Promise<EnrichResult> => {
    try {
        let cacheKey = cache.buildEnrichCacheKey(contact.personId);
        let cachedContact = cache.getCached<EnrichResult>(cacheKey);
        if (!fresh && cachedContact) {
            // Entries written before EnrichResult carried `status` have none. Without this the
            // summary tallies them under `undefined` and reports zeros across the board.
            const status = cachedContact.status ?? deriveCachedStatus(cachedContact);
            return { ...cachedContact, rowNumber: contact.rowNumber, status };
        }
        const result = await contactEnrich({ personId: contact.personId });
        if (result.data.length === 0 || !result.data[0].attributes) {
            const matchStatus = result.data[0]?.meta?.matchStatus;
            const enrichResult: EnrichResult = {
                rowNumber: contact.rowNumber,
                status: matchStatus === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : 'NO_DATA',
                notes: matchStatus || 'NO_DATA'
            };
            cacheUnlessCreditLimited(cacheKey, enrichResult);
            return enrichResult;
        }
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
        cacheUnlessCreditLimited(cacheKey, enrichResult);
        return enrichResult;
    } catch (error) {
        console.error(`Error processing contact: ${error}`);
        return {
            rowNumber: contact.rowNumber,
            status: 'ERROR',
            notes: `Error during enrichment: ${error instanceof Error ? error.message : String(error)}`
        }
    }

}