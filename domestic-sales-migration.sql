-- Domestic sales, receivables, payments, and customer master.
-- Run after order-entry-beta-migration.sql and site-partner-purchase-migration.sql.

begin;

create extension if not exists pgcrypto;

create sequence if not exists public.domestic_sale_no_seq start with 1;

create table if not exists public.domestic_customer_master (
  customer_code text primary key,
  customer_name text not null,
  aliases text[] not null default '{}',
  postal_code text,
  address_text text,
  phone text,
  email text,
  closing_day smallint not null default 31 check (closing_day between 1 and 31),
  payment_month_offset smallint not null default 1 check (payment_month_offset between 0 and 12),
  payment_day smallint not null default 31 check (payment_day between 1 and 31),
  memo text,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (btrim(customer_code) <> ''),
  check (btrim(customer_name) <> '')
);

create table if not exists public.domestic_sales (
  id uuid primary key default gen_random_uuid(),
  sale_no text not null unique,
  sale_date date not null,
  customer_code text not null references public.domestic_customer_master(customer_code) on delete restrict,
  customer_name_snapshot text not null,
  status text not null default 'confirmed' check (status in ('confirmed','cancelled')),
  product_subtotal_8_jpy numeric(18,2) not null default 0,
  product_subtotal_10_jpy numeric(18,2) not null default 0,
  shipping_amount_jpy numeric(18,2) not null default 0 check (shipping_amount_jpy >= 0),
  total_net_jpy numeric(18,2) not null default 0,
  tax_8_jpy numeric(18,2) not null default 0,
  tax_10_jpy numeric(18,2) not null default 0,
  tax_total_jpy numeric(18,2) not null default 0,
  total_amount_jpy numeric(18,2) not null default 0,
  memo text,
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamptz not null default now(),
  cancelled_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.domestic_sale_lines (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.domestic_sales(id) on delete cascade,
  line_no integer not null check (line_no > 0),
  product_code text references public.product_master(product_id) on delete set null,
  product_name_snapshot text not null,
  quantity numeric(18,4) not null check (quantity > 0),
  unit text not null default 'Kg' check (unit in ('Kg','pkt','PC','CS')),
  unit_price_jpy numeric(18,4) not null check (unit_price_jpy >= 0),
  tax_rate smallint not null default 8 check (tax_rate in (8,10)),
  net_amount_jpy numeric(18,2) not null check (net_amount_jpy >= 0),
  memo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sale_id, line_no)
);

