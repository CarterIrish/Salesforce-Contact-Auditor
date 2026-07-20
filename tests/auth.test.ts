import 'dotenv/config';
import assert from 'node:assert/strict';
import { getBearerToken } from '../src/auth';

const testGetBearerToken = async () => {
    const token = await getBearerToken();
    assert.ok(typeof token === 'string' && token.length > 0, 'expected a non-empty token string');

    const cached = await getBearerToken();
    assert.equal(cached, token, 'expected the second call to return the cached token');

    console.log('PASS: getBearerToken() returns and caches a token');
};

testGetBearerToken().catch((err) => {
    console.error('FAIL:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
});
