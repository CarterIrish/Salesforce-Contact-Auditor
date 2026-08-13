import type { SearchResult } from './search';
import type { EnrichResult } from './excel';

import fs from 'fs';
import path from 'path';

let cache: Record<string, SearchResult | EnrichResult> = {};

/**
 * Loads the on-disk cache into memory. A missing file starts an empty cache (warns); a read/parse
 * failure logs and also starts empty. Call once at the start of a run.
 * @param filePath Path to the JSON cache store (e.g. data/cache/search_cache.store).
 */
const loadCache = (filePath: string): void => {
    // Check if the cache file exists before attempting to read it
    if(!fs.existsSync(filePath)) {
        // No cache file found, start with an empty cache
        console.warn(`Cache file "${filePath}" does not exist. Starting with an empty cache.`);
        cache = {};
        return;
    }
    // Cache exists, attempt to read and parse it
    try {
        // Read the cache file synchronously
        const data = fs.readFileSync(filePath, 'utf-8');
        const parsedCache: Record<string, SearchResult | EnrichResult> = JSON.parse(data);
        // validate the parsed cache
        if(typeof parsedCache === 'object' && parsedCache !== null) {
            cache = parsedCache;
            console.log(`Loaded cache from "${filePath}" with ${Object.keys(cache).length} entries.`);
        } else {
            throw new Error('Parsed cache is not an object');
        }
    }
    catch (err) {
        // Error reading the cache file, log error & start fresh. 
        console.error(`Failed to load cache from "${filePath}": ${err}`);
        cache = {};
    }
};

/**
 * Looks up a previously stored result by cache key. Callers must re-stamp `rowNumber` from the
 * current contact.
 * @param key Cache key from buildSearchCacheKey() or buildEnrichCacheKey().
 * @returns The cached SearchResult or EnrichResult, or undefined on a miss.
 */
const getCached = <T extends SearchResult | EnrichResult>(key: string): T | undefined => {
    return cache[key] as T | undefined;
};

/**
 * Stores a result under its cache key. Persisted only when saveCache() runs.
 * @param key Cache key from buildSearchCacheKey() or buildEnrichCacheKey().
 * @param value The SearchResult or EnrichResult to cache.
 */
const setCached = <T extends SearchResult | EnrichResult>(key: string, value: T): void => {
    cache[key] = value;
};

/**
 * Writes the in-memory cache to disk as pretty-printed JSON, creating the cache directory if it is
 * missing. Call once after processing.
 * @param filePath Path to the JSON cache store.
 * @throws Error if the cache cannot be written. Deliberately not swallowed: a silent no-op here
 * leaves every result of the run in memory only, so a later output-write failure discards the whole
 * run — on the enrich path, credits included.
 */
const saveCache = (filePath: string): void => {
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), 'utf-8');
        console.log(`Cache saved to "${filePath}" with ${Object.keys(cache).length} entries.`);
    } catch (err) {
        console.error(`Failed to save cache to "${filePath}": ${err}`);
        throw err;
    }
};

/**
 * Builds the cache key. Keyed by name + company only. Case-sensitive.
 * @param firstName Contact first name.
 * @param lastName Contact last name.
 * @param company Contact company (Account Name).
 * @returns Key of the form "First Last|Company".
 */
const buildSearchCacheKey = (firstName: string, lastName: string, company: string): string => {
    return `${firstName} ${lastName}|${company}`;
}

/**
 * Builds the cache key for enrichment results. Keyed by personId only.
 * @param personId The ZoomInfo person ID.
 * @returns Key of the form "personId:<id>".
 */
const buildEnrichCacheKey = (personId: string): string => {
    return `personId:${personId}`;
}

export { loadCache, getCached, setCached, saveCache, buildSearchCacheKey, buildEnrichCacheKey };

