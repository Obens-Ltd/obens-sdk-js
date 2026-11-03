// Biolife (e-pineA) pushes `{ type, action, data }` events from its field app. This shows how those records go
// through the SDK: the producer and the field become farmers and facilities, keyed by the app's own `appId`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ObensClient, createMapper, constant } from '../src/index.js';

const FARMERS_ELEMENT = '66f000000000000000000001';

const producteur = (n, extra = {}) => ({
  type: 'producteur',
  action: 'create',
  data: {
    appId: `prd-${n}`, firstName: 'Afi', lastName: 'Houngbo', phone: `+2299700000${n}`, gender: 'F',
    birthday: '1985-04-12', zone: 'ZON_3', address: 'Allada, Sékou', ...extra,
  },
});

const champ = (n, producteurId, extra = {}) => ({
  type: 'fields',
  action: 'create',
  data: {
    appId: `chp-${n}`, producteurId, libelle: `Champ ${n}`, plantingDate: '2025-11-03',
    latitude: 6.6512, longitude: 2.1534, varietyId: 'VAR_1', zoneId: 'ZON_3',
    coordinates: [{ lat: 6.65, lng: 2.15 }, { lat: 6.65, lng: 2.16 }, { lat: 6.66, lng: 2.16 }], ...extra,
  },
});

// a polygon is a closed GeoJSON ring of [lng, lat]; a field drawn with fewer than 3 points is only a position
const ring = (points) => {
  const r = points.map((p) => [p.lng, p.lat]);
  return [...r, r[0]];
};
const mapField = createMapper({
  externalId: 'data.appId',
  'info.name': (e) => e.data.libelle,
  'info.description': (e) => `Planté le ${e.data.plantingDate}`,
  coordinates: ({ data }) =>
    data.coordinates?.length >= 3
      ? { type__: 'Area', type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring(data.coordinates)] } }] }
      : { type__: 'Point', latitude: data.latitude, longitude: data.longitude },
});

const mapProducer = createMapper({
  externalId: 'data.appId',                       // the app's own code: sending it twice never duplicates
  name: ({ data }) => `${data.firstName} ${data.lastName}`,
  ref: 'data.phone',                              // the phone is what identifies a producer for them
  address: 'data.address',
  gender: ({ data }) => ({ M: 'MALE', F: 'FEMALE' })[data.gender],
  type: constant('FARMER'),
  elementId: constant(FARMERS_ELEMENT),
});

function fake() {
  const state = { bodies: [], known: new Set() };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const route = req.url.split('?')[0];
      const upsert = (item) => {
        state.bodies.push(item);
        const created = !state.known.has(item.externalId);
        state.known.add(item.externalId);
        return { externalId: item.externalId, id: `id-${item.externalId}`, outcome: created ? 'CREATED' : 'UPDATED', error: null };
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'PUT') return res.end(JSON.stringify(upsert({ ...body, externalId: decodeURIComponent(route.split('/').pop()) })));
      return res.end(JSON.stringify(body.items.map(upsert)));
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

const withServer = async (fn) => {
  const f = await fake();
  try {
    await fn(f);
  } finally {
    f.server.close();
  }
};

test('biolife producers: two producers with the same name stay two farmers, a replay updates', () =>
  withServer(async ({ url, state }) => {
    const client = new ObensClient({ baseUrl: url, apiKey: 'obk_good' });
    const farmers = client.syncer('subActors', { map: mapProducer });
    const events = [producteur(1), producteur(2), producteur(3, { gender: 'X' })];

    const first = await farmers.init(events);
    assert.deepEqual([first.total, first.created, first.failed], [3, 3, 0]);
    assert.deepEqual(state.bodies[0], {
      externalId: 'prd-1', name: 'Afi Houngbo', ref: '+22997000001', address: 'Allada, Sékou',
      gender: 'FEMALE', type: 'FARMER', elementId: FARMERS_ELEMENT,
    });
    assert.equal(state.bodies[0].name, state.bodies[1].name);
    assert.notEqual(state.bodies[0].ref, state.bodies[1].ref);
    assert.equal('gender' in state.bodies[2], false, 'an unknown gender is left out, not sent as null');

    const replay = await farmers.init(events);
    assert.deepEqual([replay.created, replay.updated], [0, 3]);
  }));

test('biolife fields: a traced field becomes a closed polygon, an untraced one a point', () =>
  withServer(async ({ url, state }) => {
    const client = new ObensClient({ baseUrl: url, apiKey: 'obk_good' });
    const facilities = client.syncer('facilities', { map: mapField });

    const report = await facilities.init([champ(1, 'prd-1'), champ(2, 'prd-1', { coordinates: [{ lat: 6.6, lng: 2.1 }] })]);
    assert.deepEqual([report.created, report.failed], [2, 0]);

    const [traced, untraced] = state.bodies;
    assert.equal(traced.info.name, 'Champ 1');
    const polygon = traced.coordinates.features[0].geometry;
    assert.equal(polygon.type, 'Polygon');
    assert.deepEqual(polygon.coordinates[0][0], [2.15, 6.65], 'GeoJSON order is [longitude, latitude]');
    assert.deepEqual(polygon.coordinates[0].at(-1), polygon.coordinates[0][0], 'the ring is closed');
    assert.equal(polygon.coordinates[0].length, 4);
    assert.deepEqual(untraced.coordinates, { type__: 'Point', latitude: 6.6512, longitude: 2.1534 });
  }));

test('biolife events: create / update push, delete removes, other record types are not ours', () =>
  withServer(async ({ url, state }) => {
    const client = new ObensClient({ baseUrl: url, apiKey: 'obk_good' });
    const farmers = client.syncer('subActors', { map: mapProducer });
    const facilities = client.syncer('facilities', { map: mapField });

    // what the integration does with the stream the app sends
    const handle = async (event) => {
      const target = { producteur: farmers, fields: facilities }[event.type];
      if (!target) return undefined; // tif, phytosanitaire, conditionnement have no counterpart yet
      return event.action === 'delete' ? target.remove(event) : target.push(event);
    };

    assert.equal((await handle(producteur(1))).outcome, 'CREATED');
    assert.equal((await handle({ ...producteur(1), action: 'update', data: { ...producteur(1).data, lastName: 'Houngbo-Dossou' } })).outcome, 'UPDATED');
    assert.equal(state.bodies.at(-1).name, 'Afi Houngbo-Dossou');

    await handle({ ...producteur(1), action: 'delete' });
    assert.equal(state.bodies.at(-1).status, 'DELETED');
    await handle({ ...champ(1, 'prd-1'), action: 'delete' });
    assert.equal(state.bodies.at(-1).deleted, true);

    const before = state.bodies.length;
    assert.equal(await handle({ type: 'tif', action: 'create', data: { appId: 'tif-1' } }), undefined);
    assert.equal(state.bodies.length, before);
  }));
