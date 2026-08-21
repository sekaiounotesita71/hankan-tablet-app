-- Site, external partner work and purchase management foundation.
-- Run this file once in Supabase SQL Editor after the existing migrations.

begin;

create extension if not exists pgcrypto;

create table if not exists public.site_master (
  site_code text primary key,
  site_name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.site_master (site_code, site_name)
values ('OSA', '大阪'), ('TYO', '東京')
on conflict (site_code) do update
set site_name = excluded.site_name,
    is_active = true,
    updated_at = now();

alter table public.customer_master
  add column if not exists site_code text;

update public.customer_master
set site_code = 'OSA'
where site_code is null or btrim(site_code) = '';

alter table public.customer_master
  alter column site_code set default 'OSA',
  alter column site_code set not null;

alter table public.supplier_master
  add column if not exists external_work_enabled boolean not null default false,
  add column if not exists box_prefix text,
  add column if not exists default_site_code text;

update public.supplier_master
set default_site_code = 'OSA'
where default_site_code is null or btrim(default_site_code) = '';

alter table public.order_entry_batches
  add column if not exists site_code text;

update public.order_entry_batches batch
set site_code = coalesce(
  (select customer.site_code
     from public.customer_master customer
    where customer.customer_code = batch.customer_code
    limit 1),
  'OSA'
)
where batch.site_code is null or btrim(batch.site_code) = '';

alter table public.order_entry_batches
  alter column site_code set default 'OSA',
  alter column site_code set not null;

alter table public.work_sessions
  add column if not exists site_code text;

update public.work_sessions
set site_code = 'OSA'
where site_code is null or btrim(site_code) = '';

alter table public.work_sessions
  alter column site_code set default 'OSA',
  alter column site_code set not null;

alter table public.order_lines
  add column if not exists source_order_line_id uuid;

do $$
begin
  if to_regclass('public.sales_records') is not null then
    alter table public.sales_records add column if not exists site_code text;
    update public.sales_records set site_code = 'OSA' where site_code is null or btrim(site_code) = '';
    alter table public.sales_records alter column site_code set default 'OSA';
  end if;
  if to_regclass('public.accounts_receivable') is not null then
    alter table public.accounts_receivable add column if not exists site_code text;
    update public.accounts_receivable set site_code = 'OSA' where site_code is null or btrim(site_code) = '';
    alter table public.accounts_receivable alter column site_code set default 'OSA';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'customer_master_site_code_fkey') then
    alter table public.customer_master
      add constraint customer_master_site_code_fkey foreign key (site_code) references public.site_master(site_code);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'supplier_master_default_site_code_fkey') then
    alter table public.supplier_master
      add constraint supplier_master_default_site_code_fkey foreign key (default_site_code) references public.site_master(site_code);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'order_entry_batches_site_code_fkey') then
    alter table public.order_entry_batches
      add constraint order_entry_batches_site_code_fkey foreign key (site_code) references public.site_master(site_code);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'work_sessions_site_code_fkey') then
    alter table public.work_sessions
      add constraint work_sessions_site_code_fkey foreign key (site_code) references public.site_master(site_code);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'order_lines_source_order_line_id_fkey') then
    alter table public.order_lines
      add constraint order_lines_source_order_line_id_fkey foreign key (source_order_line_id) references public.order_entry_lines(id) on delete set null;
  end if;
end $$;

create index if not exists idx_customer_master_site on public.customer_master(site_code, customer_code);
create index if not exists idx_order_entry_batches_site_date on public.order_entry_batches(site_code, order_date desc);
create index if not exists idx_work_sessions_site_date on public.work_sessions(site_code, work_date desc);
create unique index if not exists idx_order_lines_source_order_line
  on public.order_lines(session_id, source_order_line_id)
  where source_order_line_id is not null;

create table if not exists public.internal_user_access (
  user_id uuid primary key references auth.users(id) on delete cascade,
  site_codes text[] not null default array['OSA','TYO']::text[],
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Everyone who can use the app before this migration remains an internal user.
insert into public.internal_user_access (user_id, site_codes, active)
select id, array['OSA','TYO']::text[], true
from auth.users
on conflict (user_id) do nothing;

create table if not exists public.partner_user_access (
  user_id uuid not null references auth.users(id) on delete cascade,
  supplier_code text not null references public.supplier_master(supplier_code) on delete cascade,
  site_codes text[] not null default array['OSA','TYO']::text[],
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, supplier_code)
);

create or replace function public.is_internal_user()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(public.is_master_admin(), false)
    or exists (
      select 1
      from public.internal_user_access access
      where access.user_id = auth.uid()
        and access.active
    );
$$;