create table if not exists public.domestic_receivables (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  source_type text not null default 'sale' check (source_type in ('sale','opening','adjustment')),
  sale_id uuid unique references public.domestic_sales(id) on delete restrict,
  customer_code text not null references public.domestic_customer_master(customer_code) on delete restrict,
  customer_name_snapshot text not null,
  invoice_date date not null,
  due_date date,
  amount_jpy numeric(18,2) not null check (amount_jpy >= 0),
  paid_amount_jpy numeric(18,2) not null default 0 check (paid_amount_jpy >= 0),
  balance_jpy numeric(18,2) not null default 0 check (balance_jpy >= 0),
  status text not null default 'unpaid' check (status in ('unpaid','partial','paid','cancelled')),
  memo text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.domestic_receivable_payments (
  id uuid primary key default gen_random_uuid(),
  receivable_id uuid not null references public.domestic_receivables(id) on delete restrict,
  payment_date date not null,
  amount_jpy numeric(18,2) not null check (amount_jpy > 0),
  bank_fee_jpy numeric(18,2) not null default 0 check (bank_fee_jpy >= 0),
  reference_no text,
  memo text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_domestic_customer_name
  on public.domestic_customer_master(customer_name);
create index if not exists idx_domestic_sales_date
  on public.domestic_sales(sale_date desc, customer_code);
create index if not exists idx_domestic_sales_customer
  on public.domestic_sales(customer_code, sale_date desc);
create index if not exists idx_domestic_sale_lines_product
  on public.domestic_sale_lines(product_code, sale_id);
create index if not exists idx_domestic_receivables_customer
  on public.domestic_receivables(customer_code, invoice_date desc);
create index if not exists idx_domestic_receivables_due
  on public.domestic_receivables(status, due_date);
create index if not exists idx_domestic_receivable_payments_parent
  on public.domestic_receivable_payments(receivable_id, payment_date desc);

create or replace function public.touch_domestic_record()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  if tg_table_name = 'domestic_customer_master' then
    if new.created_by is null then new.created_by := auth.uid(); end if;
    new.updated_by := auth.uid();
  elsif tg_table_name = 'domestic_receivables' then
    new.updated_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_domestic_customer_touch on public.domestic_customer_master;
create trigger trg_domestic_customer_touch
before insert or update on public.domestic_customer_master
for each row execute function public.touch_domestic_record();

drop trigger if exists trg_domestic_sales_touch on public.domestic_sales;
create trigger trg_domestic_sales_touch
before update on public.domestic_sales
for each row execute function public.touch_domestic_record();

drop trigger if exists trg_domestic_sale_lines_touch on public.domestic_sale_lines;
create trigger trg_domestic_sale_lines_touch
before update on public.domestic_sale_lines
for each row execute function public.touch_domestic_record();

drop trigger if exists trg_domestic_receivables_touch on public.domestic_receivables;
create trigger trg_domestic_receivables_touch
before update on public.domestic_receivables
for each row execute function public.touch_domestic_record();

create or replace function public.domestic_receivable_due_date(
  p_sale_date date,
  p_closing_day smallint,
  p_payment_month_offset smallint,
  p_payment_day smallint
)
returns date
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  closing_month date;
  payment_month date;
  payment_month_end date;
  target_day integer;
begin
  if p_sale_date is null then return null; end if;

  closing_month := date_trunc('month', p_sale_date)::date;
  if coalesce(p_closing_day,31) < 31
     and extract(day from p_sale_date)::integer > p_closing_day then
    closing_month := (closing_month + interval '1 month')::date;
  end if;

  payment_month := (
    closing_month
    + make_interval(months => greatest(coalesce(p_payment_month_offset,1),0)::integer)
  )::date;
  payment_month_end := (payment_month + interval '1 month - 1 day')::date;
  target_day := least(
    greatest(coalesce(p_payment_day,31),1),
    extract(day from payment_month_end)::integer
  );
  return payment_month + (target_day - 1);
end;
$$;

create or replace function public.confirm_domestic_sale(
  p_sale_date date,
  p_customer_code text,
  p_shipping_amount_jpy numeric,
  p_memo text,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  customer_row public.domestic_customer_master%rowtype;
  sale_id uuid := gen_random_uuid();
  sale_number text;
  line_item jsonb;
  line_index integer := 0;
  line_product_code text;
  line_product_name text;
  line_unit text;
  line_quantity numeric(18,4);
  line_unit_price numeric(18,4);
  line_tax_rate smallint;
  line_net numeric(18,2);
  subtotal_8 numeric(18,2) := 0;
  subtotal_10 numeric(18,2) := 0;
  shipping_net numeric(18,2) := round(greatest(coalesce(p_shipping_amount_jpy,0),0),2);
  tax_8 numeric(18,2);
  tax_10 numeric(18,2);
  total_net numeric(18,2);
  total_tax numeric(18,2);
  total_gross numeric(18,2);
  payment_due date;
begin
  if not public.is_internal_user() then
    raise exception 'Internal access is required.' using errcode = '42501';
  end if;
  if p_sale_date is null then
    raise exception '売上日を入力してください。' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_customer_code,'')),'') is null then
    raise exception '得意先を選択してください。' using errcode = '22023';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception '商品明細を1件以上入力してください。' using errcode = '22023';
  end if;

  select * into customer_row
  from public.domestic_customer_master
  where customer_code = btrim(p_customer_code)
    and active
  for share;

  if not found then
    raise exception '有効な国内得意先が見つかりません。' using errcode = '22023';
  end if;

  sale_number := 'DOM-' || to_char(p_sale_date,'YYYYMMDD') || '-'
    || lpad(nextval('public.domestic_sale_no_seq')::text,6,'0');

  perform set_config('app.audit_source','domestic-sales',true);

  insert into public.domestic_sales (
    id, sale_no, sale_date, customer_code, customer_name_snapshot,
    shipping_amount_jpy, memo, confirmed_by
  ) values (
    sale_id, sale_number, p_sale_date, customer_row.customer_code, customer_row.customer_name,
    shipping_net, nullif(btrim(coalesce(p_memo,'')),''), auth.uid()
  );

  for line_item in select value from jsonb_array_elements(p_lines)
  loop
    line_index := line_index + 1;
    line_product_code := nullif(btrim(coalesce(line_item ->> 'product_code','')),'');
    line_product_name := nullif(btrim(coalesce(line_item ->> 'product_name','')),'');
    line_unit := coalesce(nullif(btrim(line_item ->> 'unit'),''),'Kg');
    line_quantity := coalesce(nullif(line_item ->> 'quantity','')::numeric,0);
    line_unit_price := coalesce(nullif(line_item ->> 'unit_price','')::numeric,0);
    line_tax_rate := coalesce(nullif(line_item ->> 'tax_rate','')::smallint,8);

    if line_product_code is not null then
      if not exists (select 1 from public.product_master where product_id = line_product_code and is_active) then
        raise exception '商品コード % は商品マスタにありません。', line_product_code using errcode = '23503';
      end if;
      if line_product_name is null then
        select nullif(btrim(product_name),'') into line_product_name
        from public.product_master where product_id = line_product_code;
      end if;
    end if;
    if line_product_name is null then
      raise exception '%行目の商品名を入力してください。', line_index using errcode = '22023';
    end if;
    if line_quantity <= 0 then
      raise exception '%行目の数量は0より大きい値を入力してください。', line_index using errcode = '22023';
    end if;
    if line_unit_price < 0 then
      raise exception '%行目の単価は0以上で入力してください。', line_index using errcode = '22023';
    end if;
    if line_unit not in ('Kg','pkt','PC','CS') then
      raise exception '%行目の単位が正しくありません。', line_index using errcode = '22023';
    end if;
    if line_tax_rate not in (8,10) then
      raise exception '%行目の税率は8%%または10%%です。', line_index using errcode = '22023';
    end if;

    line_net := round(line_quantity * line_unit_price,0);
    if line_tax_rate = 8 then subtotal_8 := subtotal_8 + line_net;
    else subtotal_10 := subtotal_10 + line_net;
    end if;

    insert into public.domestic_sale_lines (
      sale_id, line_no, product_code, product_name_snapshot, quantity,
      unit, unit_price_jpy, tax_rate, net_amount_jpy, memo
    ) values (
      sale_id, line_index, line_product_code, line_product_name, line_quantity,
      line_unit, line_unit_price, line_tax_rate, line_net,
      nullif(btrim(coalesce(line_item ->> 'memo','')),'')
    );
  end loop;

  tax_8 := floor(subtotal_8 * 0.08);
  tax_10 := floor((subtotal_10 + shipping_net) * 0.10);
  total_net := subtotal_8 + subtotal_10 + shipping_net;
  total_tax := tax_8 + tax_10;
  total_gross := total_net + total_tax;
  payment_due := public.domestic_receivable_due_date(
    p_sale_date, customer_row.closing_day,
    customer_row.payment_month_offset, customer_row.payment_day
  );

  update public.domestic_sales
  set product_subtotal_8_jpy = subtotal_8,
      product_subtotal_10_jpy = subtotal_10,
      total_net_jpy = total_net,
      tax_8_jpy = tax_8,
      tax_10_jpy = tax_10,
      tax_total_jpy = total_tax,
      total_amount_jpy = total_gross
  where id = sale_id;

  insert into public.domestic_receivables (
    source_key, source_type, sale_id, customer_code, customer_name_snapshot,
    invoice_date, due_date, amount_jpy, balance_jpy, memo, created_by, updated_by
  ) values (
    'sale:' || sale_id::text, 'sale', sale_id, customer_row.customer_code,
    customer_row.customer_name, p_sale_date, payment_due, total_gross, total_gross,
    nullif(btrim(coalesce(p_memo,'')),''), auth.uid(), auth.uid()
  );

  return jsonb_build_object(
    'id', sale_id,
    'sale_no', sale_number,
    'total_net_jpy', total_net,
    'tax_total_jpy', total_tax,
    'total_amount_jpy', total_gross,
    'due_date', payment_due
  );
