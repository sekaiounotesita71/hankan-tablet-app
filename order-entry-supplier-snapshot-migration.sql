-- Order entry lines keep the supplier code/name that was used when the order was confirmed.
-- Current supplier-master membership must not invalidate historical, imported, or legacy orders.
do $$
declare
  r record;
begin
  if to_regclass('public.order_entry_lines') is null then
    return;
  end if;

  for r in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.order_entry_lines'::regclass
      and c.contype = 'f'
      and (
        c.conname = 'order_entry_lines_supplier_code_fkey'
        or (
          to_regclass('public.supplier_master') is not null
          and c.confrelid = to_regclass('public.supplier_master')
        )
        or (
          to_regclass('public.supplier_master_unified') is not null
          and c.confrelid = to_regclass('public.supplier_master_unified')
        )
      )
  loop
    execute format(
      'alter table public.order_entry_lines drop constraint if exists %I',
      r.conname
    );
  end loop;
end $$;