create or replace function public.is_partner_for_supplier(p_supplier_code text, p_site_code text default null)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.partner_user_access access
    where access.user_id = auth.uid()
      and access.active
      and access.supplier_code = p_supplier_code
      and (p_site_code is null or p_site_code = any(access.site_codes))
  );
$$;

revoke all on function public.is_internal_user() from public;
revoke all on function public.is_partner_for_supplier(text,text) from public;
grant execute on function public.is_internal_user() to authenticated;
grant execute on function public.is_partner_for_supplier(text,text) to authenticated;

create table if not exists public.external_work_assignments (
  id uuid primary key default gen_random_uuid(),
  work_date date not null,
  site_code text not null references public.site_master(site_code),
  supplier_code text not null references public.supplier_master(supplier_code),
  supplier_name_snapshot text,
  box_prefix_snapshot text,
  status text not null default 'draft' check (status in ('draft','published','in_progress','submitted','accepted','returned','cancelled')),
  note text,
  published_at timestamptz,
  published_by uuid references auth.users(id),
  submitted_at timestamptz,
  submitted_by uuid references auth.users(id),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id),
  review_note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (work_date, site_code, supplier_code)
);

create table if not exists public.external_work_assignment_lines (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.external_work_assignments(id) on delete cascade,
  order_line_id uuid unique references public.order_entry_lines(id) on delete set null,
  order_batch_id uuid references public.order_entry_batches(id) on delete set null,
  line_no integer,
  importer_code text,
  importer_name text,
  customer_code text,
  customer_name text not null,
  product_code text,
  product_name text not null,
  ordered_qty numeric,
  ordered_unit text,
  order_note text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.external_work_inputs (
  assignment_line_id uuid primary key references public.external_work_assignment_lines(id) on delete cascade,
  input_qty numeric check (input_qty is null or input_qty >= 0),
  input_unit text check (input_unit is null or input_unit in ('Kg','pkt','PC','CS')),
  net_weight numeric check (net_weight is null or net_weight >= 0),
  origin text,
  box_sequence text,
  gross_weight numeric check (gross_weight is null or gross_weight >= 0),
  dry_ice_enabled boolean not null default false,
  dry_ice_weight numeric check (dry_ice_weight is null or dry_ice_weight >= 0),
  box_size text,
  memo text,
  purchase_unit_price numeric check (purchase_unit_price is null or purchase_unit_price >= 0),
  purchase_price_unit text check (purchase_price_unit is null or purchase_price_unit in ('Kg','pkt','PC','CS')),
  is_stockout boolean not null default false,
  completed boolean not null default false,
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_external_assignments_supplier_date
  on public.external_work_assignments(supplier_code, site_code, work_date desc);
create index if not exists idx_external_assignment_lines_assignment
  on public.external_work_assignment_lines(assignment_id, active, customer_name, line_no);

create table if not exists public.purchase_receipts (
  id uuid primary key default gen_random_uuid(),
  receipt_type text not null default 'order' check (receipt_type in ('order','advance')),
  status text not null default 'expected' check (status in ('expected','invoice_received','confirmed','cancelled')),
  source_assignment_id uuid unique references public.external_work_assignments(id) on delete set null,
  site_code text not null references public.site_master(site_code),
  supplier_code text not null references public.supplier_master(supplier_code),
  supplier_name_snapshot text,
  purchase_date date not null,
  supplier_invoice_no text,
  invoice_date date,
  subtotal numeric not null default 0,
  shipping_fee numeric not null default 0,
  other_fee numeric not null default 0,
  tax_amount numeric not null default 0,
  total_amount numeric not null default 0,
  note text,
  confirmed_at timestamptz,
  confirmed_by uuid references auth.users(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.purchase_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.purchase_receipts(id) on delete cascade,
  source_assignment_line_id uuid unique references public.external_work_assignment_lines(id) on delete set null,
  product_code text,
  product_name text not null,
  origin text,
  actual_qty numeric,
  actual_unit text,
  unit_price numeric,
  price_unit text,
  line_amount numeric not null default 0,
  track_inventory boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.inventory_lots (
  id uuid primary key default gen_random_uuid(),
  purchase_line_id uuid unique references public.purchase_receipt_lines(id) on delete set null,
  site_code text not null references public.site_master(site_code),
  supplier_code text references public.supplier_master(supplier_code),
  product_code text,
  product_name text not null,
  origin text,
  received_date date not null,
  received_qty numeric not null default 0,
  available_qty numeric not null default 0,
  unit text,
  unit_cost numeric,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.inventory_allocations (
  id uuid primary key default gen_random_uuid(),
  inventory_lot_id uuid not null references public.inventory_lots(id) on delete cascade,
  allocation_type text not null default 'export' check (allocation_type in ('export','domestic','adjustment')),
  source_reference text,
  allocated_date date not null,
  allocated_qty numeric not null check (allocated_qty > 0),
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_purchase_receipts_supplier_date
  on public.purchase_receipts(supplier_code, purchase_date desc);
create index if not exists idx_inventory_lots_available
  on public.inventory_lots(site_code, product_code, available_qty)
  where available_qty > 0;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'site_master','internal_user_access','partner_user_access',
    'external_work_assignments','external_work_assignment_lines','external_work_inputs',
    'purchase_receipts','purchase_receipt_lines','inventory_lots'
  ]
  loop
    execute format('drop trigger if exists trg_%I_touch on public.%I', table_name, table_name);
    execute format('create trigger trg_%I_touch before update on public.%I for each row execute function public.touch_updated_at()', table_name, table_name);
  end loop;
end $$;

create or replace function public.admin_register_partner_user(
  p_email text,
  p_supplier_code text,
  p_site_codes text[] default array['OSA','TYO']::text[]
)
returns uuid
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  target_user_id uuid;
begin
  if not public.is_master_admin() then
    raise exception 'Administrator access is required.';
  end if;
  select id into target_user_id
  from auth.users
  where lower(email) = lower(btrim(p_email))
  limit 1;
  if target_user_id is null then
    raise exception 'Create this user in Supabase Authentication first: %', p_email;
  end if;
  if target_user_id = auth.uid() then
    raise exception 'The current administrator account cannot be converted to a partner account.';
  end if;
  if exists (
    select 1 from public.user_roles
    where user_id = target_user_id and role = 'admin'
  ) then
    raise exception 'Remove the administrator role before converting this account to a partner account.';
  end if;
  delete from public.internal_user_access where user_id = target_user_id;
  insert into public.partner_user_access (user_id, supplier_code, site_codes, active)
  values (target_user_id, p_supplier_code, coalesce(p_site_codes, array['OSA','TYO']::text[]), true)
  on conflict (user_id, supplier_code) do update
  set site_codes = excluded.site_codes,
      active = true,
      updated_at = now();
  return target_user_id;
end;
$$;

create or replace function public.publish_external_work_assignment(
  p_work_date date,
  p_site_code text,
  p_supplier_code text,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_assignment_id uuid;
  supplier_row public.supplier_master;
  assignment_status text;
  source_count integer;
begin
  if not public.is_internal_user() then
    raise exception 'Internal access is required.';
  end if;
  select * into supplier_row from public.supplier_master where supplier_code = p_supplier_code and is_active;
  if supplier_row.supplier_code is null then raise exception 'Supplier not found: %', p_supplier_code; end if;
  if not supplier_row.external_work_enabled then raise exception 'External work is disabled for supplier: %', p_supplier_code; end if;

  select count(*) into source_count
  from public.order_entry_lines line
  join public.order_entry_batches batch on batch.id = line.batch_id
  where batch.status = 'confirmed'
    and batch.order_date = p_work_date
    and batch.site_code = p_site_code
    and line.supplier_code = p_supplier_code;
  if source_count = 0 then raise exception 'No confirmed order lines match the selected conditions.'; end if;

  insert into public.external_work_assignments (
    work_date, site_code, supplier_code, supplier_name_snapshot, box_prefix_snapshot,
    status, note, published_at, published_by, created_by
  ) values (
    p_work_date, p_site_code, p_supplier_code, supplier_row.supplier_name, supplier_row.box_prefix,
    'published', p_note, now(), auth.uid(), auth.uid()
  )
  on conflict (work_date, site_code, supplier_code) do update
  set supplier_name_snapshot = excluded.supplier_name_snapshot,
      box_prefix_snapshot = excluded.box_prefix_snapshot,
      note = excluded.note,
      published_at = now(),
      published_by = auth.uid(),
      status = case
        when external_work_assignments.status in ('submitted','accepted') then external_work_assignments.status
        else 'published'
      end,
      updated_at = now()
  returning id, status into v_assignment_id, assignment_status;

  if assignment_status in ('submitted','accepted') then
    raise exception 'This assignment is already submitted or accepted. Return it before publishing again.';
  end if;

  insert into public.external_work_assignment_lines (
    assignment_id, order_line_id, order_batch_id, line_no,
    importer_code, importer_name, customer_code, customer_name,
    product_code, product_name, ordered_qty, ordered_unit, order_note, active
  )
  select v_assignment_id, line.id, batch.id, line.line_no,
         batch.importer_code, batch.importer_name_snapshot, batch.customer_code,
         coalesce(batch.customer_name_snapshot, batch.customer_code, 'UNKNOWN'),
         line.product_code, line.product_name_snapshot, line.order_qty, line.order_unit,
         line.purchase_note, true
  from public.order_entry_lines line
  join public.order_entry_batches batch on batch.id = line.batch_id
  where batch.status = 'confirmed'
    and batch.order_date = p_work_date
    and batch.site_code = p_site_code
    and line.supplier_code = p_supplier_code
  on conflict (order_line_id) do update
  set assignment_id = excluded.assignment_id,
      order_batch_id = excluded.order_batch_id,
      line_no = excluded.line_no,
      importer_code = excluded.importer_code,
      importer_name = excluded.importer_name,
      customer_code = excluded.customer_code,
      customer_name = excluded.customer_name,
      product_code = excluded.product_code,
      product_name = excluded.product_name,
      ordered_qty = excluded.ordered_qty,
      ordered_unit = excluded.ordered_unit,
      order_note = excluded.order_note,
      active = true,
      updated_at = now();

  if assignment_status not in ('submitted','accepted') then
    update public.external_work_assignment_lines target
    set active = false, updated_at = now()
    where target.assignment_id = v_assignment_id
      and target.order_line_id is not null
      and not exists (
        select 1
        from public.order_entry_lines line
        join public.order_entry_batches batch on batch.id = line.batch_id
        where line.id = target.order_line_id
          and batch.status = 'confirmed'
          and batch.order_date = p_work_date
          and batch.site_code = p_site_code
          and line.supplier_code = p_supplier_code
      );
  end if;
  return v_assignment_id;
end;
$$;

create or replace function public.save_partner_work_input(
  p_assignment_line_id uuid,
  p_input_qty numeric,
  p_input_unit text,
  p_net_weight numeric,
  p_origin text,
  p_box_sequence text,
  p_gross_weight numeric,
  p_dry_ice_enabled boolean,
  p_dry_ice_weight numeric,
  p_box_size text,
  p_memo text,
  p_purchase_unit_price numeric,
  p_purchase_price_unit text,
  p_is_stockout boolean,
  p_completed boolean,
  p_expected_updated_at timestamptz default null
)
returns public.external_work_inputs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  assignment_row public.external_work_assignments;
  existing_input public.external_work_inputs;
  saved_row public.external_work_inputs;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_assignment_line_id::text, 0));

  select assignment.* into assignment_row
  from public.external_work_assignment_lines line
  join public.external_work_assignments assignment on assignment.id = line.assignment_id
  where line.id = p_assignment_line_id and line.active;
  if assignment_row.id is null then raise exception 'Assignment line not found.'; end if;
  if not public.is_partner_for_supplier(assignment_row.supplier_code, assignment_row.site_code) then
    raise exception 'This assignment is not available to the current user.';
  end if;
  if assignment_row.status not in ('published','in_progress','returned') then
    raise exception 'This assignment is locked.';
  end if;

  select * into existing_input
  from public.external_work_inputs
  where assignment_line_id = p_assignment_line_id;
  if existing_input.assignment_line_id is not null then
    if p_expected_updated_at is null then
      raise exception 'Another user updated this line. Reload the assignment before saving.';
    end if;
    if p_expected_updated_at is not null and existing_input.updated_at is distinct from p_expected_updated_at then
      raise exception 'Another user updated this line. Reload the assignment before saving.';
    end if;
  end if;

  insert into public.external_work_inputs (
    assignment_line_id, input_qty, input_unit, net_weight, origin, box_sequence,
    gross_weight, dry_ice_enabled, dry_ice_weight, box_size, memo,
    purchase_unit_price, purchase_price_unit, is_stockout, completed, updated_by
  ) values (
    p_assignment_line_id, p_input_qty, p_input_unit, p_net_weight, nullif(btrim(p_origin),''), nullif(btrim(p_box_sequence),''),
    p_gross_weight, coalesce(p_dry_ice_enabled,false), p_dry_ice_weight, nullif(btrim(p_box_size),''), nullif(btrim(p_memo),''),
    p_purchase_unit_price, nullif(btrim(p_purchase_price_unit),''), coalesce(p_is_stockout,false), coalesce(p_completed,false), auth.uid()
  )
  on conflict (assignment_line_id) do update
  set input_qty = excluded.input_qty,
      input_unit = excluded.input_unit,
      net_weight = excluded.net_weight,
      origin = excluded.origin,
      box_sequence = excluded.box_sequence,
      gross_weight = excluded.gross_weight,
      dry_ice_enabled = excluded.dry_ice_enabled,
      dry_ice_weight = excluded.dry_ice_weight,
      box_size = excluded.box_size,
      memo = excluded.memo,
      purchase_unit_price = excluded.purchase_unit_price,
      purchase_price_unit = excluded.purchase_price_unit,
      is_stockout = excluded.is_stockout,
      completed = excluded.completed,
      updated_by = auth.uid(),
      updated_at = now()
  returning * into saved_row;

  update public.external_work_assignments
  set status = 'in_progress', updated_at = now()
  where id = assignment_row.id and status in ('published','returned');
  return saved_row;
end;
$$;

create or replace function public.submit_partner_work_assignment(p_assignment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  assignment_row public.external_work_assignments;
  incomplete_count integer;
  v_receipt_id uuid;
begin
  select * into assignment_row from public.external_work_assignments where id = p_assignment_id;
  if assignment_row.id is null then raise exception 'Assignment not found.'; end if;
  if not public.is_partner_for_supplier(assignment_row.supplier_code, assignment_row.site_code) then
    raise exception 'This assignment is not available to the current user.';
  end if;
  if assignment_row.status not in ('published','in_progress','returned') then raise exception 'This assignment is locked.'; end if;

  select count(*) into incomplete_count
  from public.external_work_assignment_lines line
  left join public.external_work_inputs input on input.assignment_line_id = line.id
  where line.assignment_id = p_assignment_id
    and line.active
    and (
      coalesce(input.completed,false) = false
      or (
        coalesce(input.is_stockout,false) = false
        and (
          input.input_qty is null or input.input_qty <= 0
          or input.input_unit is null
          or input.net_weight is null or input.net_weight <= 0
          or nullif(btrim(input.origin),'') is null
          or nullif(btrim(input.box_sequence),'') is null
          or input.gross_weight is null or input.gross_weight <= 0
          or nullif(btrim(input.box_size),'') is null
          or input.purchase_unit_price is null
          or input.purchase_price_unit is null
          or (input.dry_ice_enabled and (input.dry_ice_weight is null or input.dry_ice_weight <= 0))
        )
      )
    );
  if incomplete_count > 0 then
    raise exception '% line(s) are incomplete or missing required values.', incomplete_count;
  end if;

  update public.external_work_assignments
  set status = 'submitted', submitted_at = now(), submitted_by = auth.uid(), updated_at = now()
  where id = p_assignment_id;

  insert into public.purchase_receipts (
    receipt_type, status, source_assignment_id, site_code, supplier_code,
    supplier_name_snapshot, purchase_date, created_by
  ) values (
    'order', 'expected', p_assignment_id, assignment_row.site_code, assignment_row.supplier_code,
    assignment_row.supplier_name_snapshot, assignment_row.work_date, auth.uid()
  )
  on conflict (source_assignment_id) do update
  set site_code = excluded.site_code,
      supplier_code = excluded.supplier_code,
      supplier_name_snapshot = excluded.supplier_name_snapshot,
      purchase_date = excluded.purchase_date,
      updated_at = now()
  returning id into v_receipt_id;

  insert into public.purchase_receipt_lines (
    receipt_id, source_assignment_line_id, product_code, product_name, origin,
    actual_qty, actual_unit, unit_price, price_unit, line_amount, track_inventory, note
  )
  select v_receipt_id, line.id, line.product_code, line.product_name, input.origin,
         case when input.is_stockout then 0 else input.input_qty end,
         input.input_unit, input.purchase_unit_price, input.purchase_price_unit,
         case
           when input.is_stockout then 0
           else coalesce(input.input_qty,0) * coalesce(input.purchase_unit_price,0)
         end,
         false, input.memo
  from public.external_work_assignment_lines line
  join public.external_work_inputs input on input.assignment_line_id = line.id
  where line.assignment_id = p_assignment_id and line.active
  on conflict (source_assignment_line_id) do update
  set receipt_id = excluded.receipt_id,
      product_code = excluded.product_code,
      product_name = excluded.product_name,
      origin = excluded.origin,
      actual_qty = excluded.actual_qty,
      actual_unit = excluded.actual_unit,
      unit_price = excluded.unit_price,
      price_unit = excluded.price_unit,
      line_amount = excluded.line_amount,
      note = excluded.note,
      updated_at = now();

  update public.purchase_receipts receipt
  set subtotal = totals.subtotal,
      total_amount = totals.subtotal + receipt.shipping_fee + receipt.other_fee + receipt.tax_amount,
      updated_at = now()
  from (
    select coalesce(sum(line_amount),0) subtotal
    from public.purchase_receipt_lines
    where receipt_id = v_receipt_id
  ) totals
  where receipt.id = v_receipt_id;
  return v_receipt_id;
end;
$$;

create or replace function public.review_external_work_assignment(
  p_assignment_id uuid,
  p_action text,
  p_note text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  next_status text;
  assignment_row public.external_work_assignments;
begin
  if not public.is_internal_user() then raise exception 'Internal access is required.'; end if;
  if p_action = 'accept' then next_status := 'accepted';
  elsif p_action = 'return' then next_status := 'returned';
  else raise exception 'Action must be accept or return.';
  end if;
  update public.external_work_assignments
  set status = next_status,
      reviewed_at = now(),
      reviewed_by = auth.uid(),
      review_note = p_note,
      updated_at = now()
  where id = p_assignment_id
    and status in ('submitted','accepted','returned')
  returning * into assignment_row;
  if assignment_row.id is null then raise exception 'Assignment cannot be reviewed in its current state.'; end if;

  if next_status = 'accepted' then
    update public.order_lines target
    set input_qty = case when input.is_stockout then 0 else input.input_qty end,
        input_unit = input.input_unit,
        net_weight = case when input.is_stockout then 0 else input.net_weight end,
        origin = coalesce(input.origin, target.origin),
        box_no = case
          when input.is_stockout or input.box_sequence is null then null
          else concat_ws('-', nullif(assignment_row.box_prefix_snapshot,''), input.box_sequence)
        end,
        memo = concat_ws(' / ', nullif(target.memo,''), nullif(input.memo,'')),
        is_stockout = input.is_stockout,
        updated_by = auth.uid(),
        updated_at = now()
    from public.external_work_assignment_lines line
    join public.external_work_inputs input on input.assignment_line_id = line.id
    cross join public.work_sessions session
    where line.assignment_id = assignment_row.id
      and line.active
      and target.source_order_line_id = line.order_line_id
      and session.id = target.session_id
      and session.work_date = assignment_row.work_date
      and session.site_code = assignment_row.site_code
      and session.status = 'active'
      and coalesce(session.locked,false) = false
      and coalesce(session.provisional_locked,false) = false;

    insert into public.boxes (
      session_id, importer_code, box_no, gross_weight, dry_ice_enabled,
      dry_ice_weight, box_size, updated_by
    )
    select session.id, line.importer_code,
           concat_ws('-', nullif(assignment_row.box_prefix_snapshot,''), input.box_sequence),
           max(input.gross_weight), bool_or(input.dry_ice_enabled), max(input.dry_ice_weight),
           max(input.box_size), auth.uid()
    from public.external_work_assignment_lines line
    join public.external_work_inputs input on input.assignment_line_id = line.id
    join public.work_sessions session
      on session.work_date = assignment_row.work_date
     and session.site_code = assignment_row.site_code
     and session.status = 'active'
     and coalesce(session.locked,false) = false
     and coalesce(session.provisional_locked,false) = false
    where line.assignment_id = assignment_row.id
      and line.active
      and input.is_stockout = false
      and input.box_sequence is not null
      and line.importer_code is not null
    group by session.id, line.importer_code, input.box_sequence
    on conflict (session_id, importer_code, box_no) do update
    set gross_weight = excluded.gross_weight,
        dry_ice_enabled = excluded.dry_ice_enabled,
        dry_ice_weight = excluded.dry_ice_weight,
        box_size = excluded.box_size,
        updated_by = auth.uid(),
        updated_at = now();
  end if;
  return next_status;
end;
$$;

create or replace function public.confirm_purchase_receipt(p_receipt_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  receipt_row public.purchase_receipts;
begin
  if not public.is_internal_user() then raise exception 'Internal access is required.'; end if;
  select * into receipt_row from public.purchase_receipts where id = p_receipt_id;
  if receipt_row.id is null then raise exception 'Purchase receipt not found.'; end if;
  if receipt_row.supplier_invoice_no is null or btrim(receipt_row.supplier_invoice_no) = '' then
    raise exception 'Supplier invoice number is required.';
  end if;

  update public.purchase_receipts
  set status = 'confirmed',
      subtotal = totals.subtotal,
      total_amount = totals.subtotal + shipping_fee + other_fee + tax_amount,
      confirmed_at = now(),
      confirmed_by = auth.uid(),
      updated_at = now()
  from (
    select coalesce(sum(line_amount),0) subtotal
    from public.purchase_receipt_lines
    where receipt_id = p_receipt_id
  ) totals
  where id = p_receipt_id;

  insert into public.inventory_lots (
    purchase_line_id, site_code, supplier_code, product_code, product_name, origin,
    received_date, received_qty, available_qty, unit, unit_cost, note
  )
  select line.id, receipt_row.site_code, receipt_row.supplier_code, line.product_code,
         line.product_name, line.origin, receipt_row.purchase_date,
         coalesce(line.actual_qty,0), coalesce(line.actual_qty,0), line.actual_unit,
         line.unit_price, line.note
  from public.purchase_receipt_lines line
  where line.receipt_id = p_receipt_id and line.track_inventory and coalesce(line.actual_qty,0) > 0
  on conflict (purchase_line_id) do update
  set received_qty = excluded.received_qty,
      available_qty = excluded.available_qty,
      unit_cost = excluded.unit_cost,
      origin = excluded.origin,
      updated_at = now();
  return p_receipt_id;
end;
$$;

create or replace function public.create_advance_purchase(
  p_purchase_date date,
  p_site_code text,
  p_supplier_code text,
  p_product_code text,
  p_product_name text,
  p_origin text,
  p_actual_qty numeric,
  p_actual_unit text,
  p_unit_price numeric,
  p_price_unit text,
  p_supplier_invoice_no text default null,
  p_track_inventory boolean default true,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_receipt_id uuid;
  v_supplier_name text;
  v_subtotal numeric;
begin
  if not public.is_internal_user() then raise exception 'Internal access is required.'; end if;
  select supplier_name into v_supplier_name
  from public.supplier_master
  where supplier_code = p_supplier_code and is_active;
  if v_supplier_name is null then raise exception 'Supplier not found: %', p_supplier_code; end if;
  if coalesce(btrim(p_product_name),'') = '' then raise exception 'Product name is required.'; end if;
  v_subtotal := coalesce(p_actual_qty,0) * coalesce(p_unit_price,0);
  insert into public.purchase_receipts (
    receipt_type, status, site_code, supplier_code, supplier_name_snapshot,
    purchase_date, supplier_invoice_no, invoice_date, subtotal, total_amount, note, created_by
  ) values (
    'advance',
    case when coalesce(btrim(p_supplier_invoice_no),'') = '' then 'expected' else 'invoice_received' end,
    p_site_code, p_supplier_code, v_supplier_name,
    p_purchase_date, nullif(btrim(p_supplier_invoice_no),''),
    case when coalesce(btrim(p_supplier_invoice_no),'') = '' then null else p_purchase_date end,
    v_subtotal, v_subtotal, nullif(btrim(p_note),''), auth.uid()
  ) returning id into v_receipt_id;

  insert into public.purchase_receipt_lines (
    receipt_id, product_code, product_name, origin, actual_qty, actual_unit,
    unit_price, price_unit, line_amount, track_inventory, note
  ) values (
    v_receipt_id, nullif(btrim(p_product_code),''), p_product_name, nullif(btrim(p_origin),''),
    p_actual_qty, p_actual_unit, p_unit_price, p_price_unit, v_subtotal,
    coalesce(p_track_inventory,true), nullif(btrim(p_note),'')
  );
  return v_receipt_id;
end;
$$;

revoke all on function public.admin_register_partner_user(text,text,text[]) from public;
revoke all on function public.publish_external_work_assignment(date,text,text,text) from public;
revoke all on function public.save_partner_work_input(uuid,numeric,text,numeric,text,text,numeric,boolean,numeric,text,text,numeric,text,boolean,boolean,timestamptz) from public;
revoke all on function public.submit_partner_work_assignment(uuid) from public;
revoke all on function public.review_external_work_assignment(uuid,text,text) from public;
revoke all on function public.confirm_purchase_receipt(uuid) from public;
revoke all on function public.create_advance_purchase(date,text,text,text,text,text,numeric,text,numeric,text,text,boolean,text) from public;

grant execute on function public.admin_register_partner_user(text,text,text[]) to authenticated;
grant execute on function public.publish_external_work_assignment(date,text,text,text) to authenticated;
grant execute on function public.save_partner_work_input(uuid,numeric,text,numeric,text,text,numeric,boolean,numeric,text,text,numeric,text,boolean,boolean,timestamptz) to authenticated;
grant execute on function public.submit_partner_work_assignment(uuid) to authenticated;
grant execute on function public.review_external_work_assignment(uuid,text,text) to authenticated;
grant execute on function public.confirm_purchase_receipt(uuid) to authenticated;
grant execute on function public.create_advance_purchase(date,text,text,text,text,text,numeric,text,numeric,text,text,boolean,text) to authenticated;

alter table public.site_master enable row level security;
alter table public.internal_user_access enable row level security;
alter table public.partner_user_access enable row level security;
alter table public.external_work_assignments enable row level security;
alter table public.external_work_assignment_lines enable row level security;
alter table public.external_work_inputs enable row level security;
alter table public.purchase_receipts enable row level security;
alter table public.purchase_receipt_lines enable row level security;
alter table public.inventory_lots enable row level security;
alter table public.inventory_allocations enable row level security;

drop policy if exists "authenticated read sites" on public.site_master;
create policy "authenticated read sites" on public.site_master for select to authenticated using (true);
drop policy if exists "admins manage sites" on public.site_master;
create policy "admins manage sites" on public.site_master for all to authenticated using (public.is_master_admin()) with check (public.is_master_admin());

drop policy if exists "users read own internal access" on public.internal_user_access;
create policy "users read own internal access" on public.internal_user_access for select to authenticated using (user_id = auth.uid() or public.is_master_admin());
drop policy if exists "admins manage internal access" on public.internal_user_access;
create policy "admins manage internal access" on public.internal_user_access for all to authenticated using (public.is_master_admin()) with check (public.is_master_admin());

drop policy if exists "partners read own access" on public.partner_user_access;
create policy "partners read own access" on public.partner_user_access for select to authenticated using (user_id = auth.uid() or public.is_master_admin());
drop policy if exists "admins manage partner access" on public.partner_user_access;
create policy "admins manage partner access" on public.partner_user_access for all to authenticated using (public.is_master_admin()) with check (public.is_master_admin());

drop policy if exists "internal manage assignments" on public.external_work_assignments;
create policy "internal manage assignments" on public.external_work_assignments for all to authenticated using (public.is_internal_user()) with check (public.is_internal_user());
drop policy if exists "partners read assignments" on public.external_work_assignments;
create policy "partners read assignments" on public.external_work_assignments for select to authenticated using (public.is_partner_for_supplier(supplier_code,site_code) and status <> 'draft' and status <> 'cancelled');

drop policy if exists "internal manage assignment lines" on public.external_work_assignment_lines;
create policy "internal manage assignment lines" on public.external_work_assignment_lines for all to authenticated using (public.is_internal_user()) with check (public.is_internal_user());
drop policy if exists "partners read assignment lines" on public.external_work_assignment_lines;
create policy "partners read assignment lines" on public.external_work_assignment_lines for select to authenticated using (
  exists (
    select 1 from public.external_work_assignments assignment
    where assignment.id = assignment_id
      and public.is_partner_for_supplier(assignment.supplier_code,assignment.site_code)
      and assignment.status not in ('draft','cancelled')
  )
);

drop policy if exists "internal manage partner inputs" on public.external_work_inputs;
create policy "internal manage partner inputs" on public.external_work_inputs for all to authenticated using (public.is_internal_user()) with check (public.is_internal_user());
drop policy if exists "partners read own inputs" on public.external_work_inputs;
create policy "partners read own inputs" on public.external_work_inputs for select to authenticated using (
  exists (
    select 1
    from public.external_work_assignment_lines line
    join public.external_work_assignments assignment on assignment.id = line.assignment_id
    where line.id = assignment_line_id
      and public.is_partner_for_supplier(assignment.supplier_code,assignment.site_code)
  )
);

drop policy if exists "internal manage purchase receipts" on public.purchase_receipts;
create policy "internal manage purchase receipts" on public.purchase_receipts for all to authenticated using (public.is_internal_user()) with check (public.is_internal_user());
drop policy if exists "internal manage purchase lines" on public.purchase_receipt_lines;
create policy "internal manage purchase lines" on public.purchase_receipt_lines for all to authenticated using (public.is_internal_user()) with check (public.is_internal_user());
drop policy if exists "internal manage inventory lots" on public.inventory_lots;
create policy "internal manage inventory lots" on public.inventory_lots for all to authenticated using (public.is_internal_user()) with check (public.is_internal_user());
drop policy if exists "internal manage inventory allocations" on public.inventory_allocations;
create policy "internal manage inventory allocations" on public.inventory_allocations for all to authenticated using (public.is_internal_user()) with check (public.is_internal_user());

-- Existing policies are permissive. A restrictive internal guard prevents partner accounts
-- from querying the rest of the business database while preserving existing staff access.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'work_sessions','order_lines','boxes','product_master','product_price_contracts','product_supplier_prices',
    'customer_master','supplier_master','importer_master','order_entry_batches','order_entry_lines',
    'sales_records','historical_sales_records','pending_entries','user_roles','master_change_log',
    'accounts_receivable','accounts_receivable_payments','accounts_receivable_statement_profiles',
    'accounts_receivable_statements','accounts_receivable_closings','sales_correction_log',
    'product_guide_templates','product_guide_variants','product_guide_template_rows'
  ]
  loop
    if to_regclass('public.' || table_name) is not null then
      execute format('alter table public.%I enable row level security', table_name);
      execute format('drop policy if exists internal_access_guard on public.%I', table_name);
      execute format(
        'create policy internal_access_guard on public.%I as restrictive for all to authenticated using (public.is_internal_user()) with check (public.is_internal_user())',
        table_name
      );
    end if;
  end loop;
end $$;

grant select on public.site_master to authenticated;
grant select on public.internal_user_access, public.partner_user_access to authenticated;
grant select on public.external_work_assignments, public.external_work_assignment_lines, public.external_work_inputs to authenticated;
grant select, insert, update, delete on public.purchase_receipts, public.purchase_receipt_lines, public.inventory_lots, public.inventory_allocations to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.external_work_assignments;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.external_work_inputs;
exception when duplicate_object then null;
end $$;

commit;
