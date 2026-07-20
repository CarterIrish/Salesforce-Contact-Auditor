const TOKEN_URL = 'https://api.zoominfo.com/gtm/oauth/v1/token';
const EXPIRY_SAFETY_MARGIN_MS = 60_000;

let cachedToken: string | undefined;
let cachedTokenExpiresAt = 0;

/**
 *  Fetches a new Bearer Token from ZoomInfo using client credentials.
 *  Caches the token and its expiry time to avoid unnecessary requests.
 *  @throws Error if CLIENT_ID or CLIENT_SECRET are not set, or if the request fails.
 * @returns Bearer Token String
 */
const fetchToken = async (): Promise<{ token: string; expiresInSeconds: number }> => {
    const clientId = process.env.CLIENT_ID;
    const clientSecret = process.env.CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('CLIENT_ID and CLIENT_SECRET must be set in the environment variables.');
    }

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
        },
        body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
        throw new Error(`ZoomInfo token request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
        throw new Error('ZoomInfo token response did not include an access_token.');
    }

    return { token: data.access_token, expiresInSeconds: data.expires_in ?? 3600 };
};

/**
 * Gets a Bearer Token from ZoomInfo, using a cached token if available and valid.
 * @throws Error if fetching a new token fails.
 * @returns Bearer Token String
 */
const getBearerToken = async (): Promise<string> => {
    if (cachedToken && Date.now() < cachedTokenExpiresAt) {
        return cachedToken;
    }

    const { token, expiresInSeconds } = await fetchToken();
    cachedToken = token;
    cachedTokenExpiresAt = Date.now() + expiresInSeconds * 1000 - EXPIRY_SAFETY_MARGIN_MS;
    return cachedToken;
}

export { getBearerToken };
