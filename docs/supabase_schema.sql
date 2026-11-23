-- 착한한끼 (서울시 대학생 가성비 요식업 지도) Supabase Postgres Schema
-- 가게 목록·메뉴·가격은 Google Spreadsheet에서 실시간 조회하고,
-- 회원 프로필 · 즐겨찾기(찜) · 가격변동 제보 · 핵심지표는 Supabase에 저장합니다.

-- 1. 사용자 프로필 (Supabase Auth 연계)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null,
  university text not null default '',
  agreed_terms boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert
  to authenticated
  with check ((select auth.uid()) = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- 2. 즐겨찾기 (찜하기)
create table if not exists public.favorites (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  restaurant_key text not null,
  restaurant_name text not null default '',
  created_at timestamptz not null default now(),
  unique (user_id, restaurant_key)
);

create index if not exists favorites_user_id_idx on public.favorites (user_id);
create index if not exists favorites_restaurant_key_idx on public.favorites (restaurant_key);

alter table public.favorites enable row level security;

drop policy if exists "favorites_select_own" on public.favorites;
create policy "favorites_select_own" on public.favorites
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "favorites_insert_own" on public.favorites;
create policy "favorites_insert_own" on public.favorites
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "favorites_delete_own" on public.favorites;
create policy "favorites_delete_own" on public.favorites
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- 3. 가격변동 · 폐업 · 정보수정 제보
create table if not exists public.reports (
  id bigint generated always as identity primary key,
  restaurant_key text not null,
  restaurant_name text not null,
  user_id uuid references auth.users(id) on delete set null,
  report_type text not null check (report_type in ('price_change', 'menu_error', 'closed', 'location_error')),
  reported_price integer check (reported_price is null or reported_price >= 0),
  detail text not null,
  status text not null default '접수됨',
  created_at timestamptz not null default now()
);

create index if not exists reports_restaurant_key_idx on public.reports (restaurant_key);
create index if not exists reports_user_id_idx on public.reports (user_id);

alter table public.reports enable row level security;

drop policy if exists "reports_select_public" on public.reports;
create policy "reports_select_public" on public.reports
  for select
  to anon, authenticated
  using (true);

drop policy if exists "reports_insert_authenticated" on public.reports;
create policy "reports_insert_authenticated" on public.reports
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "reports_insert_anon" on public.reports;
create policy "reports_insert_anon" on public.reports
  for insert
  to anon
  with check (user_id is null);

-- 4. 서비스 핵심지표 이벤트 (린캔버스 지표 측정)
create table if not exists public.analytics_events (
  id bigint generated always as identity primary key,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.analytics_events enable row level security;

drop policy if exists "analytics_insert_all" on public.analytics_events;
create policy "analytics_insert_all" on public.analytics_events
  for insert
  to anon, authenticated
  with check (true);

drop policy if exists "analytics_select_all" on public.analytics_events;
create policy "analytics_select_all" on public.analytics_events
  for select
  to anon, authenticated
  using (true);

-- 5. Data API 권한 명시적 부여
grant usage on schema public to anon, authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, delete on public.favorites to authenticated;
grant select, insert on public.reports to anon, authenticated;
grant select, insert on public.analytics_events to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;
