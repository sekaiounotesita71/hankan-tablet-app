import type {Trip,Expense,Receipt} from "./travel-core";
export const BUCKET="yumirume-travel-receipts";
type Client=any;
let handler:(path:string,method:string,data?:any)=>Promise<any>;
export function setBackend(fn:typeof handler){handler=fn;}
export async function api(path:string,method="GET",data?:any){if(!handler)throw new Error("ログインを確認しています。");return handler(path,method,data);}
export function receiptUrl(r:Receipt){return r.url||"";}
function checked(r:any){if(r.error){const code=r.error.code||"";if(["42P01","PGRST202","PGRST205"].includes(code))throw new Error("出張・旅費の初期設定がまだ完了していません。管理者に設定を確認してください。");throw new Error(r.error.message||"保存できませんでした。");}return r.data;}
export function mapTrip(t:any):Trip{return {id:t.id,ownerId:t.owner_id,ownerEmail:t.owner_email||"",version:t.version,title:t.title,destination:t.destination,startDate:t.start_date||"",endDate:t.end_date||"",purpose:t.purpose,result:t.result,nextAction:t.next_action,applicant:t.applicant,department:t.department,advance:Number(t.advance),status:t.status,reviewNote:t.review_note||"",createdAt:t.created_at,updatedAt:t.updated_at};}
const mapReceipt=(r:any):Receipt=>({id:r.id,expenseId:r.expense_id,filename:r.filename,mime:r.mime,size:Number(r.size),objectName:r.object_name,url:r.url});
export function createBackend(client:Client,user:{id:string;user_metadata?:any}){
 const versions=new Map<string,number>(),receiptTrips=new Map<string,string>();
 const rpc=async(name:string,args:any)=>checked(await client.rpc(name,args));
 const paged=async(query:()=>any)=>{const out:any[]=[];for(let offset=0;;offset+=500){const data=checked(await query().range(offset,offset+499))||[];out.push(...data);if(data.length<500)return out;}};
 const tripVersion=(id:string)=>{const v=versions.get(id);if(v===undefined)throw new Error("出張を開き直してください。");return v;};
 const setVersion=(id:string,result:any)=>{versions.set(id,result.version);return result;};
 async function tripDetails(id:string){const t=checked(await client.from("travel_trips").select("*").eq("id",id).single());setVersion(id,t);
  const es=await paged(()=>client.from("travel_expenses").select("*").eq("trip_id",id).order("expense_date").order("created_at").order("id"));
  const rs:any[]=[];for(let i=0;i<es.length;i+=100){rs.push(...await paged(()=>client.from("travel_receipts").select("*").in("expense_id",es.slice(i,i+100).map(e=>e.id)).order("id")));}
  if(rs.length){for(let i=0;i<rs.length;i+=100){const slice=rs.slice(i,i+100);const signed=checked(await client.storage.from(BUCKET).createSignedUrls(slice.map(r=>r.object_name),1800));slice.forEach((r,j)=>{if(signed[j]?.error||!signed[j]?.signedUrl)throw new Error("領収書を読み込めません。画面を開き直してください。");r.url=signed[j].signedUrl;receiptTrips.set(r.id,id);});}}
  return {trip:mapTrip(t),expenses:es.map(e=>({id:e.id,tripId:e.trip_id,date:e.expense_date,category:e.category,description:e.description,amount:Number(e.amount),payment:e.payment,receiptStatus:e.receipt_status,note:e.note,receipts:rs.filter(r=>r.expense_id===e.id).map(mapReceipt)}))};
 }
 async function cleanup(names:string[]){if(!names.length)return;const result=await client.storage.from(BUCKET).remove(names);if(result.error)console.warn("Unused travel upload cleanup incomplete");}
 return async(path:string,method="GET",data?:any)=>{
  const p=path.split("/").filter(Boolean);
  if(p[0]==="profile"){
   if(method==="GET"){const r=checked(await client.from("travel_profiles").select("applicant,department").eq("user_id",user.id).maybeSingle());return r||{applicant:user.user_metadata?.full_name||user.user_metadata?.name||"",department:""};}
   return rpc("travel_save_profile",{p_applicant:data.applicant,p_department:data.department});
  }
  if(p[0]==="trips"&&p.length===1){
   if(method==="GET"){const ts=await paged(()=>client.from("travel_trips").select("*").order("updated_at",{ascending:false}).order("id"));ts.forEach(t=>setVersion(t.id,t));return ts.map(mapTrip);}
   const t=await rpc("travel_save_trip",{p_id:null,p_version:null,p_data:data});setVersion(t.id,t);return mapTrip(t);
  }
  if(p[0]==="trips"&&p[1]){
   const id=p[1];
   if(p.length===2){
    if(method==="GET")return tripDetails(id);
    if(method==="PUT"){
     const transition=["submitted","approved","returned","withdraw"].includes(data.status);
     const t=await rpc(transition?"travel_transition":"travel_save_trip",transition?{p_trip_id:id,p_version:data.version,p_action:data.status,p_note:data.reviewNote||""}:{p_id:id,p_version:data.version,p_data:data});setVersion(id,t);return mapTrip(t);
    }
    throw new Error("出張の記録は保管されます。不要な明細は編集・削除してください。");
   }
   if(p[2]==="expenses"){
    if(p.length===3||p.length===4){
     if(method==="DELETE"){const result=await rpc("travel_remove_expense",{p_trip_id:id,p_id:p[3],p_version:tripVersion(id)});setVersion(id,result);await cleanup(result.objects);return {ok:true};}
     const result=await rpc("travel_save_expense",{p_trip_id:id,p_id:p[3]||null,p_version:tripVersion(id),p_data:data});setVersion(id,result);
     const detail=await tripDetails(id);return detail.expenses.find((e:Expense)=>e.id===result.expense.id);
    }
    if(p[4]==="receipts"&&method==="POST"){
     const file=data.get("file") as File;const mime=file.type;
     if(!file.size||file.size>12582912||!["image/jpeg","image/png","image/webp","image/heic","image/heif","application/pdf"].includes(mime))throw new Error("JPEG・PNG・WebP・HEIC・PDF（1件12MB以下）を選んでください。");
     const ext=({"image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/heic":"heic","image/heif":"heif","application/pdf":"pdf"} as Record<string,string>)[mime];
     const objectName=`${user.id}/${id}/${p[3]}/${crypto.randomUUID()}.${ext}`;
     checked(await client.storage.from(BUCKET).upload(objectName,file,{upsert:false,contentType:mime}));
     try{const result=await rpc("travel_add_receipt",{p_trip_id:id,p_expense_id:p[3],p_version:tripVersion(id),p_data:{objectName,filename:file.name.slice(0,240),mime,size:file.size}});setVersion(id,result);return mapReceipt(result.receipt);}catch(error){await cleanup([objectName]);throw error;}
    }
   }
  }
  if(p[0]==="receipts"&&method==="DELETE"){
   const id=receiptTrips.get(p[1]);if(!id)throw new Error("出張を開き直してください。");const result=await rpc("travel_remove_receipt",{p_trip_id:id,p_id:p[1],p_version:tripVersion(id)});setVersion(id,result);await cleanup(result.objects);return {ok:true};
  }
  throw new Error("この操作には対応していません。");
 };
}