end;
$$;

create or replace function public.record_domestic_receivable_payment(
  p_receivable_id uuid,
  p_payment_date date,
  p_amount_jpy numeric,
  p_bank_fee_jpy numeric default 0,
  p_reference_no text default null,
  p_memo text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  receivable_row public.domestic_receivables%rowtype;
  payment_id uuid := gen_random_uuid();
  new_paid numeric(18,2);
  new_balance numeric(18,2);
begin
  if not public.is_internal_user() then
    raise exception 'Internal access is required.' using errcode = '42501';
  end if;
  if p_payment_date is null or coalesce(p_amount_jpy,0) <= 0 then
    raise exception '入金日と0より大きい入金額を入力してください。' using errcode = '22023';
  end if;
  if coalesce(p_bank_fee_jpy,0) < 0 then
    raise exception '手数料は0以上で入力してください。' using errcode = '22023';
  end if;

  select * into receivable_row
  from public.domestic_receivables
  where id = p_receivable_id
  for update;

  if not found then
    raise exception '売掛データが見つかりません。' using errcode = 'P0002';
  end if;
  if receivable_row.status = 'cancelled' then
    raise exception '取消済みの売掛には入金登録できません。' using errcode = '22023';
  end if;
  if p_amount_jpy > receivable_row.balance_jpy then
    raise exception '入金額が売掛残高を超えています。' using errcode = '22023';
  end if;

  perform set_config('app.audit_source','domestic-receivable-payment',true);
  insert into public.domestic_receivable_payments (
    id, receivable_id, payment_date, amount_jpy, bank_fee_jpy,
    reference_no, memo, created_by
  ) values (
    payment_id, p_receivable_id, p_payment_date, round(p_amount_jpy,2),
    round(greatest(coalesce(p_bank_fee_jpy,0),0),2),
    nullif(btrim(coalesce(p_reference_no,'')),''),
    nullif(btrim(coalesce(p_memo,'')),''), auth.uid()
  );

  new_paid := receivable_row.paid_amount_jpy + round(p_amount_jpy,2);
  new_balance := greatest(receivable_row.amount_jpy - new_paid,0);
  update public.domestic_receivables
  set paid_amount_jpy = new_paid,
      balance_jpy = new_balance,
      status = case when new_balance = 0 then 'paid' else 'partial' end,
      updated_by = auth.uid()
  where id = p_receivable_id;

  return payment_id;
end;
$$;

create or replace function public.create_domestic_opening_receivable(
  p_customer_code text,
  p_invoice_date date,
  p_due_date date,
  p_amount_jpy numeric,
  p_memo text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  customer_row public.domestic_customer_master%rowtype;
  receivable_id uuid := gen_random_uuid();
  resolved_due_date date;
begin
  if not public.is_master_admin() then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;
  if p_invoice_date is null or coalesce(p_amount_jpy,0) <= 0 then
    raise exception '基準日と0より大きい開始残高を入力してください。' using errcode = '22023';
  end if;
  select * into customer_row
  from public.domestic_customer_master
  where customer_code = btrim(coalesce(p_customer_code,'')) and active;
  if not found then
    raise exception '有効な国内得意先が見つかりません。' using errcode = '22023';
  end if;

  resolved_due_date := coalesce(p_due_date, public.domestic_receivable_due_date(
    p_invoice_date, customer_row.closing_day,
    customer_row.payment_month_offset, customer_row.payment_day
  ));
  perform set_config('app.audit_source','domestic-opening-balance',true);

  insert into public.domestic_receivables (
    id, source_key, source_type, customer_code, customer_name_snapshot,
    invoice_date, due_date, amount_jpy, balance_jpy, memo, created_by, updated_by
  ) values (
    receivable_id, 'opening:' || receivable_id::text, 'opening',
    customer_row.customer_code, customer_row.customer_name,
    p_invoice_date, resolved_due_date, round(p_amount_jpy,2), round(p_amount_jpy,2),
    nullif(btrim(coalesce(p_memo,'')),''), auth.uid(), auth.uid()
  );
  return receivable_id;
end;
$$;

create or replace function public.cancel_domestic_sale(
  p_sale_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_receivable public.domestic_receivables%rowtype;
begin
  if not public.is_master_admin() then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_reason,''))) < 3 then
    raise exception '取消理由を3文字以上入力してください。' using errcode = '22023';
  end if;

  select * into target_receivable
  from public.domestic_receivables
  where sale_id = p_sale_id
  for update;
  if not found then
    raise exception '対象の売上・売掛が見つかりません。' using errcode = 'P0002';
  end if;
  if target_receivable.paid_amount_jpy > 0 then
    raise exception '入金済みの売上は取消できません。先に入金を確認してください。' using errcode = '22023';
  end if;
  if target_receivable.status = 'cancelled' then return; end if;

  perform set_config('app.audit_source','domestic-sale-cancel',true);
  perform set_config('app.audit_reason',btrim(p_reason),true);

  update public.domestic_sales
  set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(),
      cancellation_reason = btrim(p_reason)
  where id = p_sale_id and status = 'confirmed';

  update public.domestic_receivables
  set status = 'cancelled', balance_jpy = 0, memo = concat_ws(' / ',memo,'売上取消: ' || btrim(p_reason)),
      updated_by = auth.uid()
  where id = target_receivable.id;
