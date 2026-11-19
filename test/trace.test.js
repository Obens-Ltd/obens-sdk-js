import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ObensClient } from '../src/index.js';

// A fake of the core + trace apis: whoami and id mappings on one side, batches and transactions on the other.
function fakeServer() {
  const state = { calls: [], whoami: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const route = req.url.split('?')[0];
      state.calls.push({ method: req.method, url: req.url, workspace: req.headers['x-workspace-id'], body });
      const send = (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(json === undefined ? '' : JSON.stringify(json));
      };
      if (route === '/integration/whoami') {
        state.whoami++;
        return send(200, { keyId: 'k', keyName: 'n', accountId: 'a1', workspaceId: 'w1' });
      }
      if (route === '/integration/mappings/SUB_ACTOR/external/farmer-1') return send(200, { type: 'SUB_ACTOR', externalId: 'farmer-1', id: 'sa-1' });
      if (route === '/integration/mappings/FACILITY/external/orchard-1') return send(200, { type: 'FACILITY', externalId: 'orchard-1', id: 'fa-1' });
      if (route === '/integration/mappings/ACCOUNT/external/buyer-1') return send(200, { type: 'ACCOUNT', externalId: 'buyer-1', id: 'ac-9' });
      if (req.method === 'PUT' && route.startsWith('/integration/batches/')) {
        if (body.name === 'bad') return send(400, { message: 'QUANTITY_IS_REQUIRED' });
        return send(200, { externalId: decodeURIComponent(route.split('/').pop()), id: 'b-1', outcome: 'CREATED', error: null });
      }
      if (req.method === 'PUT' && route.startsWith('/integration/transactions/'))
        return send(200, { externalId: decodeURIComponent(route.split('/').pop()), id: 't-1', outcome: 'CREATED', error: null });
      if (route === '/integration/batches') return send(200, { data: [{ id: 'b-1', externalId: 'lot-1' }], page: 0, size: 10, total: 1 });
      if (route === '/integration/transactions') return send(200, { data: [{ id: 't-1', externalId: 'tr-1' }], page: 0, size: 10, total: 1 });
      if (route.endsWith('/data')) return send(200, [{ id: 'f1', name: 'Moisture', type: 'NumericInput', value: 12 }]);
      if (route === '/integration/batches/schema') return send(200, [{ id: 'f1', name: 'Moisture', type: 'NumericInput', writable: true }]);
      if (route === '/integration/transactions/schema') return send(200, []);
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

test('a batch push goes to the trace api with the key workspace, asked once', () =>
  withServer(async ({ url, state }) => {
    const client = new ObensClient({ baseUrl: url, traceUrl: url, apiKey: 'obk_good' });
    const r = await client.batches.upsert({ externalId: 'lot/1', name: 'Lot', quantity: { value: 5, unit: 'KG' }, data: { Moisture: 12 } });
    await client.batches.upsert({ externalId: 'lot/1', name: 'Lot' });
    assert.equal(r.outcome, 'CREATED');
    const puts = state.calls.filter((c) => c.method === 'PUT');
    assert.equal(puts[0].url, '/integration/batches/lot%2F1');
    assert.equal(puts[0].workspace, 'w1');
    assert.deepEqual(puts[0].body, { name: 'Lot', quantity: { value: 5, unit: 'KG' }, data: { Moisture: 12 } });
    assert.equal(state.whoami, 1);
  }));

test('a purchase names the farmer, the buyer and the facilities by the client ids', () =>
  withServer(async ({ url, state }) => {
    const client = new ObensClient({ baseUrl: url, traceUrl: url, apiKey: 'obk_good' });
    await client.transactions.upsert({
      externalId: 'buy-1', elementId: 'e1', subActorExternalId: 'farmer-1', date: '2026-02-01',
      collected: { name: 'Olives', quantity: { value: 100, unit: 'KG' }, facilityExternalIds: ['orchard-1'] },
    });
    await client.transactions.upsert({ externalId: 'tr-1', elementId: 'e1', clientExternalId: 'buyer-1', supplierId: 'a1', batches: [] });
    const [purchase, transfer] = state.calls.filter((c) => c.method === 'PUT').map((c) => c.body);
    assert.equal(purchase.subActorId, 'sa-1');
    assert.equal(purchase.subActorExternalId, undefined);
    assert.deepEqual(purchase.collected.facilityIds, ['fa-1']);
    assert.equal(transfer.clientId, 'ac-9');
    assert.equal(transfer.supplierId, 'a1');
  }));

test('bulk keeps going after a failed item and reports it', () =>
  withServer(async ({ url }) => {
    const client = new ObensClient({ baseUrl: url, traceUrl: url, apiKey: 'obk_good', maxRetries: 0 });
    const results = await client.batches.bulk([{ externalId: 'a', name: 'ok' }, { externalId: 'b', name: 'bad' }, { externalId: 'c', name: 'ok' }]);
    assert.deepEqual(results.map((r) => r.outcome), ['CREATED', 'FAILED', 'CREATED']);
    assert.match(results[1].error, /QUANTITY_IS_REQUIRED/);
  }));

test('trace url defaults from the core url, and schema / list read the trace api', () =>
  withServer(async ({ url, state }) => {
    const client = new ObensClient({ baseUrl: `${url}/v2/core`, apiKey: 'obk_good' });
    assert.equal(client.trace.baseUrl, `${url}/v2/trace`);
    const direct = new ObensClient({ baseUrl: url, traceUrl: url, apiKey: 'obk_good' });
    assert.equal((await direct.batches.schema('pm1'))[0].name, 'Moisture');
    assert.equal((await direct.batches.list('e1', { ownerId: 'sa-1' })).data[0].externalId, 'lot-1');
    assert.ok(state.calls.some((c) => c.url === '/integration/batches?element-id=e1&owner-id=sa-1'));
  }));

test('reads: transaction list builds its query, form data is read by external id', () =>
  withServer(async ({ url, state }) => {
    const client = new ObensClient({ baseUrl: url, traceUrl: url, apiKey: 'obk_good' });
    const page = await client.transactions.list('e1', { type: 'BUY', start: '2026-01-01', search: 'olive oil', size: 5 });
    assert.equal(page.data[0].externalId, 'tr-1');
    assert.ok(state.calls.some((c) => c.url === '/integration/transactions?element-id=e1&type=BUY&start=2026-01-01&search=olive%20oil&size=5'));
    assert.equal((await client.batches.data('lot/1', { ownerId: 'sa-1' }))[0].value, 12);
    assert.ok(state.calls.some((c) => c.url === '/integration/batches/lot%2F1/data?owner-id=sa-1'));
    assert.equal((await client.transactions.data('tr-1'))[0].name, 'Moisture');
  }));
