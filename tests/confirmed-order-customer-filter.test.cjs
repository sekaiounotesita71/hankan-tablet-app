const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ReferenceSites = require('../reference-sites.js');
const html = fs.readFileSync(path.join(__dirname, '..', 'order-entry-beta.html'), 'utf8');

function section(start, end) {
  const from = html.indexOf(start), to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return html.slice(from, to);
}
function batch(id, code, name, extra = {}) {
  return {id, customer: {code, name}, importer: {code: '01', name: 'DIM'},
    orderDate: '2026-10-15', siteCode: 'TYO', confirmedAt: '2026-10-15T01:00:00Z',
    rows: [{productCode: id, productName: 'Product', qty: 1, unit: 'PC'}], ...extra};
}
function runtime(batches = [
  batch('a', '01-019A', 'EDO-OTR'),
  batch('b', '01-019AB', 'EDO-OTR'),
  batch('c', '01-007A', 'MEC'),
  batch('d', '02-019A', 'EDO-OTR', {importer: {code: '02', name: 'FBI'}, siteCode: 'OSA'}),
  batch('e', '01-019A', 'EDO-OTR', {orderDate: '2026-10-14'}),
  batch('f', '03-001', '\u30b9\u30b7\u5e97'),
  batch('g', '', 'Legacy shop'),
  batch('h', '', '', {customer: null})
]) {
  const nodes = Object.fromEntries(['confirmed-filter-date', 'confirmed-filter-site',
    'confirmed-filter-importer', 'confirmed-filter-customer', 'confirmed-customer-list',
    'confirmed-orders'].map(id => [id, {value: '', innerHTML: ''}]));
  const events = {};
  const ctx = vm.createContext({confirmedBatches: batches, ReferenceSites,
    val: id => nodes[id]?.value || '',
    esc: value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char])),
    document: {getElementById: id => nodes[id], addEventListener: (name, handler) => (events[name] ||= []).push(handler)}
  });
  vm.runInContext(section('function normalizeMasterSearchText(', 'function matchScore('), ctx);
  vm.runInContext(section('function batchLabel(', 'async function markBatchCancelledInDb('), ctx);
  vm.runInContext(section('["confirmed-filter-date","confirmed-filter-importer","confirmed-filter-customer"].forEach', '["report-filter-date"'), ctx);
  return {ctx, nodes, events, render(filters = {}) {
    Object.entries(filters).forEach(([key, value]) => {nodes[`confirmed-filter-${key}`].value = value;});
    ctx.renderConfirmedOrders();
    return [...nodes['confirmed-orders'].innerHTML.matchAll(/restoreConfirmedBatch\((\d+)\)/g)].map(match => Number(match[1]));
  }};
}

test('empty filters keep confirmed orders hidden; customer alone opens matching orders', () => {
  const app = runtime();
  assert.deepEqual(app.render(), []);
  assert.deepEqual(app.render({customer: 'edo'}), [0, 1, 3, 4]);
  assert.deepEqual(app.render({customer: '007'}), [2]);
});

test('exact customer codes separate same-name and prefix-collision customers', () => {
  const app = runtime();
  assert.deepEqual(app.render({customer: '01-019A'}), [0, 4]);
  assert.deepEqual(app.render({customer: '01-019AB'}), [1]);
  assert.deepEqual(app.render({customer: '02-019A'}), [3]);
});

test('width, letter case, whitespace and kana normalize without modifying input', () => {
  const app = runtime();
  const value = ' \uff10\uff11\uff0d\uff10\uff11\uff19\uff41 ';
  assert.deepEqual(app.render({customer: value}), [0, 4]);
  assert.equal(app.nodes['confirmed-filter-customer'].value, value);
  assert.deepEqual(app.render({customer: '\u3059\u3057'}), [5]);
  assert.deepEqual(app.render({customer: '01-007a mec'}), [2]);
});

test('customer composes with date, importer and site and retains original action indexes', () => {
  const app = runtime();
  assert.deepEqual(app.render({customer: 'EDO', date: '2026-10-15', importer: 'dim', site: 'TYO'}), [0, 1]);
  assert.deepEqual(app.render({importer: '02', site: 'OSA'}), [3]);
  assert.match(app.nodes['confirmed-orders'].innerHTML, /deleteConfirmedBatch\(3\)/);
  assert.deepEqual(app.render({customer: '01-019A'}), []);
  assert.deepEqual(app.render({customer: 'EDO', importer: 'DIM', site: 'TYO', date: '2026-10-14'}), [4]);
});

test('candidates come from scoped confirmed orders and retain same-name distinct codes', () => {
  const app = runtime();
  app.render({date: '2026-10-15', importer: 'DIM', site: 'TYO'});
  const list = app.nodes['confirmed-customer-list'].innerHTML;
  assert.match(list, /value="01-019A" label="EDO-OTR"/);
  assert.match(list, /value="01-019AB" label="EDO-OTR"/);
  assert.equal((list.match(/value="01-019A"/g) || []).length, 1);
  assert.ok(!list.includes('02-019A'));
  app.render({customer: 'MEC'});
  assert.equal(app.nodes['confirmed-customer-list'].innerHTML, list);
});

test('missing masters, name-only historical customers, empty results and HTML are safe', () => {
  const app = runtime();
  assert.deepEqual(app.render({customer: 'legacy'}), [6]);
  assert.deepEqual(app.render({customer: 'not-found'}), []);
  assert.deepEqual(runtime([]).render({customer: 'a'}), []);
  const special = runtime([batch('a', 'C"1', '<script>alert(1)</script>')]);
  special.render({customer: 'C'});
  assert.ok(!special.nodes['confirmed-customer-list'].innerHTML.includes('<script>'));
  assert.match(special.nodes['confirmed-customer-list'].innerHTML, /value="C&quot;1"/);
});

test('input events filter immediately without auto-selecting or altering records', () => {
  const app = runtime();
  const before = JSON.stringify(app.ctx.confirmedBatches);
  app.nodes['confirmed-filter-customer'].value = 'EDO';
  app.events.input.forEach(fn => fn({target: {id: 'confirmed-filter-customer'}}));
  assert.match(app.nodes['confirmed-orders'].innerHTML, /restoreConfirmedBatch\(3\)/);
  assert.equal(app.nodes['confirmed-filter-customer'].value, 'EDO');
  assert.equal(JSON.stringify(app.ctx.confirmedBatches), before);
});

test('clear resets all four filters and hides the results again', () => {
  const app = runtime();
  app.render({date: '2026-10-15', importer: '01', site: 'TYO', customer: 'MEC'});
  app.ctx.clearConfirmedFilters();
  for (const key of ['date', 'importer', 'site', 'customer']) assert.equal(app.nodes[`confirmed-filter-${key}`].value, '');
  assert.ok(!app.nodes['confirmed-orders'].innerHTML.includes('restoreConfirmedBatch('));
});

test('HTML exposes a labeled native candidate list and every inline script compiles', () => {
  assert.match(html, /<label>\u5f97\u610f\u5148<input id="confirmed-filter-customer" list="confirmed-customer-list"/);
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (match[2].trim() && !/application\/json/.test(match[1])) new vm.Script(match[2]);
  }
});
