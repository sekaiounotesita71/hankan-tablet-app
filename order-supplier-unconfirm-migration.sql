-- Allow internal users to return a confirmed supplier decision to provisional.

begin;

create or replace function public.unconfirm_order_supplier_review(
  p_line_ids uuid[]
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
    if line_row.supplier_decision_status <> 'confirmed' then
      continue;
    end if;

    if exists (
      select 1
      from public.external_work_assignment_lines assignment_line
      join public.external_work_assignments assignment on assignment.id = assignment_line.assignment_id
      where assignment_line.order_line_id = line_row.id
        and assignment_line.active
        and assignment.status not in ('draft','cancelled','returned')
    ) then
      raise exception 'External work has already been published for order line %.',line_row.id;
    end if;

    insert into public.order_supplier_review_log (
      order_line_id,action,old_supplier_code,new_supplier_code,
      old_decision_status,new_decision_status,
      old_purchase_ordered,new_purchase_ordered,created_by
    ) values (
      line_row.id,'supplier_unconfirm',
      line_row.supplier_code,line_row.supplier_code,
      line_row.supplier_decision_status,'provisional',
      line_row.purchase_ordered,false,auth.uid()
    );

    update public.order_entry_lines
    set supplier_decision_status = 'provisional',
        supplier_confirmed_at = null,
        supplier_confirmed_by = null,
        purchase_ordered = false,
        purchase_ordered_at = null,
        purchase_ordered_by = null,
        updated_at = now()
    where id = line_row.id;

    changed_count := changed_count + 1;
  end loop;

  return changed_count;
end;
$$;

revoke all on function public.unconfirm_order_supplier_review(uuid[]) from public, anon;
grant execute on function public.unconfirm_order_supplier_review(uuid[]) to authenticated;

notify pgrst, 'reload schema';

commit;
