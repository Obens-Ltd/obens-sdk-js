import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ObensClient, ObensApiError, createMapper, constant } from '../src/index.js';

// A tiny fake of the integration API, enough to exercise the SDK end to end.
function fakeServer() {
  const state = { calls: [], subActors: new Map(), failFirst: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const route = req.url.split('?')[0];
      state.calls.push({ method: req.method, url: req.url, key: req.headers['x-api-key'], body });
      const send = (status, json, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(json === undefined ? '' : JSON.stringify(json));
      };
      if (req.headers['x-api-key'] !== 'obk_good') return send(401);
      if (state.failFirst > 0) {
        state.failFirst--;
        return send(503, {}, { 'retry-after': '0' });
      }
      const upsert = (item) => {
        const created = !state.subActors.has(item.externalId);
        if (created) state.subActors.set(item.externalId, `id-${state.subActors.size + 1}`);
        return { externalId: item.externalId, id: state.subActors.get(item.externalId), outcome: created ? 'CREATED' : 'UPDATED', error: null };
      };
      if (req.method === 'PUT' && route.startsWith('/integration/sub-actors/'))
        return send(200, upsert({ ...body, externalId: decodeURIComponent(route.split('/').pop()) }));
      if (req.method === 'POST' && route === '/integration/sub-actors/bulk')
        return send(200, body.items.map((i) => (i.name === 'bad' ? { externalId: i.externalId, id: null, outcome: 'FAILED', error: 'nope' } : upsert(i))));
      if (route === '/integration/sub-actors/schema')
        return send(200, [{ id: 'f1', staticId: 'crop', name: 'Crop', type: 'TextInput', writable: true }]);
      if (route === '/integration/mappings/SUB_ACTOR')
        return send(200, [...state.subActors].map(([externalId, id]) => ({ type: 'SUB_ACTOR', externalId, id })));
      if (route.startsWith('/integration/mappings/SUB_ACTOR/external/')) {
        const ext = decodeURIComponent(route.split('/').pop());
        return state.subActors.has(ext) ? send(200, { type: 'SUB_ACTOR', externalId: ext, id: state.subActors.get(ext) }) : send(404, { message: 'x' });
      }
      send(404);
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

const withServer = async (fn) => {
  const f = await fakeServer();
  try {
    await fn(f);
  } finally {
    f.server.close();
  }
};

test('createMapper maps paths, functions and constants and skips empty values', () => {
  const map = createMapper({ externalId: 'id', name: (r) => `${r.first} ${r.last}`, 'info.name': 'site.title', type: constant('FARMER'), ref: 'missing' });
  assert.deepEqual(map({ id: 7, first: 'A', last: 'B', site: { title: 'T' } }), { externalId: 7, name: 'A B', info: { name: 'T' }, type: 'FARMER' });
});

test('upsert sends the api key and url-encodes the external id', () =>
  withServer(async ({ url, state }) => {
    const client = new ObensClient({ baseUrl: url, apiKey: 'obk_good' });
    const r = await client.subActors.upsert({ externalId: 'a/b c', name: 'X' });
    assert.equal(r.outcome, 'CREATED');
    assert.equal(state.calls[0].url, '/integration/sub-actors/a%2Fb%20c');
    assert.equal(state.calls[0].key, 'obk_good');
  }));

test('a wrong key is a 401 ObensApiError without retries', () =>
  withServer(async ({ url, state }) => {
    const client = new ObensClient({ baseUrl: url, apiKey: 'nope' });
    await assert.rejects(client.whoami(), (e) => e instanceof ObensApiError && e.status === 401);
    assert.equal(state.calls.length, 1);
  }));

test('transient 503s are retried', () =>
  withServer(async ({ url, state }) => {
    state.failFirst = 2;
    const client = new ObensClient({ baseUrl: url, apiKey: 'obk_good', retryDelayMs: 1 });
    const r = await client.subActors.upsert({ externalId: '1', name: 'X' });
    assert.equal(r.outcome, 'CREATED');
    assert.equal(state.calls.length, 3);
  }));

test('init chunks, reports per item and a replay updates instead of creating', () =>
  withServer(async ({ url, state }) => {
    const client = new ObensClient({ baseUrl: url, apiKey: 'obk_good' });
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, name: i === 3 ? 'bad' : `n${i}` }));
    const farmers = client.syncer('subActors', { map: createMapper({ externalId: 'id', name: 'name' }), chunkSize: 2 });
    const first = await farmers.init(rows);
    assert.equal(state.calls.filter((c) => c.url.endsWith('/bulk')).length, 3);
    assert.deepEqual([first.total, first.created, first.failed], [5, 4, 1]);
    assert.equal(first.failures[0].externalId, 'f3');
    const replay = await farmers.init(rows.filter((r) => r.name !== 'bad'));
    assert.deepEqual([replay.created, replay.updated], [0, 4]);
  }));

test('remove sends status DELETED for farmers', () =>
  withServer(async ({ url, state }) => {
    const client = new ObensClient({ baseUrl: url, apiKey: 'obk_good' });
    const farmers = client.syncer('subActors', { map: createMapper({ externalId: 'id' }) });
    await farmers.remove({ id: 'z' });
    assert.equal(state.calls[0].body.status, 'DELETED');
  }));

test('idMap loads the table, translates both ways and treats 404 as unknown', () =>
  withServer(async ({ url }) => {
    const client = new ObensClient({ baseUrl: url, apiKey: 'obk_good' });
    await client.subActors.upsert({ externalId: 'A', name: 'x' });
    const ids = await client.idMap('SUB_ACTOR').load();
    assert.equal(await ids.internal('A'), 'id-1');
    assert.equal(await ids.external('id-1'), 'A');
    assert.equal(await ids.internal('missing'), undefined);
  }));

test('forAccount scopes every call to a delegated account without touching the original client', () =>
  withServer(async ({ url, state }) => {
    const client = new ObensClient({ baseUrl: url, apiKey: 'obk_good' });
    const delegated = client.forAccount('acc 1');
    await delegated.subActors.upsert({ externalId: '1', name: 'X' });
    await client.subActors.upsert({ externalId: '2', name: 'Y' });
    await delegated.idMap('SUB_ACTOR').load();
    assert.equal(state.calls[0].url, '/integration/sub-actors/1?account-id=acc%201');
    assert.equal(state.calls[1].url, '/integration/sub-actors/2');
    assert.equal(state.calls[2].url, '/integration/mappings/SUB_ACTOR?account-id=acc%201');
  }));

test('subActorSchema asks for the custom fields of an element', () =>
  withServer(async ({ url, state }) => {
    const client = new ObensClient({ baseUrl: url, apiKey: 'obk_good' });
    const fields = await client.subActorSchema('el 1');
    assert.equal(fields[0].name, 'Crop');
    assert.match(state.calls.at(-1).url, /schema\?element-id=el%201/);
  }));
