const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const migration = fs.readFileSync(path.join(__dirname, "..", "agency-sales-migration.sql"), "utf8");
let PGlite;
try { ({ PGlite } = require(process.env.PGLITE_PATH || "@electric-sql/pglite")); }
catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }

test("read-only RPC isolates 07, excludes reopened or draft sales, and paginates saved amounts", { skip: !PGlite }, async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table work_sessions (id int, work_date date, site_code text, locked boolean not null,
        finalized_importer_codes text[] not null, reopened_importer_codes text[] not null, shipping_fees jsonb,
        shipping_fee numeric default 4444);
      create table sales_records (id int, session_id int, work_date date, site_code text, importer_code text,
        revenue_recognition_mode text, is_stockout boolean not null default false, store_name text default 'Customer',
        product_id text, product_name text, input_qty numeric default 2, input_unit text default 'PC',
        unit_price numeric default 40, amount numeric, memo text default 'Internal note', origin text);
      create table historical_sales_records (id int, finalized_at timestamptz, importer_code text,
        is_stockout boolean not null default false, store_name text, product_id text, product_name text, input_qty numeric,
        input_unit text, unit_price numeric, amount numeric);
      create table domestic_sales (id int, source_session_id int, sale_date date, status text, source_type text,
        source_importer_code text, customer_name_snapshot text default 'Domestic client');
      create table domestic_sale_lines (id int, sale_id int, product_code text, product_name_snapshot text, quantity numeric default 2,
        unit text, unit_price_jpy numeric, net_amount_jpy numeric);
      create table pending_entries (id int, importer_code text, status text, applied_invoice_no text, entry_type text,
        customer_name_snapshot text, product_code text, product_name_snapshot text, qty numeric, unit text, unit_price numeric,
        amount numeric, planned_date date, entry_date date, applied_work_date date, memo text default 'Hidden');
      grant select on all tables in schema public to service_role;

      insert into work_sessions (id,work_date,site_code,locked,finalized_importer_codes,reopened_importer_codes,shipping_fees) values
        (1,'2026-11-20','OSA',false,'{07}','{}','{"07":9,"01":7777}'),
        (2,'2026-11-20','TYO',false,'{01}','{07}','{"07":8888}'),
        (3,'2026-11-21','TYO',true,'{}','{}','{}'),
        (4,'2026-11-21','TYO',true,'{}','{}','{"07":"unknown"}');
      insert into sales_records (id,session_id,importer_code,product_name,amount,revenue_recognition_mode,is_stockout) values
        (1,1,'07','Export',81,'direct_export',false),
        (2,1,'01','Other07',7777,'direct_export',false),
        (3,2,'07','Reopened',8888,'direct_export',false),
        (4,1,'07','Customs',9111,'customs_only',false),
        (5,1,'07','Stockout',9777,'direct_export',true),
        (6,3,'07','Amount not entered',null,'direct_export',false),
        (7,3,'070','Similar code',9777,'direct_export',false),
        (8,4,'07','Additional',20,'direct_export',false);
      update sales_records set product_id='007A' where id in (1,2);
      insert into historical_sales_records (id,finalized_at,importer_code,product_name,amount) values
        (1,'2026-10-31T15:00Z','07','Historical',11),
        (2,'2026-11-01T00:00Z','01','Other historical',9711),
        (3,'2026-11-30T15:00Z','07','December',9712);
      insert into domestic_sales (id,source_session_id,sale_date,status,source_type,source_importer_code) values
        (1,1,'2026-11-20','confirmed','export_intermediary','07'),
        (2,1,'2026-11-20','draft','export_intermediary','07'),
        (3,1,'2026-11-20','confirmed','export_intermediary','01'),
        (4,2,'2026-11-20','confirmed','export_intermediary','07'),
        (5,1,'2026-11-20','confirmed','manual','07');
      insert into domestic_sale_lines (id,sale_id,product_name_snapshot,net_amount_jpy) values
        (1,1,'Domestic',54),(2,2,'Draft',8888),(3,3,'Other domestic',8888),
        (4,4,'Reopened domestic',8888),(5,5,'Manual domestic',8888);
      insert into pending_entries (id,importer_code,status,applied_invoice_no,entry_type,amount,entry_date,applied_work_date) values
        (1,'07','applied','INV-07','credit_note',7,'2026-10-25','2026-11-20'),
        (2,'07','applied','INV-07','shipping_adjustment',-1,'2026-11-21',null),
        (3,'07','pending','INV-07','extra_charge',9999,'2026-11-21',null),
        (4,'01','applied','INV-01','extra_charge',9999,'2026-11-21',null);
    `);
    await db.exec(migration);
    await db.exec(migration);
    async function read(page = 1, product = "", customer = "", site = "") {
      return (await db.query("select agency_sales_07('2026-11-01','2026-11-30',$1,$2,$3,$4) as result", [page, product, customer, site])).rows[0].result;
    }
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(() => read(), /permission denied for function/);
      await db.exec("reset role");
    }
    await db.exec("set role service_role");
    const result = await read();
    assert.equal(result.count, 8);
    assert.equal(result.netSales, 159);
    assert.equal(result.freight, 8);
    assert.equal(result.missingAmountCount, 1);
    assert.equal(result.rows.find(row => row.product_name === "Export").amount, 81);
    assert.equal(result.rows.find(row => row.product_name === "Historical").sale_date, "2026-11-01");
    assert.deepEqual(result.rows.map(row => row.product_name).filter(Boolean).sort(),
      ["Additional", "Amount not entered", "Domestic", "Export", "Historical"]);
    assert.ok(result.rows.every(row => !("memo" in row) && !("importer_code" in row) && !("applied_invoice_no" in row)));
    assert.equal((await read(2)).rows.length, 0);
    const productSearch = await read(1, "07a", "cusTomer", "OSA");
    assert.equal(productSearch.count, 1);
    assert.equal(productSearch.rows[0].product_code, "007A");
    assert.equal(productSearch.netSales, 81);
    assert.equal(productSearch.freight, 0);
    assert.equal((await read(1, "export", "", "TYO")).count, 0);
    assert.equal((await read(1, "%")).count, 0);
    assert.equal((await read(1, "", "", "OSA")).freight, 9);
    await assert.rejects(() => db.query("select agency_sales_07('2026-11-30','2026-11-01',1)"), /Invalid sales period/);
    await db.exec("reset role");
    await db.exec(`insert into sales_records (id,session_id,importer_code,product_name,amount)
      select i,1,'07','Page row ' || i,1 from generate_series(10,119) i`);
    const first = await read(1), second = await read(2);
    assert.equal(first.rows.length, 100);
    assert.equal(second.rows.length, 18);
    assert.equal(first.count, second.count);
    assert.equal(first.netSales, second.netSales);
    assert.equal((await read(1, "page row 119")).count, 1);
    assert.ok(!second.rows.some(row => row.product_name?.startsWith("Page row ") &&
      first.rows.some(firstRow => firstRow.product_name === row.product_name)));
  } finally {
    await db.close();
  }
});
