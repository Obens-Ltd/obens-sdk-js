/** Your id <-> platform id for one kind (SUB_ACTOR, FACILITY or ACCOUNT), cached after `load()`. */
export class IdMap {
  constructor(client, type) {
    this.client = client;
    this.type = type;
    this.toId = new Map();
    this.toExternal = new Map();
  }

  /** Downloads the whole table once. */
  async load() {
    const mappings = await this.client.mappings.list(this.type);
    this.toId.clear();
    this.toExternal.clear();
    for (const m of mappings) this.#put(m);
    return this;
  }

  /** The platform id for your id, from the cache or the server. `undefined` when it is unknown. */
  async internal(externalId) {
    if (!this.toId.has(externalId)) {
      const m = await this.client.mappings.toInternal(this.type, externalId).catch(notFoundToUndefined);
      if (m) this.#put(m);
    }
    return this.toId.get(externalId);
  }

  /** Your id for a platform id. `undefined` when the record has none. */
  async external(id) {
    if (!this.toExternal.has(id)) {
      const m = await this.client.mappings.toExternal(this.type, id).catch(notFoundToUndefined);
      if (m) this.#put(m);
    }
    return this.toExternal.get(id);
  }

  /** Remembers results of a push without another request. */
  remember(results) {
    for (const r of results) if (r.id) this.#put({ externalId: r.externalId, id: r.id });
  }

  #put({ externalId, id }) {
    this.toId.set(externalId, id);
    this.toExternal.set(id, externalId);
  }
}

const notFoundToUndefined = (error) => {
  if (error?.status === 404) return undefined;
  throw error;
};
