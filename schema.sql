-- MaxOut 401(k) Planner — Supabase schema
-- Run this in Supabase: SQL Editor -> New query -> paste -> Run.
-- Supabase already encrypts data at rest (AES-256) and in transit (TLS).
-- Row Level Security below guarantees users can only ever read/write their own rows.

create table if not exists public.plans (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  name         text not null default 'My plan',
  -- Plain-JSON storage (server can read it):
  data         jsonb,
  -- Zero-knowledge storage (client-side AES-GCM; server sees only ciphertext):
  is_encrypted boolean not null default false,
  ciphertext   text,          -- base64: salt || iv || ciphertext
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One plan per user for v1 (drop this constraint later for multi-plan support)
create unique index if not exists plans_one_per_user on public.plans (user_id);

alter table public.plans enable row level security;

create policy "Users can read own plans"
  on public.plans for select
  using (auth.uid() = user_id);

create policy "Users can insert own plans"
  on public.plans for insert
  with check (auth.uid() = user_id);

create policy "Users can update own plans"
  on public.plans for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own plans"
  on public.plans for delete
  using (auth.uid() = user_id);

-- Keep updated_at fresh
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists plans_touch on public.plans;
create trigger plans_touch before update on public.plans
  for each row execute function public.touch_updated_at();
