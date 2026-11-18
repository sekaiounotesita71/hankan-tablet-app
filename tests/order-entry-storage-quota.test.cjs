const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const html = fs.readFileSync(path.join(__dirname, '..', 'order-entry-beta.html'), 'utf8');

function section(start, end) {
  const from = html.indexOf(start), to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return html.slice(from, to);
}
const keys = {
  STORAGE_KEY: 'order-entry-beta-v2', MASTER_KEY: 'order-entry-beta-masters-v1',
  CONFIRMED_KEY: 'order-entry-beta-confirmed-v1', LINE_DICT_KEY: 'dictionary',
  IMPORT_DRAFT_KEY: 'import-drafts', PENDING_KEY: 'pending',
  ADVANCE_PURCHASE_DRAFT_KEY: 'purchase-draft'
};

function runtime(options = {}) {
  const stored = new Map(Object.entries(options.stored || {}));
  const removed = [], written = [], alerts = [], events = {}, database = new Map();
  const state = {full: !!options.full, blocked: !!options.blocked, failDb: false, busy: false};
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {value: '', textContent: '', className: '', hidden: true,
      dataset: {}, classList: {toggle() {}, add() {}, remove() {}}, focus() {}});
    return nodes.get(id);
  };
  node('order-date').value = '2026-11-19';
  node('batch-customer-code').value = '03-007';
  node('batch-customer-name').value = 'Customer';
  node('batch-importer-code').value = '03';
  node('batch-importer-name').value = 'BKK';
  let nextId = 1;
  const ctx = vm.createContext({
    ...keys, confirmedBatches: [], importDraftGroups: [], pendingEntries: [],
    orders: [{productCode: '073', productName: 'Product', qty: '3', unit: 'Kg', supplierCode: '04'}],
    draftRows: [], confirmed: false, currentImportDraftId: '', currentOrderAttemptId: '',
    dbReady: true, dbLoadInFlight: false, currentUser: {id: 'user'}, appBusy: false,
    supabaseClient: {}, sharedLineDictionaryReady: true, console: {warn() {}},
    document: {getElementById: node, querySelector: () => null},
    window: {addEventListener: (name, fn) => {events[name] = fn;}},
    localStorage: {
      getItem(key) {
        if (state.blocked) throw Object.assign(new Error('blocked'), {name: 'SecurityError'});
        return stored.get(key) ?? null;
      },
      setItem(key, value) {
        written.push(key);
        if (state.blocked || state.full || (options.cacheFillsStorage && stored.has(keys.CONFIRMED_KEY))) {
          throw Object.assign(new Error('quota'), {name: state.blocked ? 'SecurityError' : 'QuotaExceededError'});
        }
        stored.set(key, String(value));
      },
      removeItem(key) {
        removed.push(key);
        if (state.blocked) throw Object.assign(new Error('blocked'), {name: 'SecurityError'});
        stored.delete(key);
      },
      clear() {throw new Error('Must not clear unrelated storage');}
    },
    val: id => node(id).value || '',
    customer: () => ({code: node('batch-customer-code').value, name: node('batch-customer-name').value}),
    importer: () => ({code: node('batch-importer-code').value, name: node('batch-importer-name').value}),
    currentOrderSiteCode: () => 'OSA', setCurrentOrderSite() {},
    activeOrderRows: () => ctx.orders.filter(row => row.productName),
    isOrderRowBlank: row => !row.productName, today: () => '2026-11-19',
    newAppUuid: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
    isUuid: value => /^00000000-0000-4000-8000-\d{12}$/.test(value),
    prepareBatchPrices: batch => batch, blankOrder: () => ({productCode: '', productName: ''}),
    customerNameIsAmbiguous: () => false,
    learnLineDictionaryFromOrders: async () => {ctx.saveLocalLineDictionary([{expression: 'Product'}]); return 1;},
    saveConfirmedBatchToDb: async batch => {
      if (state.failDb) throw new Error('Database unavailable');
      database.set(batch.id, JSON.parse(JSON.stringify(batch)));
      return {id: batch.id};
    },
    setAppBusy: value => {ctx.appBusy = state.busy = value;},
    dbErrorMessage: error => error.message, alert: message => alerts.push(message),
    removeImportDraftById() {}, hideAllProductSuggestions() {}, hideCustomerSuggestions() {},
    render() {}, requestAnimationFrame() {},
    initSupabase: () => ({}), ensureCurrentUser: async () => ctx.currentUser,
    setDbStatus: text => {node('db-state').textContent = text;},
    loadMastersFromDb: async () => ctx.saveMastersObject({products: [{code: '073', name: 'Product'}]}),
    loadSharedLineDictionaryFromDb: async () => {}, loadPendingEntriesFromDb: async () => {},
    loadPendingLocal() {}, loadProductGuideTemplates: async () => {},
    refreshCustomerLists() {}, refreshImporterLists() {}, refreshProductLists() {}, refreshSupplierLists() {},
    renderPendingEntries() {}, renderMasters() {}, refreshAdvancePurchaseSourceDates() {},
    loadSupplierReviewBoard: async () => {}, pendingDbErrorMessage: error => error.message,
    readAllSupabaseRows: async () => {
      if (state.failDb) throw new Error('Database unavailable');
      return options.batches || [{id: 'db-batch'}];
    },
    loadOrderEntryLinesForBatchIds: async () => [{batch_id: 'db-batch', product_name_snapshot: 'Product'}],
    dbBatchToBatch: (batch, rows) => ({...batch, rows}),
    hasPendingImportReview: () => false
  });
  vm.runInContext(section('const orderEntryMemoryStorage=', 'const baseMasters='), ctx);
  vm.runInContext(section('function savedMastersObject(', 'function getMasters('), ctx);
  vm.runInContext(section('function loadConfirmedBatches(', 'function importDraftLabel('), ctx);
  vm.runInContext(section('function loadLocalLineDictionary(', 'function lineDictionaryCustomerKey('), ctx);
  vm.runInContext(section('function currentBatch(', 'function rowsWithBatchMeta('), ctx);
  vm.runInContext(section('function resetCurrentOrderForm(', 'function setHeaderCustomer('), ctx);
  vm.runInContext(section('async function confirmCustomerOrder(', 'function groupedBySupplier('), ctx);
  vm.runInContext(section('async function loadConfirmedBatchesFromDb(', 'function loadConfirmedBatches('), ctx);
  vm.runInContext(section('window.addEventListener("beforeunload"', 'function protectSingleSubmitAction('), ctx);
  return {ctx, state, stored, removed, written, alerts, events, database, node,
    failures: () => vm.runInContext('orderEntryStorageFailures.size', ctx)};
}

