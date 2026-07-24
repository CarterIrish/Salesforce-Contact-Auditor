import type { SearchResult } from './search';
import fs from 'fs';

let cache: Record<string, SearchResult> = {};

/**
 * Loads the on-disk cache into memory. A missing file starts an empty cache (warns); a read/parse
 * failure logs and also starts empty. Call once at the start of a run.
 * @param filePath Path to the JSON cache store (e.g. data/cache/cache.store).
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
        const parsedCache: Record<string, SearchResult> = JSON.parse(data);
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
 * @param key Cache key from buildCacheKey().
 * @returns The cached SearchResult, or undefined on a miss.
 */
const getCached = (key: string): SearchResult | undefined => {
    return cache[key];
};

/**
 * Stores a result under its cache key. Persisted only when saveCache() runs.
 * @param key Cache key from buildCacheKey().
 * @param value The SearchResult to cache.
 */
const setCached = (key: string, value: SearchResult): void => {
    cache[key] = value;
};

/**
 * Writes the in-memory cache to disk as pretty-printed JSON. A write failure logs and is swallowed.
 * A run shouldn't fail just because the cache couldn't be persisted. Call once after processing.
 * @param filePath Path to the JSON cache store.
 */
const saveCache = (filePath: string): void => {
    try {
        // Write the cache to the file
        fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), 'utf-8');
        console.log(`Cache saved to "${filePath}" with ${Object.keys(cache).length} entries.`);
    } catch (err) {
        console.error(`Failed to save cache to "${filePath}": ${err}`);
    }
};

/**
 * Builds the cache key. Keyed by name + company only. Case-sensitive.
 * @param firstName Contact first name.
 * @param lastName Contact last name.
 * @param company Contact company (Account Name).
 * @returns Key of the form "First Last|Company".
 */
const buildCacheKey = (firstName: string, lastName: string, company: string): string => {
    return `${firstName} ${lastName}|${company}`;
}

export { loadCache, getCached, setCached, saveCache, buildCacheKey };

