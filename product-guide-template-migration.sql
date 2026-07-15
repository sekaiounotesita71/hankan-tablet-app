-- 商品案内テンプレート・重複行・産地別画像を共有するためのSQLです。
-- Supabase Dashboard > SQL Editor で1回だけ実行してください。

create table if not exists public.product_guide_templates (
  id uuid primary key default gen_random_uuid(),
  template_name text not null,
  guide_year integer not null,
  season text,
  title text not null default '商品案内',
  importer_code text,
  currency text not null default 'JPY',
  status text not null default 'draft' check (status in ('draft','confirmed','archived')),
  source_template_id uuid,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  updated_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists product_guide_templates_year_idx
  on public.product_guide_templates(guide_year desc, season, updated_at desc);

create table if not exists public.product_guide_variants (
  id uuid primary key default gen_random_uuid(),
  product_code text not null,
  origin text,
  spec text,
  origin_key text not null default '',
  spec_key text not null default '',
  display_name text,
  image_url text,
  image_source_url text,
  image_credit text,
  image_license text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  updated_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(product_code, origin_key, spec_key)
);

create index if not exists product_guide_variants_product_idx
  on public.product_guide_variants(product_code, origin_key, spec_key);

create table if not exists public.product_guide_template_rows (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.product_guide_templates(id) on delete cascade,
  variant_id uuid references public.product_guide_variants(id) on delete set null,
  display_order integer not null default 1,
  include boolean not null default true,
  category text,
  product_code text,
  product_name text,
  guide_name text,
  english_name text,
  origin text,
  spec text,
  base_price_jpy_min numeric,
  base_price_jpy_max numeric,
  pricing_net_weight numeric not null default 1,
  price_source text,
  candidate_status text,
  guide_price_range text,
  importer_code text,
  supplier_code text,
  supplier_name text,
  unit text,
  image_url text,
  image_source_url text,
  image_credit text,
  image_license text,
  manual_price_locked boolean not null default false,
  memo text,
  source_period text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists product_guide_template_rows_order_idx
  on public.product_guide_template_rows(template_id, display_order, id);

alter table public.product_guide_templates enable row level security;
alter table public.product_guide_variants enable row level security;
alter table public.product_guide_template_rows enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='product_guide_templates' and policyname='product guide templates authenticated') then
    create policy "product guide templates authenticated" on public.product_guide_templates for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='product_guide_variants' and policyname='product guide variants authenticated') then
    create policy "product guide variants authenticated" on public.product_guide_variants for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='product_guide_template_rows' and policyname='product guide template rows authenticated') then
    create policy "product guide template rows authenticated" on public.product_guide_template_rows for all to authenticated using (true) with check (true);
  end if;
end $$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-guide-images', 'product-guide-images', true, 10485760, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
set public=true,
    file_size_limit=excluded.file_size_limit,
    allowed_mime_types=excluded.allowed_mime_types;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='product guide images public read') then
    create policy "product guide images public read" on storage.objects for select to public using (bucket_id='product-guide-images');
  end if;
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='product guide images authenticated insert') then
    create policy "product guide images authenticated insert" on storage.objects for insert to authenticated with check (bucket_id='product-guide-images');
  end if;
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='product guide images authenticated update') then
    create policy "product guide images authenticated update" on storage.objects for update to authenticated using (bucket_id='product-guide-images') with check (bucket_id='product-guide-images');
  end if;
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='product guide images authenticated delete') then
    create policy "product guide images authenticated delete" on storage.objects for delete to authenticated using (bucket_id='product-guide-images');
  end if;
end $$;

comment on table public.product_guide_templates is '年度・シーズン単位の商品案内テンプレート';
comment on table public.product_guide_template_rows is '商品コードが重複しても行ID単位で保持する商品案内明細';
comment on table public.product_guide_variants is '商品コード・産地・規格単位の画像再利用マスタ';
