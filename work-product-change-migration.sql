-- Change one work product and its order source atomically. No financial backfill.
begin;
create table if not exists public.work_product_change_log (
  request_id uuid primary key,
  session_id uuid not null,
  work_line_id uuid not null,
  requested_change jsonb not null,
  before_work jsonb not null,
  after_work jsonb not null,
  before_order jsonb,
  after_order jsonb,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.work_product_change_log enable row level security;
drop policy if exists "internal read work product changes" on public.work_product_change_log;
create policy "internal read work product changes" on public.work_product_change_log
for select to authenticated using (public.is_internal_user());
revoke all on public.work_product_change_log from public,anon,authenticated;
grant select on public.work_product_change_log to authenticated;

create or replace function public.change_work_order_product(
  p_session_id uuid,p_source_row_no integer,p_expected_updated_at timestamptz,
  p_request_id uuid,p_change jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  work_row public.order_lines%rowtype;
  session_row public.work_sessions%rowtype;
  source_row public.order_entry_lines%rowtype;
  previous public.work_product_change_log%rowtype;
  before_work jsonb;
  before_order jsonb;
  new_code text;
  new_price numeric;
begin
  if auth.uid() is null or not coalesce(public.is_internal_user(),false) then
    raise exception '商品変更は社内ユーザーのみ可能です。';
  end if;
  if p_request_id is null or jsonb_typeof(p_change) is distinct from 'object' then
    raise exception '変更内容を確認してください。';
  end if;
  select * into session_row from public.work_sessions where id=p_session_id for update;
  if not found then raise exception '作業が見つかりません。'; end if;
  select * into work_row from public.order_lines where session_id=p_session_id and source_row_no=p_source_row_no for update;
  if not found then raise exception '作業明細が見つかりません。'; end if;
  select * into previous from public.work_product_change_log where request_id=p_request_id;
  if found then
    if previous.work_line_id<>work_row.id or previous.created_by<>auth.uid()
       or previous.requested_change is distinct from p_change then
      raise exception '保存要求が重複しています。開き直してください。';
    end if;
    return to_jsonb(work_row);
  end if;
  if session_row.locked or session_row.provisional_locked or session_row.status='closed' then
    raise exception '仮締め・売上確定済みです。解除してから変更してください。';
  end if;
  if p_expected_updated_at is null or work_row.updated_at is distinct from p_expected_updated_at then
    raise exception '他の担当者が明細を更新しました。開き直して確認してください。' using errcode='40001';
  end if;
  if exists(select 1 from public.sales_records where session_id=p_session_id and source_row_no=p_source_row_no) then
    raise exception '売上登録済みの明細です。売上参照の修正を使用してください。';
  end if;
  if nullif(btrim(p_change->>'product_name'),'') is null then raise exception '商品名を入力してください。'; end if;
  new_code:=coalesce(nullif(btrim(p_change->>'product_id'),''),'ADD-'||replace(work_row.id::text,'-',''));
  if nullif(btrim(p_change->>'product_id'),'') is not null and new_code is distinct from work_row.product_id
     and not exists(select 1 from public.product_master where product_id=new_code and is_active) then
    raise exception '商品コードがマスタにありません。未登録商品はコードを空欄にしてください。';
  end if;
  new_price:=nullif(p_change->>'unit_price','')::numeric;
  if new_price<0 or new_price::text in ('NaN','Infinity','-Infinity') then
    raise exception '売価は0以上の有限の数値で入力してください。';
  end if;
  before_work:=to_jsonb(work_row);
  if work_row.source_order_line_id is not null then
    select * into source_row from public.order_entry_lines where id=work_row.source_order_line_id for update;
    if not found then raise exception '元の受注明細が見つかりません。'; end if;
    if source_row.updated_at is distinct from (p_change->>'expected_source_updated_at')::timestamptz then
      raise exception '受注明細が更新されました。開き直して確認してください。' using errcode='40001';
    end if;
    if exists(select 1 from public.order_lines where source_order_line_id=source_row.id and id<>work_row.id) then
      raise exception '複数作業に紐づく受注です。受注側で確認してください。';
    end if;
    perform l.id from public.external_work_assignment_lines l join public.external_work_assignments a on a.id=l.assignment_id
    where l.order_line_id=source_row.id for update of l,a;
    if exists(select 1 from public.external_work_assignment_lines l join public.external_work_assignments a on a.id=l.assignment_id
      where l.order_line_id=source_row.id and l.active and a.status not in ('draft','cancelled')) then
      raise exception '外部作業へ公開済みです。依頼を取り消してから商品を変更してください。';
    end if;
    if exists(select 1 from public.purchase_receipt_lines p join public.purchase_receipts r on r.id=p.receipt_id
      join public.external_work_assignment_lines l on l.id=p.source_assignment_line_id
      where l.order_line_id=source_row.id and r.status<>'cancelled') then
      raise exception '仕入に紐づいています。仕入を確認してから変更してください。';
    end if;
    before_order:=to_jsonb(source_row);
    update public.order_entry_lines set product_code=new_code,product_name_snapshot=btrim(p_change->>'product_name'),
      english_name_snapshot=nullif(btrim(p_change->>'english_name'),''),unit_price=new_price,
      purchase_ordered=case when new_code is distinct from product_code or btrim(p_change->>'product_name') is distinct from product_name_snapshot then false else purchase_ordered end,
      purchase_ordered_at=case when new_code is distinct from product_code or btrim(p_change->>'product_name') is distinct from product_name_snapshot then null else purchase_ordered_at end,
      purchase_ordered_by=case when new_code is distinct from product_code or btrim(p_change->>'product_name') is distinct from product_name_snapshot then null else purchase_ordered_by end
    where id=source_row.id returning * into source_row;
    update public.external_work_assignment_lines l set product_code=new_code,product_name=btrim(p_change->>'product_name')
    from public.external_work_assignments a where l.order_line_id=source_row.id and a.id=l.assignment_id and a.status='draft';
  end if;
  update public.order_lines set product_id=new_code,product_name=btrim(p_change->>'product_name'),
    english_name=nullif(btrim(p_change->>'english_name'),''),scientific_name=nullif(btrim(p_change->>'scientific_name'),''),
    origin=nullif(btrim(p_change->>'origin'),''),unit_price=new_price,updated_by=auth.uid()
  where id=work_row.id returning * into work_row;
  insert into public.work_product_change_log(request_id,session_id,work_line_id,requested_change,before_work,after_work,before_order,after_order,created_by)
  values(p_request_id,p_session_id,work_row.id,p_change,before_work,to_jsonb(work_row),before_order,to_jsonb(source_row),auth.uid());
  return to_jsonb(work_row);
end;
$$;
revoke all on function public.change_work_order_product(uuid,integer,timestamptz,uuid,jsonb) from public,anon;
grant execute on function public.change_work_order_product(uuid,integer,timestamptz,uuid,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
