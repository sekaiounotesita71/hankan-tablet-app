-- Let administrators delete only unfinalized work sessions created by mistake.

begin;

create or replace function public.delete_unfinalized_work_session(
  p_session_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_session public.work_sessions;
begin
  if not public.is_master_admin() then
    raise exception 'Only administrators can delete work sessions.' using errcode = '42501';
  end if;

  select session.*
  into target_session
  from public.work_sessions session
  where session.id = p_session_id
  for update;

  if target_session.id is null then
    raise exception 'Work session not found.';
  end if;

  if coalesce(target_session.locked,false)
     or target_session.status = 'closed'
     or target_session.finalized_at is not null
     or exists (
       select 1
       from public.sales_records record
       where record.session_id = target_session.id
     )
  then
    raise exception 'Finalized work sessions cannot be deleted. Use the sales-correction workflow.';
  end if;

  delete from public.work_sessions
  where id = target_session.id;

  return found;
end;
$$;

revoke all on function public.delete_unfinalized_work_session(uuid) from public, anon;
grant execute on function public.delete_unfinalized_work_session(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