end;
$$;

alter table public.domestic_customer_master enable row level security;
alter table public.domestic_sales enable row level security;
alter table public.domestic_sale_lines enable row level security;
alter table public.domestic_receivables enable row level security;
alter table public.domestic_receivable_payments enable row level security;

drop policy if exists "internal users can read domestic customers" on public.domestic_customer_master;
drop policy if exists "admins can insert domestic customers" on public.domestic_customer_master;
drop policy if exists "admins can update domestic customers" on public.domestic_customer_master;
drop policy if exists "admins can delete domestic customers" on public.domestic_customer_master;
create policy "internal users can read domestic customers"
  on public.domestic_customer_master for select to authenticated using (public.is_internal_user());
create policy "admins can insert domestic customers"
  on public.domestic_customer_master for insert to authenticated with check (public.is_master_admin());
create policy "admins can update domestic customers"
  on public.domestic_customer_master for update to authenticated
  using (public.is_master_admin()) with check (public.is_master_admin());
create policy "admins can delete domestic customers"
  on public.domestic_customer_master for delete to authenticated using (public.is_master_admin());

drop policy if exists "internal users can read domestic sales" on public.domestic_sales;
drop policy if exists "internal users can read domestic sale lines" on public.domestic_sale_lines;
drop policy if exists "internal users can read domestic receivables" on public.domestic_receivables;
drop policy if exists "internal users can read domestic payments" on public.domestic_receivable_payments;
create policy "internal users can read domestic sales"
  on public.domestic_sales for select to authenticated using (public.is_internal_user());
