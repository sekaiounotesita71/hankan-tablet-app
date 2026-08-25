-- 仕入・買掛のJPY金額を、販売側と同じ「明細ごとに四捨五入してから合計」に統一します。
-- 数量と単価の小数は保持し、金額だけを1円単位にします。
-- 締め済み、または手動支払済みの過去伝票は変更せず、会計確定値を保護します。

begin;

create or replace function public.normalize_purchase_receipt_line_jpy_amount()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.actual_qty is not null and new.unit_price is not null then
      new.line_amount := round(new.actual_qty * new.unit_price, 0);
    else
      new.line_amount := round(coalesce(new.line_amount, 0), 0);
    end if;
  elsif new.actual_qty is distinct from old.actual_qty
     or new.unit_price is distinct from old.unit_price then
    if new.actual_qty is not null and new.unit_price is not null then
      new.line_amount := round(new.actual_qty * new.unit_price, 0);
    else
      new.line_amount := round(coalesce(new.line_amount, 0), 0);
    end if;
  else
    new.line_amount := round(coalesce(new.line_amount, 0), 0);
  end if;
  return new;
end;
$$;

create or replace trigger trg_normalize_purchase_receipt_line_jpy_amount
before insert or update of actual_qty,unit_price,line_amount
on public.purchase_receipt_lines
for each row execute function public.normalize_purchase_receipt_line_jpy_amount();

create or replace function public.prepare_purchase_receipt_totals()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.subtotal := round(coalesce(new.subtotal, 0), 0);
  new.shipping_fee := round(coalesce(new.shipping_fee, 0), 0);
  new.other_fee := round(coalesce(new.other_fee, 0), 0);

  if not new.tax_override then
    new.tax_amount := public.purchase_receipt_calculated_tax(new.id);
  else
    new.tax_amount := round(coalesce(new.tax_amount, 0), 0);
  end if;

  new.total_amount := new.subtotal
    + new.shipping_fee
    + new.other_fee
    + new.tax_amount;
  return new;
end;
$$;

