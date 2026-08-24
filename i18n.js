(function(){
  "use strict";
  const STORAGE_KEY="hankan-ui-language";
  const TEXT_PAIRS=[
    ["オーダー管理","Order Management"],
    ["オーダー管理 P1/P2","Order Management P1/P2"],
    ["販売・業務管理","Sales & Operations"],
    ["受注登録","Order Entry"],
    ["HOME","HOME"],
    ["業務メニュー","Operations Menu"],
    ["受注から作業、売上・仕入管理まで、業務の順番に並んでいます。","Follow the workflow from order entry through field work, sales, and purchasing."],
    ["受注・現場","Orders & Field Work"],
    ["注文を受けて作業へ渡す","Receive orders and hand them to field work"],
    ["受注登録・帳票出力","Order entry and reports"],
    ["現場数量・箱・売上確定","Field quantities, boxes, and sales finalization"],
    ["問屋への依頼と進捗確認","Supplier assignments and progress"],
    ["売上・回収","Sales & Collection"],
    ["確定売上から入金まで","From finalized sales to payment collection"],
    ["日別・輸入社別の売上分析","Sales analysis by date and importer"],
    ["請求締め・入金・SOA","Billing close, payments, and SOA"],
    ["仕入・支払","Purchases & Payables"],
    ["仕入登録から支払管理へ","From purchase entry to payment management"],
    ["仕入入力","Purchase Entry"],
    ["税率","Tax Rate"],
    ["非課税","Tax Exempt"],
    ["税計算","Tax Calculation"],
    ["税率から自動","Calculate from Rates"],
    ["税額を手入力","Enter Tax Manually"],
    ["税抜小計","Subtotal Before Tax"],
    ["税込合計","Total Including Tax"],
    ["消費税","Consumption Tax"],
    ["登録先","Save To"],
    ["仕入先別単価","Supplier-specific Price"],
    ["標準仕入単価","Standard Purchase Price"],
    ["選択単価をマスタ登録","Save Selected Prices"],
    ["マスタ候補","Master Candidate"],
    ["事前仕入・発注なし仕入","Advance and non-order purchases"],
    ["仕入参照","Purchase Reference"],
    ["仕入伝票の検索・照合","Search and reconcile purchase slips"],
    ["買掛管理","Accounts Payable"],
    ["買掛締め","Payables Close"],
    ["支払方法","Payment Method"],
    ["掛け払い","Credit Payment"],
    ["都度現金払い","Cash on Entry"],
    ["15日締め・翌月15日払い","Close 15th / Pay Next 15th"],
    ["末締め・翌月末払い","Month-end / Pay Next Month-end"],
    ["設定内容","Payment Terms"],
    ["買掛締めを実行","Close Payables"],
    ["締め日グループ","Closing Day Group"],
    ["締め日を選択","Select Closing Day"],
    ["仕入先絞り込み","Supplier Filter"],
    ["選択仕入先を一括締め","Close Selected Suppliers"],
    ["対象仕入先","Target Suppliers"],
    ["選択中","Selected"],
    ["買掛締め履歴は買掛読込後に表示されます。","Payables closing history appears after loading payables."],
    ["締め後買掛残高","Closing Payable Balance"],
    ["前回繰越","Opening Balance"],
    ["今回仕入","Current Purchases"],
    ["期間内支払","Payments in Period"],
    ["支払条件マスタ","Payment Terms Master"],
    ["支払条件","Payment Terms"],
    ["請求書日","Invoice Date"],
    ["未払すべて","All Outstanding"],
    ["未払","Unpaid"],
    ["一部支払","Partially Paid"],
    ["支払済","Paid"],
    ["過払","Overpaid"],
    ["請求書・仕入先・メモ","Invoice, supplier, or memo"],
    ["買掛読込","Load Payables"],
    ["仕入確定を反映","Sync Confirmed Purchases"],
    ["仕入確定データを、仕入先・請求書番号ごとに買掛へまとめます。","Group confirmed purchases into payables by supplier and invoice number."],
    ["仕入・請求総額","Purchases / Invoiced"],
    ["買掛残","Outstanding Payables"],
    ["買掛初期残高を登録","Register Opening Payable"],
    ["買掛残高","Opening Balance"],
    ["初期残高は管理者のみ登録できます。","Only administrators can register opening balances."],
    ["支払を登録","Record Payment"],
    ["一覧から対象の「支払」を押してください。","Select a payable and press Payment."],
    ["支払額","Payment Amount"],
    ["買掛を選択すると支払履歴を表示します。","Select a payable to view payment history."],
    ["支払履歴はありません。","No payment history."],
    ["選択仕入先を読込","Load Selected Supplier"],
    ["支払条件を保存","Save Payment Terms"],
    ["請求書照合・支払管理","Invoice reconciliation and payments"],
    ["準備中","Coming Soon"],
    ["基盤・案内","Masters & Guides"],
    ["共通マスタと販売資料","Shared masters and sales materials"],
    ["商品・得意先・仕入先・輸入社・請求条件・支払条件","Products, customers, suppliers, importers, billing terms, and payment terms"],
    ["季節商品と価格案内","Seasonal products and price guides"],
    ["アプリ切替","Switch application"],
    ["作業アプリ","Work App"],
    ["外部作業","External Work"],
    ["売上参照","Sales"],
    ["今日","Today"],
    ["今週","This Week"],
    ["今月","This Month"],
    ["確定＋速報","Final + Preliminary"],
    ["確定のみ","Final Only"],
    ["速報のみ","Preliminary Only"],
    ["確定売上","Finalized Sales"],
    ["未確定速報","Preliminary Sales"],
    ["着地見込","Projected Total"],
    ["未確定作業","Open Work"],
    ["金額未算出","Amount Pending"],
    ["売掛管理","Accounts Receivable"],
    ["商品案内","Product Guide"],
    ["発注入力","Order Entry"],
    ["発注先確認","Supplier Review"],
    ["発注先確認・発注状況","Supplier Review & Order Status"],
    ["仮コード確定・発注済み確認","Confirm provisional suppliers and order status"],
    ["日付を問わず未発注","All Unordered"],
    ["未発注","Unordered"],
    ["発注済み","Ordered"],
    ["仮コード","Provisional"],
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
    ["売掛一覧PDF","Receivables List PDF"],
    ["得意先明細PDF","Customer Ledger PDF"],
    ["買掛一覧PDF","Payables List PDF"],
    ["仕入先明細PDF","Supplier Ledger PDF"],
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
    ["締め","Closing"],
    ["締め済","Closed"],
    ["請求先・締め条件マスタ","Billing & Closing Terms"],
    ["請求条件マスタ","Billing Terms Master"],
    ["請求条件","Billing Terms"],
    ["請求先名","Bill To"],
    ["住所","Address"],
    ["電話番号","Phone"],
    ["締め日","Closing Day"],
    ["支払月","Payment Month"],
    ["支払日","Payment Day"],
    ["当月","Same Month"],
    ["翌月","Next Month"],
    ["翌々月","Two Months Later"],
    ["3か月後","Three Months Later"],
    ["選択輸入社を読込","Load Selected Importer"],
    ["請求条件を保存","Save Billing Terms"],
    ["請求締め","Invoice Closing"],
    ["対象月","Closing Month"],
    ["条件を再読込","Reload Terms"],
    ["請求締めを実行","Close Billing Period"],
    ["締め期間","Closing Period"],
    ["今回請求","Current Charges"],
    ["締め後残高","Closing Balance"],
    ["締め解除","Reopen"],
    ["対象月と輸入社を選択してください。","Select a closing month and importer."],
    ["締め日・支払日は1～31で登録します。31は月末として扱います。","Enter closing and payment days from 1 to 31. Day 31 means month end."],
    ["マスタ追加/更新","Add / Update Master"],
    ["新規商品マスタ","New Product Master"],
    ["元の入力へ戻る","Return to Entry"],
    ["入力内容は保持されています。","Your entry is preserved."],
    ["更新履歴","Change History"],
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
