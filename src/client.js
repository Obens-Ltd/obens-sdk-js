import { Http } from './http.js';
import { IdMap } from './idmap.js';
import { Syncer } from './sync.js';

const MAX_BULK = 500;
const enc = encodeURIComponent;

const chunks = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

class Resource {
  constructor(http, path) {
    this.http = http;
    this.path = path;
  }

  /** Creates the record the first time `externalId` is seen, updates it afterwards. Safe to repeat. */
  upsert(push) {
    if (!push?.externalId) throw new Error('externalId is required');
    return this.http.request('PUT', `${this.path}/${enc(push.externalId)}`, push);
  }

  /** Upserts many; split into requests of at most 500. One result per item, in order, failures included. */
  async bulk(items, { chunkSize = MAX_BULK } = {}) {
    const results = [];
    for (const part of chunks(items, Math.min(chunkSize, MAX_BULK)))
      results.push(...(await this.http.request('POST', `${this.path}/bulk`, { items: part })));
    return results;
  }

  get(externalId) {
    return this.http.request('GET', `${this.path}/${enc(externalId)}`);
  }
}

export class ObensClient {
  /**
   * @param {{baseUrl: string, apiKey: string, timeoutMs?: number, maxRetries?: number, retryDelayMs?: number}} options
   *   baseUrl is the core api, e.g. https://api.obens.so/v2/core
   */
  constructor(options) {
    this.options = options;
    const http = new Http(options);
    this.http = http;
    this.subActors = new Resource(http, '/integration/sub-actors');
    this.facilities = new Resource(http, '/integration/facilities');
    this.accounts = {
      /** The key's own account and the accounts delegated to it: [{ id, name, self }]. */
      accessible: () => http.request('GET', '/integration/accounts'),
      link: (externalId, accountId) =>
        http.request('PUT', `/integration/accounts/${enc(externalId)}`, { accountId }),
      unlink: (externalId) => http.request('DELETE', `/integration/accounts/${enc(externalId)}`),
    };
    this.mappings = {
      list: (type) => http.request('GET', `/integration/mappings/${type}`),
      toInternal: (type, externalId) =>
        http.request('GET', `/integration/mappings/${type}/external/${enc(externalId)}`),
      toExternal: (type, id) => http.request('GET', `/integration/mappings/${type}/internal/${enc(id)}`),
    };
  }

  /**
   * A client that acts as an account delegated to the key's account (see `accounts.accessible()`): farmers,
   * facilities, links and id tables are then those of that account. Its ids are separate from the key account's.
   */
  forAccount(accountId) {
    return new ObensClient({ ...this.options, accountId });
  }

  /** Who the key is: { keyId, keyName, accountId, workspaceId }. Handy as a connection check. */
  whoami() {
    return this.http.request('GET', '/integration/whoami');
  }

  /** The lists farmers can be created in: [{ id, name, path }]. */
  elements() {
    return this.http.request('GET', '/integration/elements');
  }

  /**
   * The custom fields of the farmers in a list: [{ id, staticId, name, type, writable, valueHint, choices }].
   * Use `name` (or `staticId`) as the key of `data` when pushing a farmer.
   */
  subActorSchema(elementId) {
    return this.http.request('GET', `/integration/sub-actors/schema?element-id=${encodeURIComponent(elementId)}`);
  }

  /** Id table for 'SUB_ACTOR' | 'FACILITY' | 'ACCOUNT'. Call `.load()` to fill it. */
  idMap(type) {
    return new IdMap(this, type);
  }

  /**
   * Initial load + push-on-change for one kind.
   * @param {'subActors'|'facilities'} kind
   * @param {{map: (record: any) => object, chunkSize?: number, onProgress?: Function}} options map turns your record into a push
   */
  syncer(kind, options) {
    const resource = this[kind];
    if (!(resource instanceof Resource)) throw new Error(`kind must be 'subActors' or 'facilities'`);
    return new Syncer(resource, kind, options);
  }
}
