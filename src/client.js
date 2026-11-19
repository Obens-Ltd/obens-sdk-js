import { Http } from './http.js';
import { IdMap } from './idmap.js';
import { Syncer } from './sync.js';

const MAX_BULK = 500;
const enc = encodeURIComponent;

// ?a=1&b=2 from the given pairs, skipping the unset ones
const qs = (pairs) => {
  const parts = Object.entries(pairs).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${enc(v)}`);
  return parts.length ? `?${parts.join('&')}` : '';
};

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

  /** `subActor`: the external id of the farmer a facility belongs to (facility ids are unique per owner). */
  get(externalId, { subActor } = {}) {
    const query = subActor ? `?sub-actor=${enc(subActor)}` : '';
    return this.http.request('GET', `${this.path}/${enc(externalId)}${query}`);
  }
}

/** Batches and transactions, which live in the trace api (a second base url, and the workspace id as a header). */
class TraceResource {
  constructor(client, path, field) {
    this.client = client;
    this.path = path;
    this.field = field;
  }

  /**
   * Creates the record the first time `externalId` is seen, updates it afterwards. Safe to repeat.
   * Creation waits for the platform to finish, so the call can take several seconds.
   */
  async upsert(push) {
    if (!push?.externalId) throw new Error('externalId is required');
    const { externalId, ...body } = await this.client._resolve(push, this.field);
    return this.client.trace.request('PUT', `${this.path}/${enc(externalId)}`, body);
  }

  /** Upserts many, one after the other (each creation is a heavy write). One result per item; a failure does not stop the rest. */
  async bulk(items) {
    const results = [];
    for (const item of items) {
      try {
        results.push(await this.upsert(item));
      } catch (error) {
        results.push({ externalId: item?.externalId, id: null, outcome: 'FAILED', error: error.message });
      }
    }
    return results;
  }
}

class Batches extends TraceResource {
  constructor(client) {
    super(client, '/integration/batches', 'batch');
  }

  /** `ownerId`: a sub-actor's platform id, for what a purchase from a farmer created (owned by the farmer). */
  get(externalId, { ownerId } = {}) {
    return this.client.trace.request('GET', `${this.path}/${enc(externalId)}${ownerId ? `?owner-id=${enc(ownerId)}` : ''}`);
  }

  /** A page of batches in an element: { data, page, size, total, totalPages, hasNext }. `search` matches name / ref. */
  list(elementId, { ownerId, search, year, page, size } = {}) {
    return this.client.trace.request('GET', `${this.path}${qs({ 'element-id': elementId, 'owner-id': ownerId, search, year, page, size })}`);
  }

  /** What the batch's form holds: [{ id, staticId, name, type, value }], values in the shape `data` accepts. */
  data(externalId, { ownerId } = {}) {
    return this.client.trace.request('GET', `${this.path}/${enc(externalId)}/data${qs({ 'owner-id': ownerId })}`);
  }

  /** The fields of a production method's form: the names `data` accepts. */
  schema(productionMethodId) {
    return this.client.trace.request('GET', `${this.path}/schema?production-method-id=${enc(productionMethodId)}`);
  }
}

class Transactions extends TraceResource {
  constructor(client) {
    super(client, '/integration/transactions', 'transaction');
  }

  /** `supplierId`: a sub-actor's platform id, for a purchase from a farmer (default: the key's account). */
  get(externalId, { supplierId } = {}) {
    return this.client.trace.request('GET', `${this.path}/${enc(externalId)}${supplierId ? `?supplier-id=${enc(supplierId)}` : ''}`);
  }

  /**
   * A page of the account's transactions in an element, as buyer or seller.
   * `type`: 'BUY' | 'SELL'; `start` / `end`: 2026-01-31; `otherAccountId`: the counterparty's platform id.
   */
  list(elementId, { otherAccountId, type, start, end, search, page, size } = {}) {
    return this.client.trace.request('GET', `${this.path}${qs({ 'element-id': elementId, 'other-account-id': otherAccountId, type, start, end, search, page, size })}`);
  }

  /** What the transaction's form holds: [{ id, staticId, name, type, value }]. */
  data(externalId, { supplierId } = {}) {
    return this.client.trace.request('GET', `${this.path}/${enc(externalId)}/data${qs({ 'supplier-id': supplierId })}`);
  }

  /** The fields of the transaction form an account (the buyer, default: the key's) has for an element. */
  schema(elementId, { clientId } = {}) {
    return this.client.trace.request('GET', `${this.path}/schema?element-id=${enc(elementId)}${clientId ? `&client-id=${enc(clientId)}` : ''}`);
  }
}

export class ObensClient {
  /**
   * @param {{baseUrl: string, apiKey: string, timeoutMs?: number, maxRetries?: number, retryDelayMs?: number}} options
   *   baseUrl is the core api, e.g. https://api.obens.so/v2/core. `traceUrl` is the trace api that holds batches and
   *   transactions; it defaults to baseUrl with `/v2/core` swapped for `/v2/trace`.
   */
  constructor(options) {
    this.options = options;
    const http = new Http(options);
    this.http = http;
    this._ids = new Map();
    this._workspaceId = undefined;
    const traceUrl = options.traceUrl ?? options.baseUrl?.replace(/\/v2\/core\/*$/, '/v2/trace');
    // creations are heavy and the server waits for them (up to a minute): a longer timeout than for farmers
    this.trace = new Http({
      ...options,
      baseUrl: traceUrl,
      timeoutMs: options.traceTimeoutMs ?? 90000,
      extraHeaders: async () => ({ 'X-WORKSPACE-ID': await this._workspace() }),
    });
    this.batches = new Batches(this);
    this.transactions = new Transactions(this);
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

  // the key's workspace: the trace api is routed by it, and core knows it from the key
  async _workspace() {
    if (!this._workspaceId) this._workspaceId = (await this.whoami()).workspaceId;
    return this._workspaceId;
  }

  // platform id of one of the client's own records, remembered for the life of the client
  async _internal(type, externalId) {
    const key = `${type}:${externalId}`;
    if (!this._ids.has(key)) this._ids.set(key, (await this.mappings.toInternal(type, externalId)).id);
    return this._ids.get(key);
  }

  /**
   * Replaces the client's own ids in a push with platform ids: `subActorExternalId` -> `subActorId`,
   * `supplierExternalId` / `clientExternalId` -> `supplierId` / `clientId` (linked accounts), and in a purchase
   * `collected.facilityExternalIds` -> `collected.facilityIds`.
   */
  async _resolve(push, field) {
    if (field !== 'transaction') return push;
    const out = { ...push };
    if (out.subActorExternalId !== undefined) {
      out.subActorId = await this._internal('SUB_ACTOR', out.subActorExternalId);
      delete out.subActorExternalId;
    }
    for (const role of ['supplier', 'client']) {
      const key = `${role}ExternalId`;
      if (out[key] !== undefined) {
        out[`${role}Id`] = await this._internal('ACCOUNT', out[key]);
        delete out[key];
      }
    }
    if (out.collected?.facilityExternalIds) {
      const { facilityExternalIds, ...collected } = out.collected;
      out.collected = { ...collected, facilityIds: await Promise.all(facilityExternalIds.map((id) => this._internal('FACILITY', id))) };
    }
    return out;
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
