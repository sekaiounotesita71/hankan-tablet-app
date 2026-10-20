const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const {PGlite}=require(process.env.PGLITE_PATH||'@electric-sql/pglite');
const sql=fs.readFileSync(path.join(__dirname,'..','travel-expenses-migration.sql'),'utf8');
const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function setup(){const db=new PGlite();await db.exec(`
 create role anon;create role authenticated;create schema auth;create schema storage;
 create table auth.users(id uuid primary key,email text);insert into auth.users(id) values('${uid(1)}'),('${uid(2)}'),('${uid(3)}'),('${uid(4)}');update auth.users set email=id::text||'@example.invalid';
 create table public.test_access(id uuid primary key,staff boolean,admin boolean);
 insert into public.test_access values('${uid(1)}',true,false),('${uid(2)}',true,false),('${uid(3)}',false,false),('${uid(4)}',true,true);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function public.is_internal_user() returns boolean language sql stable security definer as $$select coalesce((select staff from public.test_access where id=auth.uid()),false)$$;
 create function public.is_master_admin() returns boolean language sql stable security definer as $$select coalesce((select admin from public.test_access where id=auth.uid()),false)$$;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,unique(bucket_id,name));
 alter table storage.objects enable row level security;grant usage on schema auth,storage to authenticated;grant select,insert,delete on storage.objects to authenticated;
 `);await db.exec(sql);await db.exec(sql);return db;}
