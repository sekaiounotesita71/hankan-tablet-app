begin;

-- Shipping correction must not rebuild receivables belonging to other importers.
create or replace function public.admin_update_session_shipping_fee(
  p_session_id uuid, p_importer_code text, p_amount numeric, p_reason text
)
returns public.work_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  session_row public.work_sessions;
  updated_row public.work_sessions;
  receivable_row public.accounts_receivable;
  normalized_importer text := public.canonical_importer_code(p_importer_code);
  target_count integer;
  old_fees jsonb;
  new_fees jsonb;
  fee_item record;
  fee_amount numeric;
  total_fee numeric;
begin
  if auth.uid() is null or not public.is_master_admin() then
    raise exception '送料を修正できるのは管理者のみです。';
  end if;
  if trim(coalesce(p_reason, '')) = '' then
    raise exception '修正理由を入力してください。';
  end if;
  if coalesce(normalized_importer, '') = '' or p_amount is null or p_amount < 0
     or p_amount::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception '輸入社コードと0以上の送料を入力してください。';
  end if;
  fee_amount := round(p_amount, 0);

  select * into session_row from public.work_sessions
  where id = p_session_id for update;
  if session_row.id is null then
    raise exception '対象作業が見つかりません。';
  end if;
  if not exists (
    select 1 from public.sales_records s
    where s.session_id = p_session_id
      and public.canonical_importer_code(coalesce(s.importer_code, s.importer_id, '')) = normalized_importer
  ) then
    raise exception '対象作業に指定輸入社の売上がありません。';
  end if;

  perform 1 from public.accounts_receivable r
  where r.source_session_id = p_session_id
    and public.canonical_importer_code(r.importer_code) = normalized_importer
  for update;
  if exists (
    select 1 from public.accounts_receivable r
    where r.source_session_id = p_session_id
      and public.canonical_importer_code(r.importer_code) = normalized_importer
      and (r.closing_id is not null or exists (
        select 1 from public.accounts_receivable_closings c
        where public.canonical_importer_code(c.importer_code) = normalized_importer
          and c.status = 'closed'
          and r.invoice_date between c.period_from and c.period_to
      ))
  ) then
    raise exception 'この輸入社の請求は締め済みです。先に請求締めを解除してください。';
  end if;
  if exists (
    select 1 from public.accounts_receivable r
    join public.accounts_receivable_payments p on p.receivable_id = r.id
    where r.source_session_id = p_session_id
      and public.canonical_importer_code(r.importer_code) = normalized_importer
  ) then
    raise exception 'この輸入社の売掛は入金登録済みです。先に入金履歴を確認してください。';
  end if;

  select count(*) into target_count from public.accounts_receivable r
  where r.source_session_id = p_session_id and r.source_type = 'sales'
    and public.canonical_importer_code(r.importer_code) = normalized_importer;
  if target_count <> 1 then
    raise exception '対象輸入社の売掛データが未連携または重複しています。売掛連携を確認してください。';
  end if;
  select * into receivable_row from public.accounts_receivable r
  where r.source_session_id = p_session_id and r.source_type = 'sales'
    and public.canonical_importer_code(r.importer_code) = normalized_importer;
  if upper(coalesce(receivable_row.currency, 'JPY')) <> 'JPY' then
    raise exception 'JPY以外の送料はこの画面では修正できません。';
  end if;

  old_fees := coalesce(session_row.shipping_fees, '{}'::jsonb);
  new_fees := old_fees;
  -- Canonicalize only the edited importer's aliases; preserve other stored fees.
  for fee_item in select key from jsonb_each(old_fees) loop
    if public.canonical_importer_code(fee_item.key) = normalized_importer then
      new_fees := new_fees - fee_item.key;
    end if;
  end loop;
  new_fees := new_fees || jsonb_build_object(normalized_importer, fee_amount);
  select coalesce(sum(f.amount), 0) into total_fee from (
    select distinct on (public.canonical_importer_code(e.key))
      (e.value #>> '{}')::numeric as amount
    from jsonb_each(new_fees) e
    order by public.canonical_importer_code(e.key),
      case when e.key = public.canonical_importer_code(e.key) then 0 else 1 end, e.key
  ) f;

  update public.accounts_receivable
  set shipping_amount_jpy = fee_amount,
      amount_jpy = round(coalesce(net_sales_jpy, 0), 0) + fee_amount
        + round(coalesce(adjustment_amount_jpy, 0), 0),
      updated_by = auth.uid()
  where id = receivable_row.id;

  update public.work_sessions
  set shipping_fees = new_fees, shipping_fee = round(total_fee, 0)
  where id = p_session_id returning * into updated_row;

  insert into public.sales_correction_log (
    action_type, session_id, importer_code, old_values, new_values, reason, changed_by
  ) values (
    'shipping_fee', p_session_id, normalized_importer,
    jsonb_build_object('shipping_fees', old_fees, 'shipping_fee', session_row.shipping_fee,
      'receivable_id', receivable_row.id, 'shipping_amount_jpy', receivable_row.shipping_amount_jpy),
    jsonb_build_object('shipping_fees', new_fees, 'shipping_fee', updated_row.shipping_fee,
      'receivable_id', receivable_row.id, 'shipping_amount_jpy', fee_amount),
    trim(p_reason), auth.uid()
  );
  return updated_row;
end;
$$;

revoke all on function public.admin_update_session_shipping_fee(uuid, text, numeric, text) from public;
grant execute on function public.admin_update_session_shipping_fee(uuid, text, numeric, text) to authenticated;
notify pgrst, 'reload schema';
commit;
