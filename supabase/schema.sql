-- ═══════════════════════════════════════════════════════════════
-- FFA ATHLETE ASSESSMENT PORTAL — SUPABASE DATABASE SCHEMA
-- Paste this entire file into:
--   Supabase Dashboard → SQL Editor → New Query → Run
-- ═══════════════════════════════════════════════════════════════

-- ── 1. PROFILES (extends Supabase built-in auth.users) ──────
create table public.profiles (
  id         uuid references auth.users(id) on delete cascade primary key,
  role       text not null check (role in ('coach','parent','player')),
  full_name  text,
  email      text,
  created_at timestamptz default now()
);

-- Auto-create a profile row whenever someone signs up
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, role, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'role', 'player'),
    coalesce(new.raw_user_meta_data->>'full_name', '')
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ── 2. ATHLETES ─────────────────────────────────────────────
create table public.athletes (
  id           uuid default gen_random_uuid() primary key,
  first_name   text not null,
  last_name    text not null,
  dob_month    text not null,
  dob_year     text not null,
  weapon       text not null check (weapon in ('foil','epee','sabre')),
  comp_level   text not null,
  coach_id     uuid references public.profiles(id),
  player_id    uuid references public.profiles(id),
  parent_id    uuid references public.profiles(id),
  player_token text unique default encode(gen_random_bytes(16), 'hex'),
  parent_token text unique default encode(gen_random_bytes(16), 'hex'),
  created_at   timestamptz default now()
);

-- ── 3. ASSESSMENTS ──────────────────────────────────────────
create table public.assessments (
  id           uuid default gen_random_uuid() primary key,
  athlete_id   uuid references public.athletes(id) on delete cascade not null,
  persona      text not null check (persona in ('player','parent','coach')),
  submitted_by uuid references public.profiles(id),
  answers      jsonb not null default '{}',
  submitted_at timestamptz default now(),
  unique(athlete_id, persona)
);

-- ── 4. ROW LEVEL SECURITY ────────────────────────────────────
alter table public.profiles    enable row level security;
alter table public.athletes    enable row level security;
alter table public.assessments enable row level security;

create policy "Users manage own profile"
  on public.profiles for all using (auth.uid() = id);

create policy "Coach manages their athletes"
  on public.athletes for all using (coach_id = auth.uid());

create policy "Player sees own record"
  on public.athletes for select using (player_id = auth.uid());

create policy "Parent sees own record"
  on public.athletes for select using (parent_id = auth.uid());

create policy "Coach reads all assessments"
  on public.assessments for select using (
    exists (select 1 from public.athletes a
      where a.id = athlete_id and a.coach_id = auth.uid())
  );

create policy "Submitter reads own assessment"
  on public.assessments for select using (submitted_by = auth.uid());

create policy "Linked user can submit"
  on public.assessments for insert with check (
    exists (select 1 from public.athletes a
      where a.id = athlete_id and (
        a.coach_id  = auth.uid() or
        a.player_id = auth.uid() or
        a.parent_id = auth.uid()
      ))
  );

-- ── 5. CLAIM INVITE TOKEN ────────────────────────────────────
create or replace function public.claim_invite(p_token text, p_role text)
returns json as $$
declare v_athlete public.athletes;
begin
  if p_role = 'player' then
    select * into v_athlete from public.athletes where player_token = p_token;
    if not found then return json_build_object('success',false,'error','Invalid link'); end if;
    update public.athletes set player_id = auth.uid() where player_token = p_token;
  elsif p_role = 'parent' then
    select * into v_athlete from public.athletes where parent_token = p_token;
    if not found then return json_build_object('success',false,'error','Invalid link'); end if;
    update public.athletes set parent_id = auth.uid() where parent_token = p_token;
  else
    return json_build_object('success',false,'error','Unknown role');
  end if;
  return json_build_object('success',true,'athlete_id',v_athlete.id::text);
end;
$$ language plpgsql security definer;
