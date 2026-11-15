const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'order-entry-beta.html'), 'utf8');
function section(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} -> ${end}`);
  return html.slice(from, to);
}
function fixture(sales = [], error = null) {
  const calls = [];
  const number = value => value === null || value === undefined || value === ''
    ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const ctx = {
    salesRefNum: value => Number(value) || 0,
    salesRefMoney: String,
    esc: String,
    dbNumber: number,
    purchasePriceUnit: value => value || 'Kg',
    normalizeLineUnit: value => value || '',
    salesRefDetailFilterActive: () => false,
    salesRefVisibleShippingFeeForRows: () => 0,
    salesRefGrossTotal: () => 0,
    salesRefQuantityByUnit: () => [],
    supabaseClient: {
      from(table) {
        assert.equal(table, 'sales_records');
        return {
          select(columns) { calls.push({ select: columns }); return this; },
          gte(field, value) { calls.push({ gte: [field, value] }); return this; },
          lte(field, value) { calls.push({ lte: [field, value] }); return this; },
          order() { return this; },
          async range(from, to) {
            calls.push({ range: [from, to] });
            return error ? { error } : { data: sales.slice(from, to + 1), error: null };
          }
        };
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(section('function salesRefCostQuantity', 'async function salesRefReadChunks'), ctx);
  vm.runInContext(section('function salesRefMetrics', 'function salesRefUnpricedProductTable'), ctx);
  vm.runInContext(section('async function readSalesForAdvancePurchase', 'function advancePurchaseSaleSourceKey'), ctx);
  return { ctx, calls };
}

test('only explicit numeric zero sales are excluded', () => {
  const { ctx } = fixture();
  for (const amount of [0, -0, '0', '0.00', ' 0 ']) {
    assert.equal(ctx.salesRefIsZeroAmount({ amount }), true, String(amount));
  }
  for (const amount of [null, undefined, '', ' ', false, true, [], {}, 'invalid', NaN, Infinity, 1, -1, 0.01, -0.01]) {
    assert.equal(ctx.salesRefIsZeroAmount({ amount }), false, String(amount));
  }
  assert.equal(ctx.salesRefIsZeroAmount(undefined), false);
});

test('unlinked zero sales do not require an invented purchase or master cost', () => {
  const { ctx } = fixture();
  const row = { amount: 0, input_qty: 3, product_id: '073', _purchaseCostReason: 'unlinked' };
  const cost = ctx.salesRefCostInfo(row);
  assert.equal(cost.priced, true);
  assert.equal(cost.amount, 0);
  assert.equal(cost.source, 'zero_sales');
  assert.equal(row._purchaseCostReason, 'unlinked');
});

test('missing sale prices remain unpriced, including a null amount with zero unit price', () => {
  const { ctx } = fixture();
  for (const amount of [null, undefined, '', ' ', 'invalid']) {
    assert.equal(ctx.salesRefCostInfo({ amount, input_qty: 2, unit_price: 0 }).priced, false);
  }
  assert.equal(ctx.salesRefCostInfo({ amount: -100 }).priced, false);
});

test('existing linked costs on zero sales remain included in gross profit', () => {
  const { ctx } = fixture();
  for (const amount of [700, 0, -25]) {
    const row = { amount: 0, _purchaseCostSource: 'linked', _purchaseCostActual: amount };
    assert.equal(ctx.salesRefCostInfo(row).amount, amount);
    assert.equal(ctx.salesRefCostInfo(row).source, 'linked');
    const metrics = ctx.salesRefMetrics([row]);
    assert.equal(metrics.purchaseCost, amount);
    assert.equal(metrics.grossProfit, amount === 0 ? 0 : -amount);
    assert.equal(metrics.zeroSalesCount, 0);
    assert.equal(metrics.linkedCostCount, 1);
  }
});

test('stockouts and adjustments keep their existing classifications', () => {
  const { ctx } = fixture();
  for (const extra of [{ is_stockout: true }, { pending_entry_id: 'credit' }, { source_type: '未処理伝票' }]) {
    assert.equal(ctx.salesRefCostInfo({ amount: 0, ...extra }).source, 'adjustment');
  }
});

test('zero-sales heads do not block otherwise complete product and customer groups', () => {
  const { ctx } = fixture();
  const rows = [
    { product_id: '073', store_name: 'Customer', amount: 1000, _purchaseCostSource: 'linked', _purchaseCostActual: 600 },
    { product_id: '073', store_name: 'Customer', amount: 0, product_name: 'Head' }
  ];
  for (const key of [row => row.product_id, row => row.store_name]) {
    const groups = ctx.salesRefProfitGroups(rows, key);
    assert.equal(groups[0].unpriced, 0);
    assert.equal(groups[0].sales, 1000);
    assert.equal(groups[0].cost, 600);
    assert.equal(groups[0].profit, 400);
    assert.doesNotMatch(ctx.salesRefProfitTable('Profit', groups), /算出不可/);
  }
  assert.equal(ctx.salesRefUnpricedProductGroups(rows).length, 0);
});

test('zero exclusions reduce missing counts without changing sales or existing purchase totals', () => {
  const { ctx } = fixture();
  const rows = [
    ...Array.from({ length: 47 }, (_, i) => ({ id: `linked-${i}`, amount: 100, _purchaseCostSource: 'linked', _purchaseCostActual: 70 })),
    ...Array.from({ length: 38 }, (_, i) => ({ id: `unlinked-${i}`, amount: 50 })),
    ...Array.from({ length: 14 }, (_, i) => ({ id: `head-${i}`, amount: 0 })),
    { id: 'stockout', amount: 0, is_stockout: true }
  ];
  const original = JSON.stringify(rows);
  const metrics = ctx.salesRefMetrics(rows);
  assert.equal(metrics.count, 100);
  assert.equal(metrics.netSales, 6600);
  assert.equal(metrics.purchaseCost, 3290);
  assert.equal(metrics.costedSales, 4700);
  assert.equal(metrics.grossProfit, 1410);
  assert.equal(metrics.unpricedCount, 38);
  assert.equal(metrics.unpricedSales, 1900);
  assert.equal(metrics.zeroSalesCount, 14);
  assert.equal(metrics.linkedCostCount, 47);
  assert.equal(metrics.adjustmentCount, 1);
  assert.equal(JSON.stringify(rows), original);
});

test('daily and monthly purchase reads omit zero sales before supplier review and grouping', async () => {
  const sales = [
    { id: 'head', amount: 0, input_qty: 1 },
    { id: 'paid', amount: 100, input_qty: 2 },
    { id: 'missing-price', amount: null, input_qty: 3 },
    { id: 'credit', amount: -100, input_qty: 4 }
  ];
  for (const [from, to] of [['2026-11-09', '2026-11-09'], ['2026-11-01', '2026-11-30']]) {
    const { ctx, calls } = fixture(sales);
    const original = JSON.stringify(sales);
    const result = await ctx.readSalesForAdvancePurchase(from, to);
    assert.deepEqual(Array.from(result, row => row.id), ['paid', 'missing-price', 'credit']);
    assert.ok(calls[0].select.split(',').includes('amount'));
    assert.deepEqual(calls.find(call => call.gte).gte, ['work_date', from]);
    assert.deepEqual(calls.find(call => call.lte).lte, ['work_date', to]);
    assert.equal(JSON.stringify(sales), original);
  }
});

test('a full page of zero sales does not truncate later nonzero sales', async () => {
  const sales = [...Array.from({ length: 1000 }, (_, i) => ({ id: `head-${i}`, amount: 0 })), { id: 'next-page', amount: 100 }];
  const { ctx, calls } = fixture(sales);
  const result = await ctx.readSalesForAdvancePurchase('2026-11-01', '2026-11-30');
  assert.deepEqual(Array.from(result, row => row.id), ['next-page']);
  assert.equal(calls.filter(call => call.range).length, 2);
});

test('purchase read failures remain visible and are not converted into an empty list', async () => {
  const error = new Error('DB failed');
  const { ctx } = fixture([], error);
  await assert.rejects(ctx.readSalesForAdvancePurchase('2026-11-09'), value => value === error);
});

test('both product and detail modes use the same filtered purchase reader', () => {
  const source = section('async function importSalesIntoAdvancePurchase', 'function updateAdvancePurchaseSummary');
  assert.match(source, /const salesRows=await readSalesForAdvancePurchase\(referenceRange\.from,referenceRange\.to\)/);
  assert.match(source, /const unassigned=salesRows\.filter/);
  assert.match(source, /salesRows\.forEach/);
  assert.match(source, /advancePurchaseImportMode==="product"/);
  const cost = section('function salesRefIsZeroAmount', 'async function salesRefReadChunks');
  assert.doesNotMatch(cost, /\.update\(|\.delete\(|\.insert\(|\.upsert\(|\.rpc\(/);
});