async function actor(db,n){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[n?uid(n):'']);await db.exec('set role authenticated');}
async function rpc(db,name,args){const ps=args.map((_,i)=>`$${i+1}`).join(',');const r=await db.query(`select public.${name}(${ps}) as value`,args.map(a=>a&&typeof a==='object'?JSON.stringify(a):a));return r.rows[0].value;}
const tripData={title:'大阪商談',destination:'大阪／テスト訪問先',startDate:'2026-10-20',endDate:'2026-10-21',purpose:'商談',result:'導入に合意',nextAction:'見積送付',applicant:'社員A',department:'営業',advance:10000};
const expenseData={date:'2026-10-20',category:'交通費',description:'東京→新大阪',amount:14720,payment:'self',receiptStatus:'not_required',note:''};
test('従業員の分離・管理者の承認・証憑の保護・更新競合・申請時点の金額を実DBで検証',async()=>{
 const db=await setup();try{
  await actor(db,1);let t=await rpc(db,'travel_save_trip',[null,null,{...tripData,owner_email:'forged@example.invalid'}]);const id=t.id;assert.equal(t.owner_email,uid(1)+'@example.invalid');
  let e=await rpc(db,'travel_save_expense',[id,null,t.version,expenseData]);t.version=e.version;const eid=e.expense.id;
  const company=await rpc(db,'travel_save_expense',[id,null,t.version,{...expenseData,category:'宿泊費',amount:11000,payment:'company'}]);t.version=company.version;
  await assert.rejects(rpc(db,'travel_save_trip',[id,t.version-1,tripData]),/他の画面/);
  await assert.rejects(db.exec(`update public.travel_trips set owner_id='${uid(2)}' where id='${id}'`),/permission denied/);
  const objectName=`${uid(1)}/${id}/${eid}/test.png`;
  await db.query('insert into storage.objects(bucket_id,name) values($1,$2)',['yumirume-travel-receipts',objectName]);
  let r=await rpc(db,'travel_add_receipt',[id,eid,t.version,{objectName,filename:'領収書.png',mime:'image/png',size:100}]);t.version=r.version;
  assert.equal((await db.query('select * from storage.objects')).rows.length,1);
  await actor(db,2);assert.equal((await db.query('select * from public.travel_trips')).rows.length,0);assert.equal((await db.query('select * from public.travel_expenses')).rows.length,0);assert.equal((await db.query('select * from public.travel_receipts')).rows.length,0);assert.equal((await db.query('select * from storage.objects')).rows.length,0);
  await assert.rejects(rpc(db,'travel_save_trip',[id,t.version,tripData]),/参照できません/);
  await actor(db,4);assert.equal((await db.query('select * from public.travel_trips')).rows.length,0,'管理者にも他人の下書きを見せない');
  await actor(db,1);t=await rpc(db,'travel_transition',[id,t.version,'submitted','']);
  await assert.rejects(rpc(db,'travel_save_expense',[id,eid,t.version,expenseData]),/下書き・差戻し/);
  await assert.rejects(db.query('insert into storage.objects(bucket_id,name) values($1,$2)',['yumirume-travel-receipts',`${uid(1)}/${id}/${eid}/changed.png`]),/row-level security/);
  assert.equal((await db.query('delete from storage.objects returning *')).rows.length,0,'申請中の領収書は消せない');
  await actor(db,4);assert.equal((await db.query('select * from public.travel_trips')).rows.length,1);
  assert.equal((await db.query('select * from storage.objects')).rows.length,1);
  await assert.rejects(rpc(db,'travel_transition',[id,t.version,'returned','']),/理由/);
  t=await rpc(db,'travel_transition',[id,t.version,'returned','領収書を確認してください']);
  await actor(db,1);assert.equal(t.review_note,'領収書を確認してください');
  t=await rpc(db,'travel_save_trip',[id,t.version,{...tripData,result:'領収書確認済み'}]);assert.equal(t.status,'draft');
  t=await rpc(db,'travel_transition',[id,t.version,'submitted','']);
  await actor(db,4);t=await rpc(db,'travel_transition',[id,t.version,'approved','確認済み']);assert.equal(t.reviewed_by,uid(4));
  const events=(await db.query("select * from public.travel_events where action='approved'")).rows;assert.equal(events.length,1);assert.equal(events[0].snapshot.total,25720);assert.equal(events[0].snapshot.self,14720);assert.equal(events[0].snapshot.settlement,4720);assert.equal(events[0].snapshot.expenses.length,2);
  await actor(db,1);await assert.rejects(rpc(db,'travel_save_trip',[id,t.version,tripData]),/下書き・差戻し/);
  await assert.rejects(db.exec("delete from public.travel_events"),/permission denied/);
  await actor(db,3);assert.equal((await db.query('select * from public.travel_trips')).rows.length,0);await assert.rejects(rpc(db,'travel_save_trip',[null,null,tripData]),/社内ユーザー/);
  await db.exec('reset role;set role anon');await assert.rejects(db.query('select * from public.travel_trips'),/permission denied/);await assert.rejects(rpc(db,'travel_save_trip',[null,null,tripData]),/permission denied/);
 }finally{await db.close();}
});
test('未入力・未確認領収書・小数金額・自己承認を拒否し、申請取下げを可能にする',async()=>{
 const db=await setup();try{
  await actor(db,1);let t=await rpc(db,'travel_save_trip',[null,null,{...tripData,result:''}]);
  await assert.rejects(rpc(db,'travel_transition',[t.id,t.version,'submitted','']),/入力/);
  t=await rpc(db,'travel_save_trip',[t.id,t.version,tripData]);
  await assert.rejects(rpc(db,'travel_save_expense',[t.id,null,t.version,{...expenseData,amount:1.5}]),/整数/);
  const e=await rpc(db,'travel_save_expense',[t.id,null,t.version,{...expenseData,receiptStatus:'pending'}]);t.version=e.version;
  await assert.rejects(rpc(db,'travel_transition',[t.id,t.version,'submitted','']),/未添付/);
  const e2=await rpc(db,'travel_save_expense',[t.id,e.expense.id,t.version,expenseData]);t.version=e2.version;
  t=await rpc(db,'travel_transition',[t.id,t.version,'submitted','']);t=await rpc(db,'travel_transition',[t.id,t.version,'withdraw','']);assert.equal(t.status,'draft');
  await actor(db,4);let own=await rpc(db,'travel_save_trip',[null,null,tripData]);own=await rpc(db,'travel_transition',[own.id,own.version,'submitted','']);await assert.rejects(rpc(db,'travel_transition',[own.id,own.version,'approved','']),/他の従業員/);
 }finally{await db.close();}
});

test('編集中の本人は登録失敗・添付削除後の原本を片付けられ、他人は参照できない',async()=>{
 const db=await setup();try{
  await actor(db,1);let t=await rpc(db,'travel_save_trip',[null,null,tripData]);
  const e=await rpc(db,'travel_save_expense',[t.id,null,t.version,expenseData]);t.version=e.version;
  const objectName=`${uid(1)}/${t.id}/${e.expense.id}/cleanup.png`;
  await db.query('insert into storage.objects(bucket_id,name) values($1,$2)',['yumirume-travel-receipts',objectName]);
  assert.equal((await db.query('select * from storage.objects')).rows.length,1,'登録前の本人原本');
  await actor(db,2);assert.equal((await db.query('select * from storage.objects')).rows.length,0);
  assert.equal((await db.query('delete from storage.objects returning *')).rows.length,0);
  await actor(db,1);let r=await rpc(db,'travel_add_receipt',[t.id,e.expense.id,t.version,{objectName,filename:'領収書.png',mime:'image/png',size:100}]);
  const removed=await rpc(db,'travel_remove_receipt',[t.id,r.receipt.id,r.version]);assert.deepEqual(removed.objects,[objectName]);
  assert.equal((await db.query('delete from storage.objects returning *')).rows.length,1,'メタデータ削除後も原本削除ができる');
 }finally{await db.close();}
});
