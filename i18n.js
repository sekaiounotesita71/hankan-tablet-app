(function(){
  "use strict";
  const STORAGE_KEY="hankan-ui-language";
  const TEXT_PAIRS=[
    ["オーダー管理","Order Management"],
    ["オーダー管理 P1/P2","Order Management P1/P2"],
    ["受注登録","Order Entry"],
    ["アプリ切替","Switch application"],
    ["作業アプリ","Work App"],
    ["売上参照","Sales"],
    ["売掛管理","Accounts Receivable"],
    ["商品案内","Product Guide"],
    ["発注入力","Order Entry"],
    ["マスタ","Masters"],
    ["Phase 1 入力","Phase 1 Entry"],
    ["Phase 1.5 産地・売価","Phase 1.5 Origin & Price"],
    ["Phase 2 箱一覧","Phase 2 Boxes"],
    ["Excel出力","Export Excel"],
    ["メール","Email"],
    ["パスワード","Password"],
    ["ログイン","Sign in"],
    ["ログアウト","Sign out"],
    ["未ログイン","Signed out"],
    ["作業一覧","Work List"],
    ["保存済み作業を開く","Open Saved Work"],
    ["作業データを開く","Open Work Data"],
    ["受注登録・CSV/PDF取込・マスタ更新は発注入力画面で行います。現場では日付を選んで作業を開きます。","Register orders, import CSV/PDF files, and update masters in Order Entry. Select a date here to start field work."],
    ["作業日","Work Date"],
    ["価格・産地Excel","Price & Origin Excel"],
    ["ファイルを選択","Choose File"],
    ["未選択","Not selected"],
    ["受注から作業作成","Create Work from Orders"],
    ["作業一覧を表示","Show Work List"],
    ["発注入力へ","Go to Order Entry"],
    ["追加オーダー","Add Order"],
    ["名前を付けて保存","Save As"],
    ["売上確定","Finalize Sales"],
    ["ロック解除","Unlock"],
    ["店舗名","Customer"],
    ["商品名","Product Name"],
    ["商品コード","Product Code"],
    ["注文数量","Order Qty"],
    ["注文単位","Order Unit"],
    ["数量","Qty"],
    ["単位","Unit"],
    ["産地","Origin"],
    ["売価","Selling Price"],
    ["単価","Unit Price"],
    ["金額","Amount"],
    ["備考","Notes"],
    ["メモ","Memo"],
    ["未入力可","Optional"],
    ["キャンセル","Cancel"],
    ["追加する","Add"],
    ["Excel出力する輸入社を選択","Select Importer for Excel Export"],
    ["輸入社コード","Importer Code"],
    ["輸入社名","Importer Name"],
    ["全てまとめて出力","Export All"],
    ["未反映伝票を確認","Review Pending Entries"],
    ["すべて選択","Select All"],
    ["選択解除","Clear Selection"],
    ["出力を中止","Cancel Export"],
    ["確認してExcel出力","Confirm & Export Excel"],
    ["選択せずExcel出力","Export Without Entries"],
    ["欠品にしますか？","Mark as Out of Stock?"],
    ["入力済みの数量、NET、箱番号はクリアされます。","Entered quantity, NET weight, and box number will be cleared."],
    ["欠品にする","Mark Out of Stock"],
    ["欠品","Out of Stock"],
    ["戻す","Undo"],
    ["全件","All"],
    ["完了","Complete"],
    ["未入力","Not Entered"],
    ["入力中","In Progress"],
    ["未反映","Pending"],
    ["反映済み","Applied"],
    ["反映済","Applied"],
    ["保留","On Hold"],
    ["取消","Cancelled"],
    ["予定日前","Before Planned Date"],
    ["箱番号","Box No."],
    ["箱サイズ","Box Size"],
    ["NET重量","NET Weight"],
    ["グロス重量","Gross Weight"],
    ["ドライアイス","Dry Ice"],
    ["次の項目へ","Next Field"],
    ["メモを保存して閉じる","Save Memo & Close"],
    ["単位を保存して閉じる","Save Unit & Close"],
    ["受注CSV/PDF取込","Import Order CSV/PDF"],
    ["商品追加","Add Product"],
    ["マスタ管理","Master Management"],
    ["受注確定 Ctrl+Enter","Confirm Order Ctrl+Enter"],
    ["発注書PDF","Purchase Order PDF"],
    ["現品票PDF","Picking Ticket PDF"],
    ["入力クリア","Clear Entry"],
    ["LINE文面貼り付け","Paste LINE Message"],
    ["LINE文面を貼り付け","Paste a LINE order message"],
    ["一括確認へ","Bulk Review"],
    ["現在の得意先で下書き","Draft for Current Customer"],
    ["下書きを商品追加","Add Draft Products"],
    ["辞書確認","Review Dictionary"],
    ["LINE文面を貼り付けてください。","Paste a LINE order message."],
    ["基本情報","Basic Information"],
    ["日付","Date"],
    ["得意先コード","Customer Code"],
    ["得意先名","Customer Name"],
    ["この受注全体のメモ","Memo for this order"],
    ["未確定","Not Confirmed"],
    ["DB未接続","DB Disconnected"],
    ["未保存","Not Saved"],
    ["取込内容の確認","Review Imported Data"],
    ["輸入社・得意先・商品コード・商品名で絞り込み","Filter by importer, customer, product code, or product name"],
    ["同じ得意先コードをまとめて修正","Update rows with the same customer code"],
    ["同じ輸入社をまとめて修正","Update rows with the same importer"],
    ["明細追加","Add Line"],
    ["全件受注確定","Confirm All Orders"],
    ["確定可を一括確定","Confirm Ready Orders"],
    ["取込下書きへ登録","Save as Import Draft"],
    ["取込を破棄","Discard Import"],
    ["確定済み受注","Confirmed Orders"],
    ["未処理伝票","Pending Entries"],
    ["種別","Type"],
    ["登録日","Entry Date"],
    ["予定日","Planned Date"],
    ["商品名・内容","Product / Description"],
    ["理由","Reason"],
    ["赤伝","Credit Note"],
    ["訂正","Correction"],
    ["追加請求","Extra Charge"],
    ["値引き","Discount"],
    ["送料調整","Shipping Adjustment"],
    ["先行受注","Advance Order"],
    ["この内容で登録","Register"],
    ["この内容で更新","Update"],
    ["入力クリア","Clear"],
    ["再読込","Reload"],
    ["絞込解除","Clear Filters"],
    ["帳票出力","Reports"],
    ["発注先","Supplier"],
    ["仕入先コード","Supplier Code"],
    ["仕入先名","Supplier Name"],
    ["検索","Search"],
    ["請求日","Invoice Date"],
    ["状態","Status"],
    ["未回収すべて","Outstanding"],
    ["未入金","Unpaid"],
    ["一部入金","Partially Paid"],
    ["期限超過","Overdue"],
    ["入金済","Paid"],
    ["過入金","Overpaid"],
    ["売掛読込","Load Receivables"],
    ["売上確定を反映","Sync Finalized Sales"],
    ["SOA出力","Export SOA"],
    ["売上確定データから輸入社別の売掛を作成できます。","Create importer-level receivables from finalized sales."],
    ["請求総額","Invoiced"],
    ["消込額","Settled"],
    ["売掛残","Outstanding"],
    ["「売掛読込」を押してください。","Press Load Receivables."],
    ["初期残高を登録","Register Opening Balance"],
    ["Invoice番号","Invoice No."],
    ["支払期限","Due Date"],
    ["通貨","Currency"],
    ["外貨金額","Foreign Amount"],
    ["為替","Exchange Rate"],
    ["円換算残高","JPY Balance"],
    ["freee計上済み","Posted to freee"],
    ["初期残高CSV","Import Opening CSV"],
    ["CSV見本","Sample CSV"],
    ["初期残高は管理者のみ登録できます。freeeに既に計上済みの残高は、会計CSVの対象外として保存します。","Only administrators can register opening balances. Balances already posted to freee are excluded from accounting CSV exports."],
    ["入金を登録","Record Payment"],
    ["一覧から対象の「入金」を押してください。","Select a receivable and press Payment."],
    ["入金日","Payment Date"],
    ["入金額","Amount Received"],
    ["振込手数料","Bank Fee"],
    ["振込番号・摘要","Payment Reference"],
    ["売掛を選択すると入金履歴を表示します。","Select a receivable to view payment history."],
    ["入金履歴はありません。","No payment history."],
    ["区分","Source"],
    ["SOA請求先情報","SOA Billing Details"],
    ["請求先名","Bill To"],
    ["住所","Address"],
    ["電話番号","Phone"],
    ["選択輸入社を読込","Load Selected Importer"],
    ["請求先情報を保存","Save Billing Details"],
    ["SOAへ表示する輸入社別の請求先名・住所・電話番号を保存します。","Save the importer billing name, address, and phone shown on the SOA."],
    ["マスタ追加/更新","Add / Update Master"],
    ["マスタCSV取込","Import Master CSV"],
    ["マスタCSV出力","Export Master CSV"],
    ["発注入力へ戻る","Back to Order Entry"],
    ["商品","Product"],
    ["得意先","Customer"],
    ["仕入先","Supplier"],
    ["輸入社","Importer"],
    ["カテゴリー","Category"],
    ["英名","English Name"],
    ["通常単価","Default Price"],
    ["操作","Actions"],
    ["削除","Delete"],
    ["編集","Edit"],
    ["保存","Save"],
    ["閉じる","Close"],
    ["開く","Open"],
    ["選択","Select"],
    ["該当なし","No results"],
    ["左の一覧から売上確定済みデータを選択してください","Select finalized sales data from the list."],
    ["確定済み作業を選択してください","Select finalized work."],
    ["店名・商品名・輸入社・箱番号で検索","Search customer, product, importer, or box number"],
    ["日本語へ切替","Switch to Japanese"],
    ["英語へ切替","Switch to English"]
  ];
  const JA_TO_EN=new Map(TEXT_PAIRS);
  let savedLanguage="";
  try{savedLanguage=localStorage.getItem(STORAGE_KEY)||""}catch(error){}
  let language=savedLanguage==="en"?"en":"ja";
  let observer=null;
  let scheduled=false;
  let originalTitle="";
  const pendingRoots=new Set();
  const translatedTextNodes=new WeakMap();
  const translatedAttributes=new WeakMap();

  function dynamicTranslation(text){
    const patterns=[
      [/^(\d+)件$/,"$1 items"],
      [/^(\d+)行$/,"$1 rows"],
      [/^(\d+)箱$/,"$1 boxes"],
      [/^(\d+)\/(\d+)件完了$/,"$1/$2 complete"],
      [/^(\d+)\/(\d+)箱$/,"$1/$2 boxes"],
      [/^明細 (\d+)行$/,"Lines: $1"],
      [/^箱 (\d+)件$/,"Boxes: $1"],
      [/^シート (\d+)枚$/,"Sheets: $1"],
      [/^(\d+)件をInvoiceへ反映$/,"Apply $1 to Invoice"],
      [/^(\d+)件を反映してExcel出力$/,"Apply $1 and Export Excel"],
      [/^対象: (.+) \/ 作業日 (.+)$/,"Target: $1 / Work date: $2"],
      [/^未反映・保留の伝票が (\d+)件あります。チェックした伝票だけを今回のInvoiceへ追加します。$/,"$1 pending/on-hold entries found. Only checked entries will be added to this Invoice."],
      [/^登録 (.+) \/ 予定 (.+)$/,"Created $1 / Planned $2"],
      [/^登録 (.+)$/,"Created $1"]
    ];
    for(const [pattern,replacement] of patterns){
      if(pattern.test(text))return text.replace(pattern,replacement);
    }
    return text;
  }
  function translateCore(text){
    return JA_TO_EN.get(text)||dynamicTranslation(text);
  }
  function translateValue(value){
    const raw=String(value??"");
    const trimmed=raw.trim();
    if(!trimmed)return raw;
    const translated=translateCore(trimmed);
    return translated===trimmed?raw:raw.replace(trimmed,translated);
  }
  function translateTextNode(node){
    const parent=node.parentElement;
    if(!parent||parent.closest("script,style,[data-no-i18n]"))return;
    const previous=translatedTextNodes.get(node);
    if(language==="ja"){
      if(previous&&node.nodeValue===previous.translated)node.nodeValue=previous.original;
      translatedTextNodes.delete(node);
      return;
    }
    if(previous&&node.nodeValue===previous.translated)return;
    if(previous)translatedTextNodes.delete(node);
    const next=translateValue(node.nodeValue);
    if(next!==node.nodeValue){
      const original=node.nodeValue;
      translatedTextNodes.set(node,{original,translated:next});
      node.nodeValue=next;
    }
  }
  function translateAttributes(element){
    if(!(element instanceof Element)||element.closest("[data-no-i18n]"))return;
    let states=translatedAttributes.get(element);
    if(!states){states=new Map();translatedAttributes.set(element,states)}
    for(const attr of ["placeholder","title","aria-label"]){
      if(!element.hasAttribute(attr))continue;
      const current=element.getAttribute(attr);
      const previous=states.get(attr);
      if(language==="ja"){
        if(previous&&current===previous.translated)element.setAttribute(attr,previous.original);
        states.delete(attr);
        continue;
      }
      if(previous&&current===previous.translated)continue;
      if(previous)states.delete(attr);
      const next=translateValue(current);
      if(next!==current){states.set(attr,{original:current,translated:next});element.setAttribute(attr,next)}
    }
    if(!states.size)translatedAttributes.delete(element);
  }
  function applyLanguage(root){
    if(!root)return;
    if(root.nodeType===Node.TEXT_NODE){translateTextNode(root);return}
    if(root.nodeType!==Node.ELEMENT_NODE&&root.nodeType!==Node.DOCUMENT_NODE)return;
    if(root.nodeType===Node.ELEMENT_NODE)translateAttributes(root);
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    let node;
    while((node=walker.nextNode()))translateTextNode(node);
    const elements=root.querySelectorAll?root.querySelectorAll("[placeholder],[title],[aria-label]"):[];
    elements.forEach(translateAttributes);
  }
  function updateLanguageButton(){
    document.querySelectorAll("[data-language-switch]").forEach(button=>{
      const label=language==="en"?"日本語":"EN";
      const help=language==="en"?"日本語へ切替":"英語へ切替";
      if(button.textContent!==label)button.textContent=label;
      if(button.getAttribute("aria-label")!==help)button.setAttribute("aria-label",help);
      if(button.getAttribute("title")!==help)button.setAttribute("title",help);
    });
  }
  function flushPendingRoots(){
    scheduled=false;
    const roots=[...pendingRoots];
    pendingRoots.clear();
    roots.forEach(applyLanguage);
    updateLanguageButton();
  }
  function scheduleLanguageApply(root){
    pendingRoots.add(root?.nodeType===Node.TEXT_NODE?root.parentElement:root||document.body);
    if(scheduled)return;
    scheduled=true;
    requestAnimationFrame(flushPendingRoots);
  }
  function setLanguage(nextLanguage){
    language=nextLanguage==="en"?"en":"ja";
    try{localStorage.setItem(STORAGE_KEY,language)}catch(error){}
    document.documentElement.lang=language;
    document.title=language==="en"?translateCore(originalTitle):originalTitle;
    applyLanguage(document.body);
    updateLanguageButton();
  }
  function toggleLanguage(){setLanguage(language==="en"?"ja":"en")}
  function init(){
    originalTitle=document.title;
    setLanguage(language);
    observer=new MutationObserver(mutations=>{
      mutations.forEach(mutation=>scheduleLanguageApply(mutation.target));
    });
    observer.observe(document.body,{subtree:true,childList:true,characterData:true});
  }
  window.toggleUiLanguage=toggleLanguage;
  window.setUiLanguage=setLanguage;
  window.getUiLanguage=()=>language;
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});else init();
})();

