-- 売上確定後の管理者修正、輸入社別送料修正、現場作業の仮締めを追加します。
-- Supabase Dashboard > SQL Editor で実行してください。

alter table public.work_sessions
  add column if not exists provisional_locked boolean not null default false,
  add column if not exists provisional_locked_at timestamptz,
  add column if not exists provisional_locked_by uuid references auth.users(id),
  add column if not exists provisional_unlocked_at timestamptz,
  add column if not exists provisional_unlocked_by uuid references auth.users(id),
  add column if not exists provisional_unlock_reason text;

create table if not exists public.sales_correction_log (
  id uuid primary key default gen_random_uuid(),
  action_type text not null
    check (action_type in ('sales_record', 'shipping_fee', 'provisional_lock', 'provisional_unlock')),
  session_id uuid references public.work_sessions(id) on delete set null,
  sales_record_id uuid references public.sales_records(id) on delete set null,
  importer_code text,
  old_values jsonb not null default '{}'::jsonb,
  new_values jsonb not null default '{}'::jsonb,
  reason text not null,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now()
);

create index if not exists idx_sales_correction_log_session
  on public.sales_correction_log(session_id, changed_at desc);

alter table public.sales_correction_log enable row level security;

drop policy if exists "authenticated can read sales correction log"
  on public.sales_correction_log;
create policy "authenticated can read sales correction log"
on public.sales_correction_log for select to authenticated
using (public.is_master_admin());

revoke insert, update, delete on public.sales_correction_log from authenticated;
grant select on public.sales_correction_log to authenticated;

-- 新旧データで混在する輸入社名（BKK等）と輸入社コード（02等）を統一します。
-- 同名の旧コードが残っている場合は、数字の現行コードを優先します。
create or replace function public.canonical_importer_code(
  p_value text
)
returns text
language sql
stable
security definer
set search_path = public
as $$
  with input_value as (
    select upper(regexp_replace(coalesce(p_value, ''), '[[:space:]_-]+', '', 'g')) as value
  ),
  candidates as (
    select
      upper(regexp_replace(m.importer_code, '[[:space:]_-]+', '', 'g')) as importer_code,
      case when trim(m.importer_code) ~ '^[0-9]+$' then 0 else 1 end as legacy_rank,
      case
        when upper(regexp_replace(m.importer_code, '[[:space:]_-]+', '', 'g')) = i.value then 0
        else 1
      end as match_rank
    from public.importer_master m
    cross join input_value i
    where
      upper(regexp_replace(m.importer_code, '[[:space:]_-]+', '', 'g')) = i.value
      or upper(regexp_replace(m.importer_name, '[[:space:]_-]+', '', 'g')) = i.value
      or exists (
        select 1
        from unnest(coalesce(m.aliases, '{}'::text[])) as alias_item(alias_name)
        where upper(regexp_replace(alias_name, '[[:space:]_-]+', '', 'g')) = i.value
      )
  )
  select coalesce(
    (
      select c.importer_code
      from candidates c
      order by c.legacy_rank, c.match_rank, c.importer_code
      limit 1
    ),
    i.value
  )
  from input_value i;
$$;

-- 売上確定前は現場担当者が更新でき、売上確定後は管理者だけが更新できます。
drop policy if exists "authenticated can update sales records"
  on public.sales_records;
create policy "authenticated can update sales records"
on public.sales_records for update to authenticated
using (
  public.is_master_admin()
  or exists (
    select 1
    from public.work_sessions s
    where s.id = sales_records.session_id
      and coalesce(s.locked, false) = false
  )
)
with check (
  public.is_master_admin()
  or exists (
    select 1
    from public.work_sessions s
    where s.id = sales_records.session_id
      and coalesce(s.locked, false) = false
  )
);

drop policy if exists "authenticated can delete sales records"
  on public.sales_records;
create policy "authenticated can delete sales records"
on public.sales_records for delete to authenticated
using (public.is_master_admin());

create or replace function public.guard_work_session_detail_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_session_id uuid;
  session_row public.work_sessions;
begin
  if tg_op = 'DELETE' then
    target_session_id := old.session_id;
  else
    target_session_id := new.session_id;
  end if;

  select *
  into session_row
  from public.work_sessions
  where id = target_session_id;

  if (
    coalesce(session_row.locked, false)
    or coalesce(session_row.provisional_locked, false)
  ) and not public.is_master_admin() then
    if coalesce(session_row.locked, false) then
      raise exception '売上確定済みのため変更できません。管理者の売上修正を使用してください。';
    end if;
    raise exception '仮締め中のため変更できません。管理者が仮締め解除してください。';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_order_lines_session
  on public.order_lines;
create trigger trg_guard_order_lines_session
before insert or update or delete on public.order_lines
for each row execute function public.guard_work_session_detail_change();

