-- Semi-monthly supplier terms: days 1-15 are paid at month-end,
-- and days 16-month-end are paid on the following month's 15th.
-- Run after accounts-payable-terms-migration.sql.

begin;

create or replace function public.accounts_payable_due_date(
  p_invoice_date date,
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
  invoice_month date;
  invoice_month_last_day date;
  effective_closing_date date;
  closing_month date;
  target_month date;
  target_last_day date;
  target_day integer;
begin
  if p_invoice_date is null then return null; end if;

  invoice_month := date_trunc('month',p_invoice_date)::date;
  invoice_month_last_day := (invoice_month + interval '1 month - 1 day')::date;

  if least(greatest(coalesce(p_closing_day,31),1),31) = 15 then
    if extract(day from p_invoice_date)::integer <= 15 then
      return invoice_month_last_day;
    end if;
    return (invoice_month + interval '1 month')::date + 14;
  end if;

  effective_closing_date := invoice_month + (
    least(
      greatest(coalesce(p_closing_day,31),1),
      extract(day from invoice_month_last_day)::integer
    ) - 1
  );
  closing_month := case
    when p_invoice_date <= effective_closing_date then invoice_month
    else (invoice_month + interval '1 month')::date
  end;
  target_month := (
    closing_month
    + make_interval(months => greatest(coalesce(p_payment_month_offset,1),0)::integer)
  )::date;
  target_last_day := (target_month + interval '1 month - 1 day')::date;
  target_day := least(
    greatest(coalesce(p_payment_day,31),1),
    extract(day from target_last_day)::integer
  );
  return target_month + (target_day - 1);
end;
$$;

-- Closed periods remain immutable. Only open purchase payables are recalculated.
update public.accounts_payable payable
set due_date = public.accounts_payable_due_date(
      payable.invoice_date,
      profile.closing_day,
      profile.payment_month_offset,
      profile.payment_day
    ),
    updated_at = now()
from public.accounts_payable_supplier_profiles profile
where profile.supplier_code = payable.supplier_code
  and profile.payment_mode = 'credit'
  and payable.source_type = 'purchase'
  and payable.closing_id is null;

do $$
begin
  if public.accounts_payable_due_date(date '2026-08-15',15::smallint,1::smallint,15::smallint) <> date '2026-08-31' then
    raise exception 'Semi-monthly first-period due date check failed.';
  end if;
  if public.accounts_payable_due_date(date '2026-08-16',15::smallint,1::smallint,15::smallint) <> date '2026-09-15' then
    raise exception 'Semi-monthly second-period due date check failed.';
  end if;
  if public.accounts_payable_due_date(date '2027-02-15',15::smallint,1::smallint,15::smallint) <> date '2027-02-28' then
    raise exception 'Semi-monthly February due date check failed.';
  end if;
  if public.accounts_payable_due_date(date '2026-08-31',31::smallint,1::smallint,31::smallint) <> date '2026-09-30' then
    raise exception 'Monthly due date regression check failed.';
  end if;
end;
$$;

revoke all on function public.accounts_payable_due_date(date,smallint,smallint,smallint)
  from public,anon;
grant execute on function public.accounts_payable_due_date(date,smallint,smallint,smallint)
  to authenticated;

notify pgrst, 'reload schema';

commit;
