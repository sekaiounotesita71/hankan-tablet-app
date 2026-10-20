-- 出張・旅費申請。既存の社内ユーザー認証を利用。既存の売上・仕入・会計テーブルは変更しない。
begin;
create table if not exists public.travel_profiles (
 user_id uuid primary key references auth.users(id),
 applicant text not null default '' check(length(applicant)<=100),
 department text not null default '' check(length(department)<=150)
);
create table if not exists public.travel_trips (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id),
 owner_email text not null default '',
 title text not null check(length(btrim(title)) between 1 and 120),
 destination text not null default '' check(length(destination)<=300), start_date date, end_date date,
 purpose text not null default '' check(length(purpose)<=3000), result text not null default '' check(length(result)<=6000),
 next_action text not null default '' check(length(next_action)<=3000),
 applicant text not null default '' check(length(applicant)<=100), department text not null default '' check(length(department)<=150),
 advance bigint not null default 0 check(advance between 0 and 100000000),
 status text not null default 'draft' check(status in ('draft','submitted','approved','returned')),
 version integer not null default 1, submitted_at timestamptz, reviewed_at timestamptz,
 reviewed_by uuid references auth.users(id), review_note text not null default '' check(length(review_note)<=1500),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(end_date is null or start_date is null or end_date>=start_date)
);
create index if not exists travel_trips_owner_updated on public.travel_trips(owner_id,updated_at desc);
create index if not exists travel_trips_review_queue on public.travel_trips(status,submitted_at);
create table if not exists public.travel_expenses (
 id uuid primary key default gen_random_uuid(), trip_id uuid not null references public.travel_trips(id),
 expense_date date not null, category text not null check(category in ('交通費','宿泊費','日当','その他')),
 description text not null check(length(btrim(description)) between 1 and 500),
 amount bigint not null check(amount between 0 and 100000000), payment text not null check(payment in ('self','company')),
 receipt_status text not null default 'pending' check(receipt_status in ('pending','not_required','unavailable')),
 note text not null default '' check(length(note)<=1000), created_at timestamptz not null default now(),
 check(receipt_status<>'unavailable' or length(btrim(note))>0)
);
create index if not exists travel_expenses_trip_date on public.travel_expenses(trip_id,expense_date,created_at);
create table if not exists public.travel_receipts (
 id uuid primary key default gen_random_uuid(), expense_id uuid not null references public.travel_expenses(id),
 object_name text not null unique, filename text not null check(length(filename) between 1 and 240),
 mime text not null check(mime in ('image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf')),
 size bigint not null check(size between 1 and 12582912), created_at timestamptz not null default now()
);
create index if not exists travel_receipts_expense on public.travel_receipts(expense_id);
create table if not exists public.travel_events (
 id bigint generated always as identity primary key, trip_id uuid not null references public.travel_trips(id),
 actor_id uuid not null references auth.users(id), action text not null, snapshot jsonb not null,
 created_at timestamptz not null default now()
);
create index if not exists travel_events_trip on public.travel_events(trip_id,created_at);