create policy "internal users can read domestic sale lines"
  on public.domestic_sale_lines for select to authenticated using (public.is_internal_user());
create policy "internal users can read domestic receivables"
  on public.domestic_receivables for select to authenticated using (public.is_internal_user());
create policy "internal users can read domestic payments"
  on public.domestic_receivable_payments for select to authenticated using (public.is_internal_user());

revoke all on public.domestic_customer_master, public.domestic_sales,
  public.domestic_sale_lines, public.domestic_receivables,
  public.domestic_receivable_payments from anon, authenticated;
grant select on public.domestic_sales, public.domestic_sale_lines,
  public.domestic_receivables, public.domestic_receivable_payments to authenticated;
grant select, insert, update, delete on public.domestic_customer_master to authenticated;

revoke all on function public.confirm_domestic_sale(date,text,numeric,text,jsonb) from public;
revoke all on function public.record_domestic_receivable_payment(uuid,date,numeric,numeric,text,text) from public;
revoke all on function public.create_domestic_opening_receivable(text,date,date,numeric,text) from public;
revoke all on function public.cancel_domestic_sale(uuid,text) from public;
grant execute on function public.confirm_domestic_sale(date,text,numeric,text,jsonb) to authenticated;
grant execute on function public.record_domestic_receivable_payment(uuid,date,numeric,numeric,text,text) to authenticated;
grant execute on function public.create_domestic_opening_receivable(text,date,date,numeric,text) to authenticated;
grant execute on function public.cancel_domestic_sale(uuid,text) to authenticated;

do $$
declare
  target_table text;
begin
  if to_regprocedure('public.log_business_audit_event()') is null then return; end if;
  foreach target_table in array array[
    'domestic_customer_master',
    'domestic_sales',
    'domestic_sale_lines',
    'domestic_receivables',
    'domestic_receivable_payments'
  ]
  loop
    execute format('drop trigger if exists trg_business_audit on public.%I',target_table);
    execute format(
      'create trigger trg_business_audit after insert or update or delete on public.%I for each row execute function public.log_business_audit_event()',
      target_table
    );
  end loop;
end $$;

notify pgrst, 'reload schema';

commit;
