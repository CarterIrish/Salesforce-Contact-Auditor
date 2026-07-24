import { getBearerToken } from './auth';

const SEARCH_URL = `https://api.zoominfo.com/gtm/data/v1/contacts/search`

export interface ContactSearchCriteria {
    firstName?: string;
    lastName?: string;
    companyName?: string;
    emailAddress?: string;
}
let nextSlot = 0;
const MAX_REQUESTS_PER_SECOND = 20;
const MIN_INTERVAL_MS = 1000 / MAX_REQUESTS_PER_SECOND;

/**
 * Request-level rate limiter: synchronously reserves the next time slot (spacing requests by
 * MIN_INTERVAL_MS, ≈ 20 req/s) before awaiting it, so concurrent callers are paced instead of
 * firing all at once.
 */
const throttle = async (): Promise<void> => {
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS;
    if (wait > 0) {
        await new Promise(resolve => setTimeout(resolve, wait));
    }
}

/**
 * Runs one ZoomInfo Contact Search. Builds the request attributes from whatever criteria are
 * provided (partial subsets allowed), adding companyPastOrPresent when a companyName is present,
 * and paces the request through the throttle.
 * @param criteria Any subset of firstName / lastName / companyName / emailAddress.
 * @returns The parsed JSON:API response (currently untyped).
 * @throws Error if no criteria are provided, or the request returns a non-OK status.
 */
const contactSearch = async (criteria: ContactSearchCriteria): Promise<any> => {
    const searchAttributes = Object.fromEntries(
        Object.entries(criteria).filter(([key, value]) => value !== undefined)
    )
    if (Object.keys(searchAttributes).length === 0) {
        throw new Error("At least one search criteria must be provided");
    }
    if (searchAttributes.companyName) {
        searchAttributes.companyPastOrPresent = "pastAndPresent";
    }
    const token = await getBearerToken();
    const options = {
        method: 'POST',
        headers: {
            accept: 'application/vnd.api+json',
            'content-type': 'application/vnd.api+json',
            authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
            "data": {
                "type": "ContactSearch",
                "attributes": searchAttributes
            }
        })
    }

    await throttle();
    const response = await fetch(SEARCH_URL, options);
    if (!response.ok) {
        throw new Error(`ZoomInfo contact search request failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return data;
}

export { contactSearch };
