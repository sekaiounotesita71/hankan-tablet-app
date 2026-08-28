-- Disable inventory tracking for purchase entry while preserving historical lots.
-- Run after site-partner-purchase-migration.sql.

begin;

alter table public.purchase_receipt_lines
  alter column track_inventory set default false;

-- Existing purchase and payable records remain intact. Only the now-unused flag is disabled.
select set_config('app.purchase_correction','on',true);
update public.purchase_receipt_lines
set track_inventory = false
where track_inventory is distinct from false;

create or replace function public.force_purchase_inventory_disabled()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.track_inventory := false;
  return new;
end;
$$;

drop trigger if exists trg_force_purchase_inventory_disabled
  on public.purchase_receipt_lines;
create trigger trg_force_purchase_inventory_disabled
before insert or update of track_inventory on public.purchase_receipt_lines
for each row execute function public.force_purchase_inventory_disabled();

notify pgrst, 'reload schema';

commit;
