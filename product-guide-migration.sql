-- 商品案内で使う分類・規格・画像情報を商品マスタへ追加します。
-- Supabase Dashboard > SQL Editor で1回だけ実行してください。

alter table public.product_master
  add column if not exists guide_category text,
  add column if not exists guide_spec text,
  add column if not exists image_url text,
  add column if not exists image_source_url text,
  add column if not exists image_credit text,
  add column if not exists image_license text;

comment on column public.product_master.guide_category is '商品案内の表示カテゴリ';
comment on column public.product_master.guide_spec is '商品案内のSPEC/SIZE';
comment on column public.product_master.image_url is '商品案内で使う画像URL';
comment on column public.product_master.image_source_url is '画像の出典ページURL';
comment on column public.product_master.image_credit is '画像クレジット';
comment on column public.product_master.image_license is '画像ライセンス';
