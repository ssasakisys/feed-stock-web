-- Supabase の SQL Editor でこのファイルの内容を実行してください。
-- ログイン機能を使わない構成のため、user_id列やRLS(行レベルセキュリティ)は設けていません。
-- 注意: この構成では「SupabaseのURLとanonキーを知っていれば誰でもデータを読み書きできる」状態になります。
-- 自分だけで使い、このURL・キーを他人に共有しないようにしてください。

create extension if not exists "pgcrypto";

create table if not exists farms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  note text default '',
  region text default '',
  order_num integer default 0,
  created_at timestamptz default now()
);

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  unit text default '個',
  created_at timestamptz default now()
);

create table if not exists stocks (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references farms(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  use_manual boolean default false,
  manual_daily_usage numeric,
  created_at timestamptz default now(),
  unique (farm_id, product_id)
);

create table if not exists logs (
  id uuid primary key default gen_random_uuid(),
  stock_id uuid not null references stocks(id) on delete cascade,
  date date not null,
  remaining numeric not null,
  created_at timestamptz default now()
);

-- ログインなしでもアプリ(anonキー)からデータを読み書きできるようにする
grant usage on schema public to anon;
grant select, insert, update, delete on farms, products, stocks, logs to anon;