create or replace function public.travel_can_read(p_trip_id uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select auth.uid() is not null and public.is_internal_user() and exists(
 select 1 from public.travel_trips t where t.id=p_trip_id and
 (t.owner_id=auth.uid() or (public.is_master_admin() and t.status<>'draft')));
$$;
create or replace function public.travel_can_write_object(p_name text) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select auth.uid() is not null and public.is_internal_user()
 and split_part(p_name,'/',1)=auth.uid()::text
 and exists(select 1 from public.travel_trips t where t.id::text=split_part(p_name,'/',2)
 and t.owner_id=auth.uid() and t.status in ('draft','returned'));
$$;
create or replace function public._travel_lock(p_id uuid,p_version integer) returns public.travel_trips
language plpgsql security definer set search_path=public,pg_temp as $$
declare t public.travel_trips;
begin
 if auth.uid() is null or not public.is_internal_user() then raise exception '社内ユーザーでログインしてください。'; end if;
 select * into t from public.travel_trips where id=p_id for update;
 if not found or not public.travel_can_read(p_id) then raise exception '出張を参照できません。'; end if;
 if p_version is null or t.version<>p_version then raise exception '他の画面で更新されています。再読み込みして内容を確認してください。'; end if;
 return t;
end; $$;
create or replace function public._travel_record_event(p_id uuid,p_action text) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare data jsonb;
begin
 select jsonb_build_object('trip',to_jsonb(t),'expenses',coalesce((select jsonb_agg(to_jsonb(e)||jsonb_build_object('receipts',coalesce((select jsonb_agg(to_jsonb(r)) from public.travel_receipts r where r.expense_id=e.id),'[]'::jsonb)) order by e.expense_date,e.created_at) from public.travel_expenses e where e.trip_id=t.id),'[]'::jsonb),
 'total',coalesce((select sum(amount) from public.travel_expenses where trip_id=t.id),0),
 'self',coalesce((select sum(amount) from public.travel_expenses where trip_id=t.id and payment='self'),0),
 'settlement',coalesce((select sum(amount) from public.travel_expenses where trip_id=t.id and payment='self'),0)-t.advance)
 into data from public.travel_trips t where t.id=p_id;
 insert into public.travel_events(trip_id,actor_id,action,snapshot) values(p_id,auth.uid(),p_action,data);
end; $$;
create or replace function public.travel_save_profile(p_applicant text,p_department text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.travel_profiles;
begin
 if auth.uid() is null or not public.is_internal_user() then raise exception '社内ユーザーでログインしてください。'; end if;
 insert into public.travel_profiles(user_id,applicant,department) values(auth.uid(),btrim(coalesce(p_applicant,'')),btrim(coalesce(p_department,'')))
 on conflict(user_id) do update set applicant=excluded.applicant,department=excluded.department returning * into p;
 return to_jsonb(p);
end; $$;
create or replace function public.travel_save_trip(p_id uuid,p_version integer,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare t public.travel_trips; v_start date; v_end date; v_advance numeric;
begin
 if auth.uid() is null or not public.is_internal_user() then raise exception '社内ユーザーでログインしてください。'; end if;
 v_start:=nullif(p_data->>'startDate','')::date; v_end:=nullif(p_data->>'endDate','')::date;
 v_advance:=coalesce(nullif(p_data->>'advance','')::numeric,0);
 if v_advance<>trunc(v_advance) then raise exception '金額は整数で入力してください。'; end if;
 if p_id is null then
  insert into public.travel_trips(owner_id,owner_email,title) values(auth.uid(),coalesce((select email from auth.users where id=auth.uid()),''),coalesce(nullif(btrim(p_data->>'title'),''),'新しい出張')) returning * into t;
 else
  t:=public._travel_lock(p_id,p_version);
  if t.owner_id<>auth.uid() or t.status not in ('draft','returned') then raise exception '本人の下書き・差戻しのみ編集できます。'; end if;
 end if;
 update public.travel_trips set title=coalesce(nullif(btrim(p_data->>'title'),''),'新しい出張'),destination=btrim(coalesce(p_data->>'destination','')),
 start_date=v_start,end_date=v_end,purpose=btrim(coalesce(p_data->>'purpose','')),result=btrim(coalesce(p_data->>'result','')),
 next_action=btrim(coalesce(p_data->>'nextAction','')),applicant=btrim(coalesce(p_data->>'applicant','')),department=btrim(coalesce(p_data->>'department','')),
 advance=v_advance::bigint,status='draft',version=version+1,updated_at=now() where id=t.id returning * into t;
 perform public._travel_record_event(t.id,'save'); return to_jsonb(t);
end; $$;
create or replace function public.travel_save_expense(p_trip_id uuid,p_id uuid,p_version integer,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare t public.travel_trips; e public.travel_expenses; v_amount numeric;
begin
 t:=public._travel_lock(p_trip_id,p_version);
 if t.owner_id<>auth.uid() or t.status not in ('draft','returned') then raise exception '本人の下書き・差戻しのみ編集できます。'; end if;
 v_amount:=(p_data->>'amount')::numeric;
 if v_amount is null or v_amount<>trunc(v_amount) then raise exception '金額は整数で入力してください。'; end if;
 if p_id is not null then
  select * into e from public.travel_expenses where id=p_id and trip_id=t.id;
  if not found then raise exception '旅費が見つかりません。'; end if;
 else
  e.id:=gen_random_uuid();
 end if;
 insert into public.travel_expenses(id,trip_id,expense_date,category,description,amount,payment,receipt_status,note)
 values(e.id,t.id,(p_data->>'date')::date,p_data->>'category',btrim(p_data->>'description'),v_amount::bigint,p_data->>'payment',p_data->>'receiptStatus',btrim(coalesce(p_data->>'note','')))
 on conflict(id) do update set expense_date=excluded.expense_date,category=excluded.category,description=excluded.description,amount=excluded.amount,payment=excluded.payment,receipt_status=excluded.receipt_status,note=excluded.note returning * into e;
 update public.travel_trips set status='draft',version=version+1,updated_at=now() where id=t.id returning * into t;
 perform public._travel_record_event(t.id,'expense_save'); return jsonb_build_object('expense',to_jsonb(e),'version',t.version);
end; $$;
create or replace function public.travel_remove_expense(p_trip_id uuid,p_id uuid,p_version integer) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare t public.travel_trips; paths jsonb;
begin
 t:=public._travel_lock(p_trip_id,p_version);
 if t.owner_id<>auth.uid() or t.status not in ('draft','returned') then raise exception '本人の下書き・差戻しのみ編集できます。'; end if;
 if not exists(select 1 from public.travel_expenses where id=p_id and trip_id=t.id) then raise exception '旅費が見つかりません。'; end if;
 select coalesce(jsonb_agg(object_name),'[]'::jsonb) into paths from public.travel_receipts where expense_id=p_id;
 delete from public.travel_receipts where expense_id=p_id; delete from public.travel_expenses where id=p_id;
 update public.travel_trips set status='draft',version=version+1,updated_at=now() where id=t.id returning * into t;
 perform public._travel_record_event(t.id,'expense_remove'); return jsonb_build_object('version',t.version,'objects',paths);
end; $$;
create or replace function public.travel_add_receipt(p_trip_id uuid,p_expense_id uuid,p_version integer,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare t public.travel_trips; r public.travel_receipts; object_path text;
begin
 t:=public._travel_lock(p_trip_id,p_version);
 if t.owner_id<>auth.uid() or t.status not in ('draft','returned') then raise exception '本人の下書き・差戻しのみ編集できます。'; end if;
 if not exists(select 1 from public.travel_expenses where id=p_expense_id and trip_id=t.id) then raise exception '旅費が見つかりません。'; end if;
 if (select count(*) from public.travel_receipts where expense_id=p_expense_id)>=10 then raise exception '領収書は1明細10件までです。'; end if;
 object_path:=p_data->>'objectName';
 if split_part(object_path,'/',1)<>auth.uid()::text or split_part(object_path,'/',2)<>t.id::text or split_part(object_path,'/',3)<>p_expense_id::text or length(split_part(object_path,'/',4))<1 or split_part(object_path,'/',5)<>'' then raise exception '領収書の保存先が不正です。'; end if;
 if not exists(select 1 from storage.objects where bucket_id='yumirume-travel-receipts' and name=object_path) then raise exception '領収書のアップロードを確認できません。'; end if;
 insert into public.travel_receipts(expense_id,object_name,filename,mime,size) values(p_expense_id,object_path,p_data->>'filename',p_data->>'mime',(p_data->>'size')::bigint) returning * into r;
 update public.travel_trips set status='draft',version=version+1,updated_at=now() where id=t.id returning * into t;
 perform public._travel_record_event(t.id,'receipt_add'); return jsonb_build_object('receipt',to_jsonb(r),'version',t.version);
end; $$;
create or replace function public.travel_remove_receipt(p_trip_id uuid,p_id uuid,p_version integer) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare t public.travel_trips; r public.travel_receipts;
begin
 t:=public._travel_lock(p_trip_id,p_version);
 if t.owner_id<>auth.uid() or t.status not in ('draft','returned') then raise exception '本人の下書き・差戻しのみ編集できます。'; end if;
 select r0.* into r from public.travel_receipts r0 join public.travel_expenses e on e.id=r0.expense_id where r0.id=p_id and e.trip_id=t.id;
 if not found then raise exception '領収書が見つかりません。'; end if;
 delete from public.travel_receipts where id=r.id;
 update public.travel_trips set status='draft',version=version+1,updated_at=now() where id=t.id returning * into t;
 perform public._travel_record_event(t.id,'receipt_remove'); return jsonb_build_object('version',t.version,'objects',jsonb_build_array(r.object_name));
end; $$;
create or replace function public.travel_transition(p_trip_id uuid,p_version integer,p_action text,p_note text default '') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare t public.travel_trips;
begin
 t:=public._travel_lock(p_trip_id,p_version);
 if p_action='submitted' then
  if t.owner_id<>auth.uid() or t.status not in ('draft','returned') then raise exception '本人の下書き・差戻しのみ申請できます。'; end if;
  if t.start_date is null or t.end_date is null or btrim(t.applicant)='' or btrim(t.destination)='' or btrim(t.purpose)='' or btrim(t.result)='' then raise exception '申請者・日程・訪問先・目的・結果を入力してください。'; end if;
  if exists(select 1 from public.travel_expenses e where e.trip_id=t.id and e.receipt_status='pending' and not exists(select 1 from public.travel_receipts r where r.expense_id=e.id)) then raise exception '未添付の領収書を確認してください。'; end if;
  update public.travel_trips set status='submitted',submitted_at=now(),reviewed_at=null,reviewed_by=null,review_note='',version=version+1,updated_at=now() where id=t.id returning * into t;
 elsif p_action='withdraw' then
  if t.owner_id<>auth.uid() or t.status<>'submitted' then raise exception '本人の申請中の出張のみ取り下げられます。'; end if;
  update public.travel_trips set status='draft',version=version+1,updated_at=now() where id=t.id returning * into t;
 elsif p_action in ('approved','returned') then
  if not public.is_master_admin() or t.owner_id=auth.uid() or t.status<>'submitted' then raise exception '他の従業員の申請中データを管理者が確認してください。'; end if;
  if p_action='returned' and length(btrim(coalesce(p_note,'')))=0 then raise exception '差戻し理由を入力してください。'; end if;
  update public.travel_trips set status=p_action,reviewed_at=now(),reviewed_by=auth.uid(),review_note=btrim(coalesce(p_note,'')),version=version+1,updated_at=now() where id=t.id returning * into t;
 else raise exception '申請の操作が不正です。'; end if;
 perform public._travel_record_event(t.id,p_action); return to_jsonb(t);
end; $$;

alter table public.travel_profiles enable row level security;
alter table public.travel_trips enable row level security;
alter table public.travel_expenses enable row level security;
alter table public.travel_receipts enable row level security;
alter table public.travel_events enable row level security;
drop policy if exists travel_profiles_read on public.travel_profiles;
create policy travel_profiles_read on public.travel_profiles for select to authenticated using(user_id=auth.uid() and public.is_internal_user());
drop policy if exists travel_trips_read on public.travel_trips;
create policy travel_trips_read on public.travel_trips for select to authenticated using(public.travel_can_read(id));
drop policy if exists travel_expenses_read on public.travel_expenses;
create policy travel_expenses_read on public.travel_expenses for select to authenticated using(public.travel_can_read(trip_id));
drop policy if exists travel_receipts_read on public.travel_receipts;
create policy travel_receipts_read on public.travel_receipts for select to authenticated using(exists(select 1 from public.travel_expenses e where e.id=expense_id and public.travel_can_read(e.trip_id)));
drop policy if exists travel_events_read on public.travel_events;
create policy travel_events_read on public.travel_events for select to authenticated using(public.travel_can_read(trip_id));
revoke all on public.travel_profiles,public.travel_trips,public.travel_expenses,public.travel_receipts,public.travel_events from public,anon,authenticated;
grant select on public.travel_profiles,public.travel_trips,public.travel_expenses,public.travel_receipts,public.travel_events to authenticated;
-- 書き込みはRPCのみ。owner_id・承認状態・履歴をクライアントから直接変更させない。
revoke all on function public._travel_lock(uuid,integer),public._travel_record_event(uuid,text) from public,anon,authenticated;
revoke all on function public.travel_can_read(uuid),public.travel_can_write_object(text),public.travel_save_profile(text,text),public.travel_save_trip(uuid,integer,jsonb),public.travel_save_expense(uuid,uuid,integer,jsonb),public.travel_remove_expense(uuid,uuid,integer),public.travel_add_receipt(uuid,uuid,integer,jsonb),public.travel_remove_receipt(uuid,uuid,integer),public.travel_transition(uuid,integer,text,text) from public,anon;
grant execute on function public.travel_can_read(uuid),public.travel_can_write_object(text),public.travel_save_profile(text,text),public.travel_save_trip(uuid,integer,jsonb),public.travel_save_expense(uuid,uuid,integer,jsonb),public.travel_remove_expense(uuid,uuid,integer),public.travel_add_receipt(uuid,uuid,integer,jsonb),public.travel_remove_receipt(uuid,uuid,integer),public.travel_transition(uuid,integer,text,text) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('yumirume-travel-receipts','yumirume-travel-receipts',false,12582912,array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf']) on conflict(id) do nothing;
do $$ begin if exists(select 1 from storage.buckets where id='yumirume-travel-receipts' and public) then raise exception '旅費領収書のバケットが公開設定です。非公開設定を確認してください。'; end if; end $$;
drop policy if exists travel_object_read on storage.objects;
-- Storageの削除にはSELECTも必要。編集中の本人には、登録前・削除後の一時原本も片付けられるようにする。
create policy travel_object_read on storage.objects for select to authenticated using(bucket_id='yumirume-travel-receipts' and (public.travel_can_write_object(name) or exists(select 1 from public.travel_receipts r join public.travel_expenses e on e.id=r.expense_id where r.object_name=name and public.travel_can_read(e.trip_id))));
drop policy if exists travel_object_upload on storage.objects;
create policy travel_object_upload on storage.objects for insert to authenticated with check(bucket_id='yumirume-travel-receipts' and public.travel_can_write_object(name));
drop policy if exists travel_object_remove on storage.objects;
create policy travel_object_remove on storage.objects for delete to authenticated using(bucket_id='yumirume-travel-receipts' and public.travel_can_write_object(name));
-- 上書きのUPDATEポリシーは設けない。承認済みの原本を差し替えられないよう新規パスへ保存する。
commit;
