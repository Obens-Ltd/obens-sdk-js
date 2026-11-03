const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class ObensApiError extends Error {
  constructor(status, body, method, path) {
    super(`${method} ${path} failed with ${status}${body ? `: ${typeof body === 'string' ? body : JSON.stringify(body)}` : ''}`);
    this.name = 'ObensApiError';
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Small fetch wrapper: api key header, JSON, timeout, and retries with backoff on transient failures. */
export class Http {
  constructor({ baseUrl, apiKey, accountId, timeoutMs = 30000, maxRetries = 3, retryDelayMs = 500, fetchImpl }) {
    if (!baseUrl) throw new Error('baseUrl is required');
    if (!apiKey) throw new Error('apiKey is required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.accountId = accountId;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.retryDelayMs = retryDelayMs;
    this.fetch = fetchImpl ?? globalThis.fetch;
  }

  async request(method, path, body) {
    // a delegated account to act on, instead of the key's own
    if (this.accountId) path += `${path.includes('?') ? '&' : '?'}account-id=${encodeURIComponent(this.accountId)}`;
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await this.fetch(this.baseUrl + path, {
          method,
          headers: {
            'X-API-KEY': this.apiKey,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        // network error or timeout: the request may or may not have arrived, which is safe because every call is an upsert
        if (attempt >= this.maxRetries) throw error;
        await sleep(this.#delay(attempt));
        continue;
      }
      if (response.ok) {
        const text = await response.text();
        return text ? JSON.parse(text) : undefined;
      }
      if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries) {
        await sleep(this.#delay(attempt, response.headers.get('retry-after')));
        continue;
      }
      const text = await response.text();
      let parsed = text;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        /* keep the raw text */
      }
      throw new ObensApiError(response.status, parsed, method, path);
    }
  }

  #delay(attempt, retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    return this.retryDelayMs * 2 ** attempt;
  }
}