drop trigger if exists trg_guard_boxes_session
  on public.boxes;
create trigger trg_guard_boxes_session
before insert or update or delete on public.boxes
for each row execute function public.guard_work_session_detail_change();

create or replace function public.rebuild_session_accounts_receivable(
  p_session_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  session_row public.work_sessions;
  importer_count integer := 0;
begin
  select *
  into session_row
  from public.work_sessions
  where id = p_session_id
  for update;

  if session_row.id is null then
    raise exception '対象作業が見つかりません。';
  end if;

  if exists (
    select 1
    from public.accounts_receivable r
    where r.source_session_id = p_session_id
      and r.closing_id is not null
  ) then
    raise exception '請求締め済みの売掛があります。先に請求締めを解除してください。';
  end if;

  if exists (
    select 1
    from public.accounts_receivable r
    join public.accounts_receivable_payments p
      on p.receivable_id = r.id
    where r.source_session_id = p_session_id
  ) then
    raise exception '入金登録済みの売掛があります。先に入金履歴を確認してください。';
  end if;

  select count(distinct public.canonical_importer_code(coalesce(importer_code, importer_id, '')))
  into importer_count
  from public.sales_records
  where session_id = p_session_id
    and coalesce(is_stockout, false) = false
    and coalesce(importer_code, importer_id, '') <> '';

  with grouped as (
    select
      public.canonical_importer_code(coalesce(importer_code, importer_id, '')) as importer_code,
      min(work_date) as invoice_date,
      sum(coalesce(amount, input_qty * unit_price, 0)) as net_sales,
      array_remove(array_agg(distinct nullif(trim(store_name), '') order by nullif(trim(store_name), '')), null) as customers
    from public.sales_records
    where session_id = p_session_id
      and coalesce(is_stockout, false) = false
      and coalesce(importer_code, importer_id, '') <> ''
    group by public.canonical_importer_code(coalesce(importer_code, importer_id, ''))
  ),
  calculated as (
    select
      g.*,
      coalesce(
        (
          select (fee_item.value #>> '{}')::numeric
          from jsonb_each(coalesce(session_row.shipping_fees, '{}'::jsonb)) fee_item
          where public.canonical_importer_code(fee_item.key) = g.importer_code
          order by
            case
              when upper(regexp_replace(fee_item.key, '[[:space:]_-]+', '', 'g')) = g.importer_code then 0
              else 1
            end
          limit 1
        ),
        case
          when importer_count = 1
            then session_row.shipping_fee
          else 0
        end,
        0
      ) as shipping
    from grouped g
    where g.importer_code <> ''
  )
  insert into public.accounts_receivable (
    source_key,
    source_type,
    source_session_id,
    importer_code,
    importer_name,
    customer_name,
    customer_names,
    invoice_date,
    currency,
    net_sales_jpy,
    shipping_amount_jpy,
    amount_jpy,
    created_by,
    updated_by
  )
  select
    'sales:' || p_session_id::text || ':' || c.importer_code,
    'sales',
    p_session_id,
    c.importer_code,
    coalesce((
      select m.importer_name
      from public.importer_master m
      where public.canonical_importer_code(m.importer_code) = c.importer_code
      order by case when trim(m.importer_code) ~ '^[0-9]+$' then 0 else 1 end
      limit 1
    ), ''),
    case
      when coalesce(array_length(c.customers, 1), 0) = 0 then ''
      when array_length(c.customers, 1) = 1 then c.customers[1]
      else c.customers[1] || ' 他' || (array_length(c.customers, 1) - 1)::text || '件'
    end,
    to_jsonb(coalesce(c.customers, array[]::text[])),
    coalesce(
      c.invoice_date,
      session_row.work_date,
      timezone(
        'Asia/Tokyo',
        coalesce(session_row.finalized_at, session_row.created_at, now())
      )::date
    ),
    'JPY',
    round(coalesce(c.net_sales, 0), 2),
    round(coalesce(c.shipping, 0), 2),
    round(coalesce(c.net_sales, 0) + coalesce(c.shipping, 0), 2),
    auth.uid(),
    auth.uid()
  from calculated c
  where abs(coalesce(c.net_sales, 0) + coalesce(c.shipping, 0)) > 0.005
  on conflict (source_key)
  do update set
    importer_code = excluded.importer_code,
    importer_name = excluded.importer_name,
    customer_name = excluded.customer_name,
    customer_names = excluded.customer_names,
    invoice_date = excluded.invoice_date,
    net_sales_jpy = excluded.net_sales_jpy,
    shipping_amount_jpy = excluded.shipping_amount_jpy,
    amount_jpy = excluded.amount_jpy,
    updated_by = auth.uid();

  delete from public.accounts_receivable r
  where r.source_session_id = p_session_id
    and r.source_type = 'sales'
    and r.closing_id is null
    and not exists (
      select 1
      from public.accounts_receivable_payments p
      where p.receivable_id = r.id
    )
    and not exists (
      select 1
      from public.sales_records s
      where s.session_id = p_session_id
        and coalesce(s.is_stockout, false) = false
        and public.canonical_importer_code(coalesce(s.importer_code, s.importer_id, ''))
          = public.canonical_importer_code(r.importer_code)
    );
end;
$$;

create or replace function public.admin_correct_sales_record(
  p_sales_record_id uuid,
  p_work_date date,
  p_importer_code text,
  p_store_name text,
  p_product_id text,
  p_product_name text,
  p_origin text,
  p_input_qty numeric,
  p_input_unit text,
  p_net_weight numeric,
  p_unit_price numeric,
  p_memo text,
  p_reason text
)
returns public.sales_records
language plpgsql
security definer
set search_path = public
as $$
declare
  old_row public.sales_records;
  new_row public.sales_records;
  normalized_importer text := public.canonical_importer_code(p_importer_code);
begin
  if not public.is_master_admin() then
    raise exception '売上を修正できるのは管理者のみです。';
  end if;
  if trim(coalesce(p_reason, '')) = '' then
    raise exception '修正理由を入力してください。';
  end if;
  if p_work_date is null or normalized_importer = '' then
    raise exception '作業日と輸入社コードを入力してください。';
  end if;
  if p_input_qty is not null and p_input_qty < 0 then
    raise exception '数量は0以上で入力してください。';
  end if;
  if p_net_weight is not null and p_net_weight < 0 then
    raise exception 'NET重量は0以上で入力してください。';
  end if;
  if p_unit_price is not null and p_unit_price < 0 then
    raise exception '単価は0以上で入力してください。';
  end if;

  select *
  into old_row
  from public.sales_records
  where id = p_sales_record_id
  for update;

  if old_row.id is null then
    raise exception '修正する売上明細が見つかりません。';
  end if;

  perform public.rebuild_session_accounts_receivable(old_row.session_id);

  update public.sales_records
  set
    work_date = p_work_date,
    importer_id = normalized_importer,
    importer_code = normalized_importer,
    store_name = nullif(trim(coalesce(p_store_name, '')), ''),
    product_id = nullif(trim(coalesce(p_product_id, '')), ''),
    product_name = nullif(trim(coalesce(p_product_name, '')), ''),
    origin = nullif(trim(coalesce(p_origin, '')), ''),
    input_qty = p_input_qty,
    input_unit = nullif(trim(coalesce(p_input_unit, '')), ''),
    net_weight = p_net_weight,
    unit_price = p_unit_price,
    amount = case
      when coalesce(is_stockout, false) then null
      when p_input_qty is null or p_unit_price is null then null
      else round(p_input_qty * p_unit_price, 2)
    end,
    memo = nullif(trim(coalesce(p_memo, '')), '')
  where id = p_sales_record_id
  returning * into new_row;

  update public.order_lines
  set
    importer_id = normalized_importer,
    importer_code = normalized_importer,
    store_name = coalesce(new_row.store_name, 'UNKNOWN_STORE'),
    product_id = new_row.product_id,
    product_name = new_row.product_name,
    origin = new_row.origin,
    input_qty = new_row.input_qty,
    input_unit = new_row.input_unit,
    net_weight = new_row.net_weight,
    unit_price = new_row.unit_price,
    memo = new_row.memo,
    updated_by = auth.uid()
  where session_id = new_row.session_id
    and source_row_no = new_row.source_row_no;

  insert into public.sales_correction_log (
    action_type,
    session_id,
    sales_record_id,
    importer_code,
    old_values,
    new_values,
    reason,
    changed_by
  )
  values (
    'sales_record',
    new_row.session_id,
    new_row.id,
    new_row.importer_code,
    to_jsonb(old_row),
    to_jsonb(new_row),
    trim(p_reason),
    auth.uid()
  );

  perform public.rebuild_session_accounts_receivable(new_row.session_id);
  return new_row;
end;
$$;

create or replace function public.admin_update_session_shipping_fee(
  p_session_id uuid,
  p_importer_code text,
  p_amount numeric,
  p_reason text
)
returns public.work_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  session_row public.work_sessions;
  updated_row public.work_sessions;
  normalized_importer text := public.canonical_importer_code(p_importer_code);
  old_fees jsonb;
  normalized_fees jsonb := '{}'::jsonb;
  fee_item record;
  canonical_fee_key text;
  total_fee numeric := 0;
begin
  if not public.is_master_admin() then
    raise exception '送料を修正できるのは管理者のみです。';
  end if;
  if trim(coalesce(p_reason, '')) = '' then
    raise exception '修正理由を入力してください。';
  end if;
  if normalized_importer = '' or p_amount is null or p_amount < 0 then
    raise exception '輸入社コードと0以上の送料を入力してください。';
  end if;

  select *
  into session_row
  from public.work_sessions
  where id = p_session_id
  for update;

  if session_row.id is null then
    raise exception '対象作業が見つかりません。';
  end if;
  if not exists (
    select 1
    from public.sales_records s
    where s.session_id = p_session_id
      and public.canonical_importer_code(coalesce(s.importer_code, s.importer_id, ''))
        = normalized_importer
  ) then
    raise exception '対象作業に指定輸入社の売上がありません。';
  end if;

  perform public.rebuild_session_accounts_receivable(p_session_id);

  old_fees := coalesce(session_row.shipping_fees, '{}'::jsonb);
  for fee_item in select key, value from jsonb_each(old_fees)
  loop
    canonical_fee_key := public.canonical_importer_code(fee_item.key);
    if canonical_fee_key <> '' then
      normalized_fees := normalized_fees || jsonb_build_object(
        canonical_fee_key,
        fee_item.value
      );
    end if;
  end loop;
  normalized_fees := normalized_fees || jsonb_build_object(normalized_importer, round(p_amount, 2));

  select coalesce(sum((value #>> '{}')::numeric), 0)
  into total_fee
  from jsonb_each(normalized_fees);

  update public.work_sessions
  set
    shipping_fees = normalized_fees,
    shipping_fee = round(total_fee, 2)
  where id = p_session_id
  returning * into updated_row;

  insert into public.sales_correction_log (
    action_type,
    session_id,
    importer_code,
    old_values,
    new_values,
    reason,
    changed_by
  )
  values (
    'shipping_fee',
    p_session_id,
    normalized_importer,
    jsonb_build_object('shipping_fees', old_fees, 'shipping_fee', session_row.shipping_fee),
    jsonb_build_object('shipping_fees', normalized_fees, 'shipping_fee', updated_row.shipping_fee),
    trim(p_reason),
    auth.uid()
  );

  perform public.rebuild_session_accounts_receivable(p_session_id);
  return updated_row;
end;
$$;

create or replace function public.set_work_session_provisional_lock(
  p_session_id uuid,
  p_locked boolean,
  p_reason text default ''
)
returns public.work_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  old_row public.work_sessions;
  new_row public.work_sessions;
begin
  if auth.uid() is null then
    raise exception 'ログインしてください。';
  end if;

  select *
  into old_row
  from public.work_sessions
  where id = p_session_id
  for update;

  if old_row.id is null then
    raise exception '対象作業が見つかりません。';
  end if;
  if coalesce(old_row.locked, false) then
    raise exception '売上確定済みの作業です。';
  end if;
  if p_locked = false and not public.is_master_admin() then
    raise exception '仮締めを解除できるのは管理者のみです。';
  end if;
  if p_locked = false and trim(coalesce(p_reason, '')) = '' then
    raise exception '仮締め解除理由を入力してください。';
  end if;

  update public.work_sessions
  set
    provisional_locked = p_locked,
    provisional_locked_at = case when p_locked then now() else provisional_locked_at end,
    provisional_locked_by = case when p_locked then auth.uid() else provisional_locked_by end,
    provisional_unlocked_at = case when p_locked then null else now() end,
    provisional_unlocked_by = case when p_locked then null else auth.uid() end,
    provisional_unlock_reason = case when p_locked then null else trim(p_reason) end
  where id = p_session_id
  returning * into new_row;

  insert into public.sales_correction_log (
    action_type,
    session_id,
    old_values,
    new_values,
    reason,
    changed_by
  )
  values (
    case when p_locked then 'provisional_lock' else 'provisional_unlock' end,
    p_session_id,
    jsonb_build_object('provisional_locked', old_row.provisional_locked),
    jsonb_build_object('provisional_locked', new_row.provisional_locked),
    coalesce(nullif(trim(p_reason), ''), '入力完了'),
    auth.uid()
  );

  return new_row;
end;
$$;

revoke all on function public.rebuild_session_accounts_receivable(uuid) from public;
revoke all on function public.canonical_importer_code(text) from public;
revoke all on function public.admin_correct_sales_record(
  uuid, date, text, text, text, text, text, numeric, text, numeric, numeric, text, text
) from public;
revoke all on function public.admin_update_session_shipping_fee(
  uuid, text, numeric, text
) from public;
revoke all on function public.set_work_session_provisional_lock(
  uuid, boolean, text
) from public;

grant execute on function public.admin_correct_sales_record(
  uuid, date, text, text, text, text, text, numeric, text, numeric, numeric, text, text
) to authenticated;
grant execute on function public.admin_update_session_shipping_fee(
  uuid, text, numeric, text
) to authenticated;
grant execute on function public.set_work_session_provisional_lock(
  uuid, boolean, text
) to authenticated;

notify pgrst, 'reload schema';
