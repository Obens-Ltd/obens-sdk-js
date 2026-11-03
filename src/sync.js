const MAX_BULK = 500;

const report = () => ({ total: 0, created: 0, updated: 0, failed: 0, failures: [], results: [] });

function add(rep, results) {
  for (const r of results) {
    rep.total++;
    if (r.outcome === 'CREATED') rep.created++;
    else if (r.outcome === 'UPDATED') rep.updated++;
    else {
      rep.failed++;
      rep.failures.push({ externalId: r.externalId, error: r.error });
    }
    rep.results.push(r);
  }
}

/**
 * Keeps one kind of record in sync with the platform.
 *  - `init(records)`: the first full load, chunked, with a report of what was created / updated / failed
 *  - `push(record)` / `pushMany(records)`: send changes as they happen (upsert, so replays are harmless)
 *  - `remove(record)`: send a delete
 * `map(record)` must return the push body including `externalId`.
 */
export class Syncer {
  constructor(resource, kind, { map, chunkSize = 200, onProgress } = {}) {
    if (typeof map !== 'function') throw new Error('map(record) is required');
    this.resource = resource;
    this.kind = kind;
    this.map = map;
    this.chunkSize = Math.min(chunkSize, MAX_BULK);
    this.onProgress = onProgress;
  }

  /** Accepts an array or any (async) iterable, so a big table can be streamed without loading it all. */
  async init(records) {
    const rep = report();
    let batch = [];
    const flush = async () => {
      if (batch.length === 0) return;
      add(rep, await this.resource.bulk(batch, { chunkSize: this.chunkSize }));
      batch = [];
      this.onProgress?.(rep);
    };
    for await (const record of records) {
      batch.push(this.#mapped(record));
      if (batch.length >= this.chunkSize) await flush();
    }
    await flush();
    return rep;
  }

  async push(record) {
    return this.resource.upsert(this.#mapped(record));
  }

  async pushMany(records) {
    const rep = report();
    add(rep, await this.resource.bulk(records.map((r) => this.#mapped(r)), { chunkSize: this.chunkSize }));
    return rep;
  }

  async remove(record) {
    const push = this.#mapped(record);
    return this.resource.upsert(
      this.kind === 'facilities' ? { ...push, deleted: true } : { ...push, status: 'DELETED' },
    );
  }

  #mapped(record) {
    const push = this.map(record);
    if (!push?.externalId) throw new Error('map(record) must return an object with an externalId');
    return push;
  }
}