create or replace function public.refresh_purchase_receipt_from_lines(p_receipt_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  calculated_subtotal numeric;
begin
  select coalesce(sum(round(line.line_amount, 0)), 0)
  into calculated_subtotal
  from public.purchase_receipt_lines line
  where line.receipt_id = p_receipt_id;

  update public.purchase_receipts
  set subtotal = round(calculated_subtotal, 0),
      updated_at = now()
  where id = p_receipt_id;
end;
$$;

create or replace function public.normalize_accounts_payable_jpy_amount()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.subtotal_jpy := round(coalesce(new.subtotal_jpy, 0), 0);
  new.shipping_amount_jpy := round(coalesce(new.shipping_amount_jpy, 0), 0);
  new.other_amount_jpy := round(coalesce(new.other_amount_jpy, 0), 0);
  new.tax_amount_jpy := round(coalesce(new.tax_amount_jpy, 0), 0);
  new.adjustment_amount_jpy := round(coalesce(new.adjustment_amount_jpy, 0), 0);

  if new.source_type = 'purchase' then
    new.amount_jpy := new.subtotal_jpy
      + new.shipping_amount_jpy
      + new.other_amount_jpy
      + new.tax_amount_jpy
      + new.adjustment_amount_jpy;
  else
    new.amount_jpy := round(coalesce(new.amount_jpy, 0), 0);
  end if;
  return new;
end;
$$;

create or replace trigger trg_normalize_accounts_payable_jpy_amount
before insert or update on public.accounts_payable
for each row execute function public.normalize_accounts_payable_jpy_amount();

-- 現在修正可能な仕入だけを補正対象にします。
create or replace function public.purchase_receipt_jpy_rounding_eligible(p_receipt_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.purchase_receipts receipt
    left join public.accounts_payable payable
      on payable.id = receipt.accounts_payable_id
    where receipt.id = p_receipt_id
      and (
        receipt.accounts_payable_id is null
        or (
          payable.id is not null
          and payable.closing_id is null
          and not exists (
            select 1
            from public.accounts_payable_closings closing
            where closing.status = 'closed'
              and closing.supplier_code = payable.supplier_code
              and payable.invoice_date between closing.period_from and closing.period_to
          )
          and not exists (
            select 1
            from public.accounts_payable_payments payment
            where payment.payable_id = payable.id
              and coalesce(payment.source_key, '') <> 'cash-purchase:' || payable.id::text
          )
        )
      )
  );
$$;

select set_config('app.purchase_correction', 'on', true);

update public.purchase_receipt_lines line
set line_amount = round(line.line_amount, 0),
    updated_at = now()
where public.purchase_receipt_jpy_rounding_eligible(line.receipt_id)
  and line.line_amount is distinct from round(line.line_amount, 0);

with eligible as (
  select receipt.id
  from public.purchase_receipts receipt
  where public.purchase_receipt_jpy_rounding_eligible(receipt.id)
), totals as (
  select
    eligible.id,
    coalesce(sum(round(line.line_amount, 0)), 0) as subtotal
  from eligible
  left join public.purchase_receipt_lines line
    on line.receipt_id = eligible.id
  group by eligible.id
)
update public.purchase_receipts receipt
set subtotal = totals.subtotal,
    shipping_fee = round(receipt.shipping_fee, 0),
    other_fee = round(receipt.other_fee, 0),
    tax_amount = case
      when receipt.tax_override then round(receipt.tax_amount, 0)
      else public.purchase_receipt_calculated_tax(receipt.id)
    end,
    updated_at = now()
from totals
where receipt.id = totals.id
  and (
    receipt.subtotal is distinct from totals.subtotal
    or receipt.shipping_fee is distinct from round(receipt.shipping_fee, 0)
    or receipt.other_fee is distinct from round(receipt.other_fee, 0)
    or receipt.tax_amount is distinct from case
      when receipt.tax_override then round(receipt.tax_amount, 0)
      else public.purchase_receipt_calculated_tax(receipt.id)
    end
    or receipt.total_amount is distinct from totals.subtotal
      + round(receipt.shipping_fee, 0)
      + round(receipt.other_fee, 0)
      + case
        when receipt.tax_override then round(receipt.tax_amount, 0)
        else public.purchase_receipt_calculated_tax(receipt.id)
      end
  );

-- 未締めかつ手動支払のない買掛だけを、丸め後の仕入伝票から再集計します。
with totals as (
  select
    payable.id,
    coalesce(sum(receipt.subtotal), 0) as subtotal,
    coalesce(sum(receipt.shipping_fee), 0) as shipping,
    coalesce(sum(receipt.other_fee), 0) as other_fee,
    coalesce(sum(receipt.tax_amount), 0) as tax,
    coalesce(sum(receipt.total_amount), 0) as total,
    min(receipt.purchase_date) as period_from,
    max(receipt.purchase_date) as period_to
  from public.accounts_payable payable
  join public.purchase_receipts receipt
    on receipt.accounts_payable_id = payable.id
  where payable.source_type = 'purchase'
    and payable.closing_id is null
    and public.purchase_receipt_jpy_rounding_eligible(receipt.id)
  group by payable.id
)
update public.accounts_payable payable
set subtotal_jpy = totals.subtotal,
    shipping_amount_jpy = totals.shipping,
    other_amount_jpy = totals.other_fee,
    tax_amount_jpy = totals.tax,
    amount_jpy = totals.total + round(payable.adjustment_amount_jpy, 0),
    period_from = totals.period_from,
    period_to = totals.period_to,
    updated_at = now()
from totals
where payable.id = totals.id;

-- 都度現金払いの自動支払だけは、補正後の買掛金額へ追随させます。
update public.accounts_payable_payments payment
set amount_jpy = payable.amount_jpy,
    updated_at = now()
from public.accounts_payable payable
where payment.payable_id = payable.id
  and payment.source_key = 'cash-purchase:' || payable.id::text
  and payment.amount_jpy is distinct from payable.amount_jpy;

revoke all on function public.normalize_purchase_receipt_line_jpy_amount()
  from public, anon, authenticated;
revoke all on function public.prepare_purchase_receipt_totals()
  from public, anon, authenticated;
revoke all on function public.refresh_purchase_receipt_from_lines(uuid)
  from public, anon, authenticated;
revoke all on function public.normalize_accounts_payable_jpy_amount()
  from public, anon, authenticated;
revoke all on function public.purchase_receipt_jpy_rounding_eligible(uuid)
  from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;

select
  (
    select count(*)
    from public.purchase_receipt_lines
    where line_amount <> round(line_amount, 0)
  ) as protected_purchase_lines_with_fraction,
  (
    select count(*)
    from public.purchase_receipts
    where subtotal <> round(subtotal, 0)
       or shipping_fee <> round(shipping_fee, 0)
       or other_fee <> round(other_fee, 0)
       or tax_amount <> round(tax_amount, 0)
       or total_amount <> round(total_amount, 0)
  ) as protected_purchase_receipts_with_fraction,
  (
    select count(*)
    from public.accounts_payable
    where source_type = 'purchase'
      and closing_id is null
      and (
        subtotal_jpy <> round(subtotal_jpy, 0)
        or shipping_amount_jpy <> round(shipping_amount_jpy, 0)
        or other_amount_jpy <> round(other_amount_jpy, 0)
        or tax_amount_jpy <> round(tax_amount_jpy, 0)
        or adjustment_amount_jpy <> round(adjustment_amount_jpy, 0)
        or amount_jpy <> round(amount_jpy, 0)
      )
  ) as open_purchase_payables_with_fraction;
