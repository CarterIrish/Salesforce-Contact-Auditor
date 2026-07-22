import type { SearchResult } from './search';
import fs from 'fs';

let cache: Record<string, SearchResult> = {};

/**
 * 
 * @param filePath 
 * @returns 
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
 * 
 * @param key 
 * @returns 
 */
const getCached = (key: string): SearchResult | undefined => {
    return cache[key];
};

/**
 * 
 * @param key 
 * @param value 
 */
const setCached = (key: string, value: SearchResult): void => {
    cache[key] = value;
};

/**
 * 
 * @param filePath 
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

export { loadCache, getCached, setCached, saveCache };

