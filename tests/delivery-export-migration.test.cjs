const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Source-contract tests only: these do not execute SQL or validate live RLS.
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'delivery-export-migration.sql'), 'utf8');
const sql = source.replace(/--[^\r\n]*/g, '');
function functionBody(name) {
  const match = sql.match(new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?as \\$\\$([\\s\\S]*?)\\$\\$;`, 'i'
  ));
  assert.ok(match, `Function ${name} exists`);
  return match[1];
}
const copy = functionBody('copy_delivery_external_order_no');
const save = functionBody('save_domestic_delivery_metadata');
const tables = ['order_entry_lines', 'order_lines', 'sales_records', 'domestic_sale_lines'];
const metadata = ['external_order_no', 'delivery_carton_no', 'delivery_spec', 'delivery_customer_name'];

test('migration is transactional and adds only the scoped text, revision and saved-flag columns', () => {
  assert.match(sql, /^\s*begin;/i);
  assert.match(sql, /notify pgrst, 'reload schema';\s*commit;\s*$/i);
  const alters = [...sql.matchAll(/alter table public\.(\w+)\s+([\s\S]*?);/gi)];
  assert.deepEqual([...new Set(alters.map(match => match[1]))].sort(), [...tables].sort());
  const columns = [];
  for (const [, table, body] of alters) {
    for (const match of body.matchAll(/add column if not exists (\w+) ([^,;]+)/gi)) {
      columns.push(`${table}.${match[1]}`);
      if (!['delivery_export_revision', 'delivery_metadata_saved'].includes(match[1])) {
        assert.equal(match[2].trim(), 'text');
      }
    }
  }
  assert.deepEqual(columns.sort(), [
    ...tables.map(table => `${table}.external_order_no`),
    ...metadata.slice(1).map(field => `domestic_sale_lines.${field}`),
    'domestic_sale_lines.delivery_export_revision',
    'domestic_sale_lines.delivery_metadata_saved'
  ].sort());
  assert.match(sql, /delivery_export_revision integer not null default 0/i);
  assert.match(sql, /delivery_metadata_saved boolean not null default false/i);
  assert.doesNotMatch(sql, /\b(?:drop column|truncate|delete from|insert into)\b/i);
});

test('rerunnable constraints bound text and nonnegative revisions without rewriting data', () => {
  for (const table of tables) assert.ok(sql.includes(`'${table}'`));
  assert.match(sql, /conname = constraint_name\s+and conrelid = format\('public\.%I', target_table\)::regclass/);
  assert.match(sql, /check \(char_length\(external_order_no\) <= 120\)/);
  assert.match(sql, /char_length\(delivery_carton_no\) <= 120/);
  assert.match(sql, /char_length\(delivery_spec\) <= 300/);
  assert.match(sql, /char_length\(delivery_customer_name\) <= 300/);
  assert.match(sql, /delivery_export_revision is not null\s+and delivery_export_revision >= 0/);
  assert.match(sql, /conname = 'domestic_sale_lines_delivery_metadata_check'\s+and conrelid = 'public\.domestic_sale_lines'::regclass/);
  assert.doesNotMatch(sql, /\b(?:not valid|disable trigger|disable row level security)\b/i);
});

test('external order numbers copy in one direction on INSERT only and preserve explicit values', () => {
  const triggers = [...sql.matchAll(/create trigger (\w+)\s+([\s\S]*?);/gi)];
  assert.equal(triggers.length, 3);
  assert.deepEqual(triggers.map(match => match[2].match(/on public\.(\w+)/)[1]).sort(), tables.slice(1).sort());
  for (const [, name, body] of triggers) {
    assert.equal(name, 'trg_delivery_external_order_no');
    assert.match(body, /^before insert on public\./);
    assert.match(body, /for each row when \(new\.external_order_no is null\)/);
    assert.match(body, /execute function public\.copy_delivery_external_order_no\(\)/);
    assert.doesNotMatch(body, /\b(?:update|delete)\b/i);
  }
  assert.match(copy, /if new\.external_order_no is not null then\s+return new;/);
  assert.match(copy, /tg_table_name = 'order_lines'[\s\S]*from public\.order_entry_lines source\s+where source\.id = new\.source_order_line_id/);
  assert.match(copy, /tg_table_name = 'sales_records'[\s\S]*from public\.order_lines source\s+where source\.session_id = new\.session_id\s+and source\.source_row_no = new\.source_row_no/);
  assert.match(copy, /tg_table_name = 'domestic_sale_lines'[\s\S]*from public\.sales_records source\s+where source\.id = new\.source_sales_record_id/);
  assert.match(copy, /tg_table_name = 'domestic_sale_lines' then\s+if new\.delivery_metadata_saved then\s+return new;\s+end if;\s+select source\.external_order_no/);
  assert.doesNotMatch(copy, /delivery_export_revision/);
  assert.equal((copy.match(/into new\.external_order_no/g) || []).length, 3);
  assert.doesNotMatch(copy, /\b(?:update|insert|delete|execute)\b/i);
});

test('RPC uses narrowly granted definer rights with a trusted search path and fail-closed internal checks', () => {
  assert.match(sql, /save_domestic_delivery_metadata\(\s*p_sale_id uuid,\s*p_lines jsonb\s*\)\s*returns jsonb\s*language plpgsql\s*security definer\s*set search_path = pg_catalog, pg_temp/i);
  assert.match(save, /auth\.uid\(\) is null or not coalesce\(public\.is_internal_user\(\), false\)/);
  assert.match(save, /using errcode = '42501'/);
  assert.match(sql, /revoke all on function public\.save_domestic_delivery_metadata\(uuid, jsonb\)\s+from public, anon, authenticated;/i);
  assert.match(sql, /grant execute on function public\.save_domestic_delivery_metadata\(uuid, jsonb\)\s+to authenticated;/i);
  assert.match(sql, /copy_delivery_external_order_no\(\)\s*returns trigger\s*language plpgsql\s*security invoker/i);
  assert.match(sql, /revoke all on function public\.copy_delivery_external_order_no\(\)\s+from public, anon, authenticated;/i);
  assert.doesNotMatch(sql, /grant\s+(?:all|update|insert|delete)\b|create policy|alter policy/i);
  assert.ok(save.indexOf('public.is_internal_user()') < save.indexOf('jsonb_array_elements(p_lines)'));
});

test('RPC rejects nonarrays, zero or oversized batches, malformed objects and extra fields', () => {
  assert.match(save, /p_lines is null or jsonb_typeof\(p_lines\) is distinct from 'array'/);
  assert.match(save, /requested_count := jsonb_array_length\(p_lines\)/);
  assert.match(save, /requested_count < 1 or requested_count > 5000/);
  assert.match(save, /jsonb_typeof\(line_item\) is distinct from 'object'/);
  const allowed = save.match(/where key not in \(([\s\S]*?)\)/);
  assert.ok(allowed);
  assert.deepEqual([...allowed[1].matchAll(/'([^']+)'/g)].map(match => match[1]).sort(),
    ['id', 'expected_revision', ...metadata].sort());
  assert.match(save, /jsonb_object_keys\(line_item\)/);
  assert.ok(save.indexOf('jsonb_typeof(line_item)') < save.indexOf('jsonb_object_keys(line_item)'));
  assert.match(save, /jsonb_typeof\(line_item -> 'id'\) is distinct from 'string'/);
  assert.match(save, /parsed_id := \(line_item ->> 'id'\)::uuid/);
  assert.match(save, /exception when invalid_text_representation then\s+raise exception/);
});

test('RPC validates numeric revisions, overflow, JSON text types and raw character limits', () => {
  assert.match(save, /jsonb_typeof\(line_item -> 'expected_revision'\) is distinct from 'number'/);
  assert.ok(save.includes("!~ '^(0|[1-9][0-9]{0,9})$'"));
  assert.match(save, /\(line_item ->> 'expected_revision'\)::bigint > 2147483646/);
  for (const [field, limit] of [['external_order_no', 120], ['delivery_carton_no', 120], ['delivery_spec', 300], ['delivery_customer_name', 300]]) {
    assert.ok(save.includes(`('${field}', ${limit})`));
  }
  assert.match(save, /jsonb_typeof\(line_item -> field_rule\.field_name\) not in \('string', 'null'\)/);
  assert.match(save, /char_length\(line_item ->> field_rule\.field_name\) > field_rule\.max_chars/);
  assert.doesNotMatch(save, /\b(?:left|substring|substr)\s*\(/i);
});

test('parent and deterministic child locks precede full-sale membership and revision checks', () => {
  const parent = save.indexOf('select s.status into sale_status');
  const children = save.indexOf('perform l.id from public.domestic_sale_lines l');
  const membership = save.indexOf('if actual_count <> requested_count');
  const revisions = save.indexOf('where l.delivery_export_revision is distinct from supplied.expected_revision');
  const update = save.indexOf('update public.domestic_sale_lines l');
  assert.ok(parent >= 0 && parent < children && children < membership && membership < revisions && revisions < update);
  assert.match(save, /from public\.domestic_sales s\s+where s\.id = p_sale_id\s+for update;/);
  assert.match(save, /if not found then[\s\S]*?errcode = 'P0002'/);
  assert.match(save, /sale_status is distinct from 'confirmed'/);
  assert.match(save, /perform l\.id from public\.domestic_sale_lines l\s+where l\.sale_id = p_sale_id\s+order by l\.id\s+for update;/);
  assert.match(save, /count\(distinct \(value ->> 'id'\)::uuid\)[\s\S]*?<> requested_count/);
  assert.match(save, /if actual_count <> requested_count or exists \([\s\S]*?where not exists \([\s\S]*?where l\.sale_id = p_sale_id and l\.id = \(supplied\.item ->> 'id'\)::uuid/);
  assert.match(save, /jsonb_to_recordset\(p_lines\) as supplied\(id uuid, expected_revision integer\)/);
  assert.match(save, /l\.delivery_export_revision is distinct from supplied\.expected_revision[\s\S]*?errcode = '40001'/);
});

test('the only data update changes metadata and increments revisions atomically, never financials', () => {
  const updates = [...sql.matchAll(/\bupdate public\.(\w+)\s+(\w+)\s+set\s+([\s\S]*?)\s+from jsonb_array_elements/gi)];
  assert.equal(updates.length, 1);
  assert.equal(updates[0][1], 'domestic_sale_lines');
  assert.equal((sql.match(/\bupdate public\./gi) || []).length, 1);
  const assignments = [...updates[0][3].matchAll(/(?:^|,)\s*(\w+)\s*=/g)].map(match => match[1]);
  assert.deepEqual(assignments.sort(), [...metadata, 'delivery_export_revision', 'delivery_metadata_saved'].sort());
  for (const field of metadata) {
    assert.ok(updates[0][3].includes(`case when supplied.item ? '${field}'`));
    assert.ok(updates[0][3].includes(`then nullif(btrim(supplied.item ->> '${field}'), '') else l.${field} end`));
  }
  assert.match(save, /delivery_export_revision = l\.delivery_export_revision \+ 1/);
  assert.match(save, /delivery_metadata_saved = true/);
  assert.match(save, /where l\.sale_id = p_sale_id\s+and l\.id = \(supplied\.item ->> 'id'\)::uuid\s+and l\.delivery_export_revision = \(supplied\.item ->> 'expected_revision'\)::integer/);
  assert.match(save, /with saved as \(\s+update public\.domestic_sale_lines/);
  assert.match(save, /into saved_count, saved_lines\s+from saved/);
  assert.match(save, /if saved_count <> requested_count then\s+raise exception[\s\S]*?errcode = '40001'/);
  assert.doesNotMatch(save, /exception when (?:others|serialization_failure)|\b(?:commit|rollback)\b/i);
});

test('RPC returns fresh line metadata, revisions and timestamps in stable line order', () => {
  for (const field of ['id', ...metadata, 'delivery_export_revision', 'delivery_metadata_saved', 'updated_at']) {
    assert.ok(save.includes(`'${field}', ${field}`));
  }
  assert.match(save, /order by line_no, id/);
  assert.match(save, /return jsonb_build_object\('sale_id', p_sale_id, 'lines', saved_lines\)/);
});

test('metadata path leaves existing financial guards and domestic touch/audit behavior intact', () => {
  const domestic = fs.readFileSync(path.join(root, 'domestic-sales-migration.sql'), 'utf8');
  assert.match(domestic, /create trigger trg_domestic_sale_lines_touch\s+before update on public\.domestic_sale_lines/);
  assert.match(domestic, /new\.updated_at := now\(\)/);
  assert.match(domestic, /grant select on public\.domestic_sales, public\.domestic_sale_lines/);
  assert.doesNotMatch(save, /public\.(?:work_sessions|order_lines|sales_records|domestic_receivables|domestic_receivable_payments|domestic_billing_closings|accounts_receivable)\b/);
  assert.doesNotMatch(save, /is_master_admin|domestic_sale_has_closed_billing|set_config\s*\(/);
  assert.doesNotMatch(sql, /(?:drop|alter) trigger (?!if exists trg_delivery_external_order_no)|session_replication_role/i);
  assert.deepEqual([...sql.matchAll(/create or replace function public\.(\w+)/gi)].map(match => match[1]),
    ['copy_delivery_external_order_no', 'save_domestic_delivery_metadata']);
  assert.match(source, /Apply delivery-export-correction-migration\.sql/);
  assert.match(source, /A revision bump alone must never be used to infer this flag/);
});