test('startup retires only the confirmed history cache and keeps drafts/auth/other apps intact', () => {
  const preserved = {[keys.STORAGE_KEY]: '{"orders":[1]}', [keys.IMPORT_DRAFT_KEY]: '[1]',
    [keys.PENDING_KEY]: '[2]', [keys.ADVANCE_PURCHASE_DRAFT_KEY]: '{"rows":[3]}',
    'sb-project-auth-token': 'session', 'work-app-draft': 'unchanged'};
  const app = runtime({stored: {...preserved, [keys.CONFIRMED_KEY]: 'large history'}, cacheFillsStorage: true});
  app.ctx.loadConfirmedBatches();
  assert.equal(app.stored.has(keys.CONFIRMED_KEY), false);
  for (const [key, value] of Object.entries(preserved)) assert.equal(app.stored.get(key), value);
  assert.deepEqual(app.removed, [keys.CONFIRMED_KEY]);
  assert.equal(app.ctx.confirmedBatches.length, 0);
  assert.ok(html.indexOf('loadConfirmedBatches();', html.indexOf('function init(){')) <
    html.indexOf('initSupabase();', html.indexOf('function init(){')));
});

test('confirmed history never serializes or writes all historical orders again', () => {
  const app = runtime();
  app.ctx.confirmedBatches = [{id: 'saved', toJSON() {throw new Error('Must not serialize');}}];
  app.ctx.saveConfirmedBatches();
  assert.deepEqual(app.written, []);
  assert.equal(app.ctx.confirmedBatches.length, 1);
});

