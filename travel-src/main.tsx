import {createRoot} from "react-dom/client";
import TravelApp from "./travel-ui";
import {createBackend,setBackend} from "./travel-api";
declare global {interface Window{YumirumeTravelConfig:{url:string;anonKey:string};supabase:any;}}
const root=createRoot(document.getElementById("travel-root")!);
const loginHref="./order-entry-beta.html#home";
function message(title:string,text:string){root.render(<main className="login-screen"><h1>{title}</h1><p role="status">{text}</p><a className="primary" href={loginHref}>業務アプリへ戻る</a><small>ゆみるめ業務アプリ ／ 出張・旅費</small></main>);}
async function boot(){
 const config=window.YumirumeTravelConfig;
 if(!window.supabase||!config?.url||!config?.anonKey){message("出張・旅費","認証サービスを読み込めません。通信状況を確認し、ページを開き直してください。");return;}
 const client=window.supabase.createClient(config.url,config.anonKey);
 let mountedId:string|null=null;
 async function start(){try{
  const {data,error}=await client.auth.getUser();
  if(error||!data.user){mountedId=null;message("業務アプリにログインしてください","普段お使いの業務アプリでログイン後、メニューの「出張・旅費」を開いてください。");return;}
  const user=data.user;if(mountedId===user.id)return;
  const [access,role]=await Promise.all([client.rpc("is_internal_user"),client.rpc("is_master_admin")]);
  if(access.error||role.error)throw new Error("利用権限を確認できません。ページを開き直してください。");
  if(!access.data){mountedId=null;message("社内ユーザー向けの機能です","外部作業者のアカウントでは出張・旅費を利用できません。所属と利用区分は管理者に確認してください。");return;}
  setBackend(createBackend(client,user));mountedId=user.id;
  const displayName=user.user_metadata?.full_name||user.user_metadata?.name||user.email||"従業員";
  root.render(<TravelApp key={user.id} displayName={displayName} userId={user.id} isAdmin={!!role.data} onSignOut={async()=>{await client.auth.signOut();location.assign(loginHref);}}/>);
 }catch(error){mountedId=null;message("確認が必要です",(error as Error).message||"認証を確認できませんでした。");}}
 client.auth.onAuthStateChange((event:string)=>{if(event==="SIGNED_OUT"){mountedId=null;message("ログアウトしました","業務アプリからログインし直してください。");}else if(event==="SIGNED_IN")setTimeout(()=>void start(),0);});
 await start();
}
void boot();
