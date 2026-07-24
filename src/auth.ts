const TOKEN_URL = 'https://api.zoominfo.com/gtm/oauth/v1/token';
const EXPIRY_SAFETY_MARGIN_MS = 60_000;

let cachedToken: string | undefined;
let cachedTokenExpiresAt = 0;
let pendingFetch: Promise<string> | undefined;

/**
 * Fetches a fresh bearer token from ZoomInfo via the Client Credentials flow (CLIENT_ID /
 * CLIENT_SECRET over HTTP Basic auth).
 * @throws Error if CLIENT_ID or CLIENT_SECRET are unset, or the request fails / returns no token.
 * @returns The token and its lifetime in seconds (expires_in, defaulting to 3600).
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
 * Returns a valid ZoomInfo bearer token - the in-memory cached one if still valid, otherwise a
 * freshly fetched one. Concurrent callers share a single in-flight fetch (pendingFetch) so they
 * don't stampede the token endpoint.
 * @throws Error if fetching a new token fails.
 * @returns Bearer token string.
 */
const getBearerToken = async (): Promise<string> => {
    if (cachedToken && Date.now() < cachedTokenExpiresAt) {
        return cachedToken;
    }
    if (pendingFetch) {
        return pendingFetch;
    }
    pendingFetch = fetchToken()
        .then(({ token, expiresInSeconds }) => {
            cachedToken = token;
            cachedTokenExpiresAt = Date.now() + expiresInSeconds * 1000 - EXPIRY_SAFETY_MARGIN_MS;
            return token;
        })
        .finally(() => {
            pendingFetch = undefined;
        });
    return pendingFetch;
};

export { getBearerToken };