test('quota recovery retries the current draft after removing only the disposable cache', () => {
  const app = runtime({stored: {[keys.CONFIRMED_KEY]: 'history'}, cacheFillsStorage: true});
  assert.equal(app.ctx.writeOrderEntryLocal(keys.STORAGE_KEY, 'new draft'), true);
  assert.equal(app.stored.get(keys.STORAGE_KEY), 'new draft');
  assert.deepEqual(app.removed, [keys.CONFIRMED_KEY]);
  assert.equal(app.failures(), 0);
  assert.equal(app.node('local-storage-warning').hidden, true);
});

test('persistent quota preserves latest draft in memory and honestly warns instead of throwing', () => {
  const app = runtime({full: true, stored: {[keys.STORAGE_KEY]: 'old disk draft'}});
  assert.doesNotThrow(() => app.ctx.saveLocal());
  assert.equal(app.stored.get(keys.STORAGE_KEY), 'old disk draft');
  const draft = JSON.parse(app.ctx.readOrderEntryLocal(keys.STORAGE_KEY));
  assert.equal(draft.orders[0].productName, 'Product');
  assert.equal(draft.customerCode, '03-007');
  assert.equal(app.node('local-storage-warning').hidden, false);
  assert.match(app.node('save-state').textContent, /画面内/);
  assert.doesNotMatch(app.node('save-state').textContent, /保存済み/);
  app.ctx.orders = [];
  app.ctx.loadLocal();
  assert.equal(app.ctx.orders[0].productName, 'Product');
});

test('unavailable storage retains DB masters and dictionaries for current-screen lookups', () => {
  const app = runtime({blocked: true});
  assert.doesNotThrow(() => app.ctx.saveMastersObject({products: [{code: '073', name: 'Product'}]}));
  assert.equal(app.ctx.savedMastersObject().products[0].code, '073');
  app.ctx.saveLocalLineDictionary([{expression: 'Product'}]);
  assert.equal(app.ctx.loadLocalLineDictionary()[0].expression, 'Product');
  assert.doesNotThrow(() => app.ctx.saveConfirmedBatches());
});

test('import drafts remain available when native persistence fails', () => {
  const app = runtime({full: true});
  app.ctx.importDraftGroups = [{id: 'draft', rows: [{productName: 'Product'}]}];
  app.ctx.saveImportDrafts();
  app.ctx.importDraftGroups = [];
  app.ctx.loadImportDrafts();
  assert.equal(app.ctx.importDraftGroups[0].rows[0].productName, 'Product');
});

test('writes recover normally without masking another tab master updates', () => {
  const app = runtime({full: true});
  app.ctx.writeOrderEntryLocal(keys.STORAGE_KEY, 'first');
  app.state.full = false;
  assert.equal(app.ctx.writeOrderEntryLocal(keys.STORAGE_KEY, 'second'), true);
  assert.equal(app.failures(), 0);
  app.stored.set(keys.STORAGE_KEY, 'third from another tab');
  assert.equal(app.ctx.readOrderEntryLocal(keys.STORAGE_KEY), 'third from another tab');
  assert.equal(app.node('local-storage-warning').hidden, true);
});

test('confirmed DB read remains complete and connected under persistent local quota', async () => {
  const batches = Array.from({length: 1800}, (_, i) => ({id: `batch-${i}`}));
  const app = runtime({full: true, batches});
  app.ctx.dbReady = false;
  await app.ctx.loadDbData();
  assert.equal(app.ctx.dbReady, true);
  assert.equal(app.node('db-state').textContent, 'DB接続中');
  assert.equal(app.ctx.confirmedBatches.length, 1800);
  assert.equal(app.stored.has(keys.CONFIRMED_KEY), false);
  assert.equal(app.ctx.savedMastersObject().products[0].code, '073');
});

test('real DB read failure is not converted to a successful connection', async () => {
  const app = runtime({full: true});
  app.state.failDb = true;
  await app.ctx.loadDbData();
  assert.equal(app.ctx.dbReady, false);
  assert.equal(await app.ctx.confirmCustomerOrder(), false);
  assert.equal(app.database.size, 0);
  assert.equal(app.ctx.orders[0].productName, 'Product');
});

