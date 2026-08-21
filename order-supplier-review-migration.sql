-- Supplier review board and purchase-order completion tracking.

begin;

alter table public.order_entry_lines
  add column if not exists initial_supplier_code text,
  add column if not exists initial_supplier_name_snapshot text,
  add column if not exists supplier_decision_status text not null default 'provisional',
  add column if not exists supplier_confirmed_at timestamptz,
  add column if not exists supplier_confirmed_by uuid references auth.users(id) on delete set null,
  add column if not exists purchase_ordered boolean not null default false,
  add column if not exists purchase_ordered_at timestamptz,
  add column if not exists purchase_ordered_by uuid references auth.users(id) on delete set null;

alter table public.order_entry_lines
  drop constraint if exists order_entry_lines_supplier_decision_status_check;
alter table public.order_entry_lines
  add constraint order_entry_lines_supplier_decision_status_check
  check (supplier_decision_status in ('provisional','confirmed'));

update public.order_entry_lines line
set initial_supplier_code = coalesce(line.initial_supplier_code,line.supplier_code),
    initial_supplier_name_snapshot = coalesce(line.initial_supplier_name_snapshot,line.supplier_name_snapshot),
    supplier_decision_status = case
      when batch.status = 'confirmed' then 'confirmed'
      else coalesce(line.supplier_decision_status,'provisional')
    end,
    supplier_confirmed_at = case
      when batch.status = 'confirmed' then coalesce(line.supplier_confirmed_at,batch.confirmed_at,line.updated_at)
      else line.supplier_confirmed_at
    end
from public.order_entry_batches batch
where batch.id = line.batch_id;

create index if not exists idx_order_entry_lines_supplier_review
  on public.order_entry_lines(supplier_decision_status,purchase_ordered,supplier_code);

