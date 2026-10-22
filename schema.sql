
-- =====================================================================
-- IdeaVault — Supabase PostgreSQL schema
-- =====================================================================

-- 0. Extensions
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- 1. Categories
create table if not exists public.categories (
  slug text primary key check (slug ~ '^[a-z0-9_]+$'),
  name text not null,
  accent text not null default '#5c5c5c',
  sort_order int not null default 100
);

insert into public.categories (slug, name, accent, sort_order) values
  ('advertising', 'Advertising', '#191713', 10),
  ('motion', 'Motion Graphics', '#2f5a4c', 20),
  ('cgi', '3D / CGI', '#40406b', 30),
  ('editing', 'Editing', '#8c3a2b', 40),
  ('typography', 'Typography', '#a07d2c', 50),
  ('uncategorized', 'Uncategorized', '#6b6455', 90)
on conflict (slug) do nothing;

-- 2. Reels
create table if not exists public.reels (
  id uuid primary key default gen_random_uuid(),
  instagram_url text not null,
  normalized_url text not null unique,
  media_id text,
  title text,
  creator_username text,
  thumbnail_url text,
  category text not null default 'uncategorized'
    references public.categories(slug),
  tags text[] not null default '{}',
  notes text not null default '',
  received_at timestamptz not null default now(),
  last_shared_at timestamptz,
  share_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_text text not null default ''
);

create index if not exists reels_received_at_idx
  on public.reels (received_at desc);
create index if not exists reels_category_idx
  on public.reels (category);
create index if not exists reels_creator_idx
  on public.reels (creator_username);
create index if not exists reels_search_trgm
  on public.reels using gin (search_text gin_trgm_ops);

-- Maintain search_text and updated_at automatically
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.search_text :=
    coalesce(new.title, '') || ' ' ||
    coalesce(new.creator_username, '') || ' ' ||
    coalesce(new.instagram_url, '') || ' ' ||
    coalesce(new.notes, '') || ' ' ||
    coalesce(array_to_string(new.tags, ' '), '');

  if TG_OP = 'UPDATE' then
    new.updated_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists reels_touch_updated on public.reels;
create trigger reels_touch_updated
  before insert or update on public.reels
  for each row execute function public.touch_updated_at();

-- 3. Profiles
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Team member',
  email text,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, email)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Team member'
    ),
    new.email
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

insert into public.profiles (id, display_name, email)
select
  u.id,
  coalesce(
    nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
    'Team member'
  ),
  u.email
from auth.users u
on conflict (id) do nothing;

-- 4. Reel shares
create table if not exists public.reel_shares (
  id uuid primary key default gen_random_uuid(),
  reel_id uuid not null references public.reels(id) on delete cascade,
  sender_label text not null default 'unknown',
  sender_ig_id text,
  source text not null default 'instagram_dm'
    check (source in ('instagram_dm', 'manual')),
  shared_at timestamptz not null default now(),
  unique (reel_id, sender_label)
);

create index if not exists reel_shares_reel_idx
  on public.reel_shares (reel_id);

create or replace function public.on_reel_share_insert()
returns trigger
language plpgsql
as $$
begin
  update public.reels r
  set
    share_count = r.share_count + 1,
    last_shared_at = new.shared_at
  where r.id = new.reel_id;

  return new;
end;
$$;

drop trigger if exists reel_share_counter on public.reel_shares;
create trigger reel_share_counter
  after insert on public.reel_shares
  for each row execute function public.on_reel_share_insert();

-- 5. Bookmarks
create table if not exists public.bookmarks (
  user_id uuid not null references auth.users(id) on delete cascade,
  reel_id uuid not null references public.reels(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, reel_id)
);

create index if not exists bookmarks_user_idx
  on public.bookmarks (user_id);

-- 6. Webhook event ledger
create table if not exists public.webhook_events (
  message_id text primary key,
  received_at timestamptz not null default now(),
  status text not null default 'received'
    check (status in (
      'received',
      'processed',
      'duplicate_reel',
      'duplicate_event',
      'skipped_no_reel_url',
      'skipped_invalid_url',
      'skipped_not_message',
      'error'
    )),
  sender_label text,
  extracted_url text,
  reel_id uuid references public.reels(id) on delete set null,
  detail text,
  payload jsonb
);

create index if not exists webhook_events_received_idx
  on public.webhook_events (received_at desc);

-- 7. Row Level Security
alter table public.reels enable row level security;
alter table public.categories enable row level security;
alter table public.profiles enable row level security;
alter table public.reel_shares enable row level security;
alter table public.bookmarks enable row level security;
alter table public.webhook_events enable row level security;

alter table public.webhook_events force row level security;

-- Categories
create policy "categories readable by team"
  on public.categories for select
  to authenticated using (true);

-- Reels
create policy "reels readable by team"
  on public.reels for select
  to authenticated using (true);

create policy "team can add reels manually"
  on public.reels for insert
  to authenticated with check (true);

create policy "team can edit reel metadata"
  on public.reels for update
  to authenticated using (true) with check (true);

create policy "team can remove reels"
  on public.reels for delete
  to authenticated using (true);

-- Profiles
create policy "profiles readable by team"
  on public.profiles for select
  to authenticated using (true);

create policy "own profile editable"
  on public.profiles for update
  to authenticated using (id = auth.uid())
  with check (id = auth.uid());

-- Reel shares
create policy "shares readable by team"
  on public.reel_shares for select
  to authenticated using (true);

create policy "team can record manual shares"
  on public.reel_shares for insert
  to authenticated with check (true);

-- Bookmarks
create policy "bookmarks readable by owner"
  on public.bookmarks for select
  to authenticated using (user_id = auth.uid());

create policy "bookmarks writable by owner"
  on public.bookmarks for insert
  to authenticated with check (user_id = auth.uid());

create policy "bookmarks removable by owner"
  on public.bookmarks for delete
  to authenticated using (user_id = auth.uid());

-- Webhook events
create policy "ingest log readable by team"
  on public.webhook_events for select
  to authenticated using (true);

-- 8. Realtime publication
do $$
begin
  alter publication supabase_realtime add table public.reels;
exception
  when duplicate_object then null;
  when others then
    raise notice 'realtime: could not add reels (%), polling still works', sqlerrm;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.reel_shares;
exception
  when duplicate_object then null;
  when others then
    raise notice 'realtime: could not add reel_shares (%)', sqlerrm;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.bookmarks;
exception
  when duplicate_object then null;
  when others then
    raise notice 'realtime: could not add bookmarks (%)', sqlerrm;
end $$;

-- 9. Verification queries (run separately after the schema succeeds)
-- select count(*) from public.categories;
-- select tablename, policyname
-- from pg_policies
-- where schemaname = 'public'
-- order by tablename;
--
-- select relname, relrowsecurity
-- from pg_class
-- where relname in (
--   'reels', 'categories', 'profiles', 'reel_shares',
--   'bookmarks', 'webhook_events'
-- );
