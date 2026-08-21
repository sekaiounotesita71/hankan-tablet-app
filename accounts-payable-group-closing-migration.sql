-- Atomic closing for a selected group of suppliers sharing a closing day.
-- Run after accounts-payable-closing-migration.sql.

begin;

create or replace function public.close_accounts_payable_group(
  p_items jsonb
)
returns setof public.accounts_payable_closings
language plpgsql
security invoker
set search_path = public
as $$
declare
  item jsonb;
  closing_row public.accounts_payable_closings;
  item_count integer;
begin
  if auth.uid() is null or not public.is_internal_user() then
    raise exception 'ログインしてください。';
  end if;
  if jsonb_typeof(p_items) <> 'array' then
    raise exception '買掛締め対象が正しくありません。';
  end if;

  item_count := jsonb_array_length(p_items);
  if item_count < 1 then
    raise exception '買掛締め対象を選択してください。';
  end if;
  if item_count > 200 then
    raise exception '一度に締められる仕入先は200件までです。';
  end if;

  for item in select value from jsonb_array_elements(p_items)
  loop
    if nullif(trim(item ->> 'supplier_code'),'') is null then
      raise exception '仕入先コードが空欄の締め対象があります。';
    end if;

    select * into closing_row
    from public.close_accounts_payable_period(
      item ->> 'supplier_code',
      (item ->> 'period_from')::date,
      (item ->> 'period_to')::date,
      (item ->> 'due_date')::date,
      coalesce(nullif(item ->> 'opening_balance_jpy','')::numeric,0),
      coalesce(nullif(item ->> 'purchase_amount_jpy','')::numeric,0),
      coalesce(nullif(item ->> 'payment_amount_jpy','')::numeric,0),
      coalesce(nullif(item ->> 'closing_balance_jpy','')::numeric,0),
      coalesce(item -> 'snapshot','{}'::jsonb)
    );

    return next closing_row;
  end loop;

  return;
end;
$$;

revoke all on function public.close_accounts_payable_group(jsonb)
  from public, anon;
grant execute on function public.close_accounts_payable_group(jsonb)
  to authenticated;

notify pgrst, 'reload schema';

commit;