create table if not exists public.order_supplier_review_log (
  id uuid primary key default gen_random_uuid(),
  order_line_id uuid not null references public.order_entry_lines(id) on delete cascade,
  action text not null,
  old_supplier_code text,
  new_supplier_code text,
  old_decision_status text,
  new_decision_status text,
  old_purchase_ordered boolean,
  new_purchase_ordered boolean,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_order_supplier_review_log_line
  on public.order_supplier_review_log(order_line_id,created_at desc);

alter table public.order_supplier_review_log enable row level security;

drop policy if exists "internal read order supplier review log"
  on public.order_supplier_review_log;
create policy "internal read order supplier review log"
on public.order_supplier_review_log for select to authenticated
using (public.is_internal_user());

grant select on public.order_supplier_review_log to authenticated;
revoke insert, update, delete on public.order_supplier_review_log from public, anon, authenticated;

create or replace function public.prepare_order_supplier_review()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.initial_supplier_code := coalesce(new.initial_supplier_code,new.supplier_code);
    new.initial_supplier_name_snapshot := coalesce(new.initial_supplier_name_snapshot,new.supplier_name_snapshot);
    new.supplier_decision_status := coalesce(new.supplier_decision_status,'provisional');
    return new;
  end if;

  if new.supplier_code is distinct from old.supplier_code
     and coalesce(current_setting('app.order_supplier_review',true),'') <> 'on' then
    new.supplier_decision_status := 'provisional';
    new.supplier_confirmed_at := null;
    new.supplier_confirmed_by := null;
    new.purchase_ordered := false;
    new.purchase_ordered_at := null;
    new.purchase_ordered_by := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prepare_order_supplier_review on public.order_entry_lines;
create trigger trg_prepare_order_supplier_review
before insert or update on public.order_entry_lines
for each row execute function public.prepare_order_supplier_review();

create or replace view public.order_supplier_review
with (security_invoker = true)
as
select
  line.id as line_id,
  line.batch_id,
  line.line_no,
  batch.order_date,
  batch.ship_date,
  batch.site_code,
  batch.importer_code,
  batch.importer_name_snapshot,
  batch.customer_code,
  batch.customer_name_snapshot,
  line.product_code,
  line.product_name_snapshot,
  line.order_qty,
  line.order_unit,
  line.initial_supplier_code,
  line.initial_supplier_name_snapshot,
  line.supplier_code,
  line.supplier_name_snapshot,
  line.supplier_decision_status,
  line.supplier_confirmed_at,
  line.supplier_confirmed_by,
  line.purchase_ordered,
  line.purchase_ordered_at,
  line.purchase_ordered_by,
  line.purchase_note,
  line.updated_at
from public.order_entry_lines line
join public.order_entry_batches batch on batch.id = line.batch_id
where batch.status = 'confirmed';

revoke all on public.order_supplier_review from public, anon, authenticated;

create or replace function public.list_order_supplier_review(
  p_order_date date default null,
  p_only_unordered boolean default false
)
returns setof public.order_supplier_review
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_internal_user() then
    raise exception 'Internal access is required.';
  end if;
  if p_order_date is null and not p_only_unordered then
    raise exception 'Order date is required unless only unordered lines are requested.';
  end if;

  return query
  select review.*
  from public.order_supplier_review review
  where (p_order_date is null or review.order_date = p_order_date)
    and (not p_only_unordered or not review.purchase_ordered)
  order by review.order_date desc,review.supplier_code,review.importer_code,
           review.customer_name_snapshot,review.line_no,review.line_id;
end;
$$;

create or replace function public.update_order_supplier_review(
  p_line_ids uuid[],
  p_supplier_code text default null,
  p_confirm boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  line_row public.order_entry_lines;
  supplier_row public.supplier_master;
  new_supplier_code text;
  new_supplier_name text;
  new_status text;
  new_ordered boolean;
  changed_count integer := 0;
begin
  if not public.is_internal_user() then
    raise exception 'Internal access is required.';
  end if;
  if coalesce(array_length(p_line_ids,1),0) = 0 then
    raise exception 'Order lines are required.';
  end if;

  if p_supplier_code is not null then
    select * into supplier_row
    from public.supplier_master
    where lower(supplier_code) = lower(btrim(p_supplier_code))
      and is_active
    limit 1;
    if supplier_row.supplier_code is null then
      raise exception 'Supplier not found: %',p_supplier_code;
    end if;
  end if;

  perform set_config('app.order_supplier_review','on',true);

  for line_row in
    select line.*
    from public.order_entry_lines line
    join public.order_entry_batches batch on batch.id = line.batch_id
    where line.id = any(p_line_ids)
      and batch.status = 'confirmed'
    for update of line
  loop
    new_supplier_code := coalesce(supplier_row.supplier_code,line_row.supplier_code);
    new_supplier_name := coalesce(supplier_row.supplier_name,line_row.supplier_name_snapshot);

    if p_confirm and nullif(btrim(coalesce(new_supplier_code,'')),'') is null then
      raise exception 'Supplier code is required before confirmation.';
    end if;

    if new_supplier_code is distinct from line_row.supplier_code and exists (
      select 1
      from public.external_work_assignment_lines assignment_line
      join public.external_work_assignments assignment on assignment.id = assignment_line.assignment_id
      where assignment_line.order_line_id = line_row.id
        and assignment_line.active
        and assignment.status not in ('draft','cancelled','returned')
    ) then
      raise exception 'External work has already been published for order line %.',line_row.id;
    end if;

    new_status := case
      when p_confirm then 'confirmed'
      when new_supplier_code is distinct from line_row.supplier_code then 'provisional'
      else line_row.supplier_decision_status
    end;
    new_ordered := case
      when new_supplier_code is distinct from line_row.supplier_code then false
      else line_row.purchase_ordered
    end;

    if new_supplier_code is not distinct from line_row.supplier_code
       and new_status is not distinct from line_row.supplier_decision_status
       and new_ordered is not distinct from line_row.purchase_ordered then
      continue;
    end if;

    insert into public.order_supplier_review_log (
      order_line_id,action,old_supplier_code,new_supplier_code,
      old_decision_status,new_decision_status,
      old_purchase_ordered,new_purchase_ordered,created_by
    ) values (
      line_row.id,
      case
        when new_supplier_code is distinct from line_row.supplier_code and p_confirm then 'supplier_change_confirm'
        when new_supplier_code is distinct from line_row.supplier_code then 'supplier_change'
        else 'supplier_confirm'
      end,
      line_row.supplier_code,new_supplier_code,
      line_row.supplier_decision_status,new_status,
      line_row.purchase_ordered,new_ordered,auth.uid()
    );

    update public.order_entry_lines
    set supplier_code = new_supplier_code,
        supplier_name_snapshot = new_supplier_name,
        supplier_decision_status = new_status,
        supplier_confirmed_at = case when new_status = 'confirmed' then now() else null end,
        supplier_confirmed_by = case when new_status = 'confirmed' then auth.uid() else null end,
        purchase_ordered = new_ordered,
        purchase_ordered_at = case when new_ordered then purchase_ordered_at else null end,
        purchase_ordered_by = case when new_ordered then purchase_ordered_by else null end,
        updated_at = now()
    where id = line_row.id;

    changed_count := changed_count + 1;
  end loop;

  return changed_count;
end;
$$;

create or replace function public.set_order_lines_purchase_ordered(
  p_line_ids uuid[],
  p_ordered boolean
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  line_row public.order_entry_lines;
  changed_count integer := 0;
begin
  if not public.is_internal_user() then
    raise exception 'Internal access is required.';
  end if;
  if coalesce(array_length(p_line_ids,1),0) = 0 then
    raise exception 'Order lines are required.';
  end if;

  perform set_config('app.order_supplier_review','on',true);

  for line_row in
    select line.*
    from public.order_entry_lines line
    join public.order_entry_batches batch on batch.id = line.batch_id
    where line.id = any(p_line_ids)
      and batch.status = 'confirmed'
    for update of line
  loop
    if p_ordered and nullif(btrim(coalesce(line_row.supplier_code,'')),'') is null then
      raise exception 'Supplier code is required before marking ordered.';
    end if;
    if line_row.purchase_ordered = p_ordered
       and (not p_ordered or line_row.supplier_decision_status = 'confirmed') then
      continue;
    end if;

    insert into public.order_supplier_review_log (
      order_line_id,action,old_supplier_code,new_supplier_code,
      old_decision_status,new_decision_status,
      old_purchase_ordered,new_purchase_ordered,created_by
    ) values (
      line_row.id,case when p_ordered then 'ordered' else 'ordered_cancelled' end,
      line_row.supplier_code,line_row.supplier_code,
      line_row.supplier_decision_status,
      case when p_ordered then 'confirmed' else line_row.supplier_decision_status end,
      line_row.purchase_ordered,p_ordered,auth.uid()
    );

    update public.order_entry_lines
    set purchase_ordered = p_ordered,
        purchase_ordered_at = case when p_ordered then now() else null end,
        purchase_ordered_by = case when p_ordered then auth.uid() else null end,
        supplier_decision_status = case when p_ordered then 'confirmed' else supplier_decision_status end,
        supplier_confirmed_at = case when p_ordered then coalesce(supplier_confirmed_at,now()) else supplier_confirmed_at end,
        supplier_confirmed_by = case when p_ordered then coalesce(supplier_confirmed_by,auth.uid()) else supplier_confirmed_by end,
        updated_at = now()
    where id = line_row.id;

    changed_count := changed_count + 1;
  end loop;

  return changed_count;
end;
$$;

revoke all on function public.prepare_order_supplier_review() from public, anon, authenticated;
revoke all on function public.list_order_supplier_review(date,boolean) from public, anon;
revoke all on function public.update_order_supplier_review(uuid[],text,boolean) from public, anon;
revoke all on function public.set_order_lines_purchase_ordered(uuid[],boolean) from public, anon;
grant execute on function public.list_order_supplier_review(date,boolean) to authenticated;
grant execute on function public.update_order_supplier_review(uuid[],text,boolean) to authenticated;
grant execute on function public.set_order_lines_purchase_ordered(uuid[],boolean) to authenticated;

notify pgrst, 'reload schema';

commit;
