import { getBearerToken } from './auth';

const SEARCH_URL = `https://api.zoominfo.com/gtm/data/v1/contacts/search`

export interface ContactSearchCriteria {
    firstName?: string;
    lastName?: string;
    companyName?: string;
    email?: string;
}

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
    const response = await fetch(SEARCH_URL, options);
    if (!response.ok) {
        throw new Error(`ZoomInfo contact search request failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return data;
}

export { contactSearch };
