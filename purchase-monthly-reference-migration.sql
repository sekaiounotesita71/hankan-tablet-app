begin;

alter table public.supplier_master
  add column if not exists purchase_reference_mode text not null default 'day';

update public.supplier_master
set purchase_reference_mode = 'day'
where purchase_reference_mode is null
   or purchase_reference_mode not in ('day','month');

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'supplier_master_purchase_reference_mode_check'
  ) then
    alter table public.supplier_master
      add constraint supplier_master_purchase_reference_mode_check
      check (purchase_reference_mode in ('day','month'));
  end if;
end $$;

comment on column public.supplier_master.purchase_reference_mode is
  'Default sales reference period for purchase entry: day or month';

commit;