test('manual confirmation succeeds once even when all browser writes are rejected', async () => {
  const app = runtime({full: true});
  assert.equal(await app.ctx.confirmCustomerOrder(), true);
  assert.equal(app.database.size, 1);
  assert.equal(app.ctx.confirmedBatches.length, 1);
  assert.equal(app.ctx.confirmedBatches[0].rows.length, 1);
  assert.equal(app.ctx.orders[0].productName, '');
  assert.equal(app.node('batch-customer-code').value, '');
  assert.equal(app.state.busy, false);
  assert.match(app.alerts[0], /受注確定しました/);
  await app.ctx.confirmCustomerOrder();
  assert.equal(app.database.size, 1);
  assert.ok(!app.written.includes(keys.CONFIRMED_KEY));
});

test('failed DB confirmation preserves input and the same retry ID rather than clearing drafts', async () => {
  const app = runtime({full: true});
  app.state.failDb = true;
  assert.equal(await app.ctx.confirmCustomerOrder(), false);
  const id = app.ctx.currentOrderAttemptId;
  assert.ok(id);
  assert.equal(app.ctx.orders[0].productName, 'Product');
  assert.equal(app.node('batch-customer-code').value, '03-007');
  assert.equal(app.ctx.confirmedBatches.length, 0);
  assert.equal(app.state.busy, false);
  app.state.failDb = false;
  assert.equal(await app.ctx.confirmCustomerOrder(), true);
  assert.equal(app.database.size, 1);
  assert.ok(app.database.has(id));
});

test('resume after an older DB-saved/local-cache-failed attempt reuses persisted attempt ID', async () => {
  const id = '00000000-0000-4000-8000-000000009999';
  const draft = {orderDate: '2026-11-19', customerCode: '03-007', customerName: 'Customer',
    importerCode: '03', importerName: 'BKK', currentOrderAttemptId: id,
    orders: [{productName: 'Product', qty: 3}]};
  const app = runtime({stored: {[keys.STORAGE_KEY]: JSON.stringify(draft)}});
  app.ctx.isOrderRowBlank = row => !row.productName;
  app.ctx.today = () => '2026-11-19';
  app.ctx.loadConfirmedBatches();
  app.ctx.loadLocal();
  app.database.set(id, {id, rows: draft.orders});
  assert.equal(await app.ctx.confirmCustomerOrder(), true);
  assert.equal(app.database.size, 1);
  assert.ok(app.database.has(id));
});

test('bulk PDF/CSV/LINE confirmation also survives post-DB local save failures', async () => {
  const app = runtime({full: true});
  vm.runInContext(section('async function saveImportedBatchesToDbAtomically(',
    'function removeImportReviewRowsByIndexes('), app.ctx);
  app.ctx.deleteConfirmedBatchIds = async () => assert.fail('Storage errors must never roll back DB orders');
  app.ctx.clearConfirmedFilters = () => {};
  const batches = [{id: 'import-a', rows: [{productName: 'A'}]}, {id: 'import-b', rows: [{productName: 'B'}]}];
  await app.ctx.persistImportedConfirmedBatches(batches);
  assert.equal(app.database.size, 2);
  assert.equal(app.ctx.confirmedBatches.length, 2);
  assert.ok(!app.written.includes(keys.CONFIRMED_KEY));
});

test('beforeunload warns about memory-only inputs even when there is no import review', () => {
  const app = runtime({full: true});
  const event = {preventDefault() {this.prevented = true;}};
  app.ctx.saveLocal();
  app.events.beforeunload(event);
  assert.equal(event.prevented, true);
  assert.equal(event.returnValue, '');
});

test('all native local storage access stays inside the three guarded helpers; every script compiles', () => {
  const outsideHelpers = html.replace(section('const orderEntryMemoryStorage=', 'const baseMasters='), '');
  assert.doesNotMatch(outsideHelpers, /localStorage\.(?:setItem|getItem|removeItem|clear)\(/);
  assert.match(html, /id="local-storage-warning" role="alert" hidden/);
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (match[2].trim() && !/application\/json/.test(match[1])) new vm.Script(match[2]);
  }
});
