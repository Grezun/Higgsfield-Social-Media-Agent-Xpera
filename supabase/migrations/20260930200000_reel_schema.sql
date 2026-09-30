-- Reel agent schema (Phase 1b). One shared team workspace: every signed-in user can read everything;
-- writes are limited to what the web app does. The worker uses the secret key (bypasses RLS).

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete restrict,
  title text not null check (char_length(title) between 1 and 120),
  language text not null check (language in ('he', 'en')),
  format text not null default 'faceless' check (format in ('faceless', 'avatar', 'character', 'footage')),
  status text not null default 'planning'
    check (status in ('planning', 'draft', 'generating', 'needs_attention', 'rendered', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_updated_idx on public.projects (updated_at desc);

create table public.storyboards (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  version int not null check (version > 0),
  json jsonb not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'superseded')),
  created_by text not null check (created_by in ('user', 'agent')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, version)
);

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  input_hash text not null unique check (input_hash ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('image', 'video', 'audio')),
  file_name text not null,
  storage_path text not null,
  provider text not null,
  model text,
  provider_request_id text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  type text not null check (type in ('plan', 'generate')),
  status text not null default 'queued' check (status in ('queued', 'running', 'needs_attention', 'done', 'failed')),
  payload jsonb not null default '{}'::jsonb,
  progress jsonb not null default '{}'::jsonb,
  error text,
  attempts int not null default 0,
  locked_by text,
  heartbeat_at timestamptz,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index jobs_queued_idx on public.jobs (created_at) where status = 'queued';
create index jobs_project_idx on public.jobs (project_id, created_at desc);

create table public.renders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  storyboard_id uuid not null references public.storyboards (id) on delete cascade,
  storyboard_version int not null,
  reel_path text not null,
  preview_path text not null,
  thumbnail_path text not null,
  timeline jsonb not null,
  created_at timestamptz not null default now()
);
create index renders_project_idx on public.renders (project_id, created_at desc);

-- updated_at maintenance
create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;
create trigger projects_touch before update on public.projects for each row execute function public.touch_updated_at();
create trigger storyboards_touch before update on public.storyboards for each row execute function public.touch_updated_at();

-- Row level security
alter table public.projects enable row level security;
alter table public.storyboards enable row level security;
alter table public.assets enable row level security;
alter table public.jobs enable row level security;
alter table public.renders enable row level security;

create policy "team reads projects" on public.projects for select to authenticated using (true);
create policy "members create projects" on public.projects for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy "team updates projects" on public.projects for update to authenticated using (true) with check (true);

create policy "team reads storyboards" on public.storyboards for select to authenticated using (true);
create policy "team adds user drafts" on public.storyboards for insert to authenticated
  with check (status = 'draft' and created_by = 'user');
create policy "team edits and approves drafts" on public.storyboards for update to authenticated
  using (status = 'draft') with check (status in ('draft', 'approved'));

create policy "team reads assets" on public.assets for select to authenticated using (true);

create policy "team reads jobs" on public.jobs for select to authenticated using (true);
create policy "team queues jobs" on public.jobs for insert to authenticated
  with check (status = 'queued' and attempts = 0 and locked_by is null and created_by = (select auth.uid()));

create policy "team reads renders" on public.renders for select to authenticated using (true);

-- Storage: private buckets; signed-in users may read (sign URLs), only the worker writes.
insert into storage.buckets (id, name, public)
values ('assets', 'assets', false), ('renders', 'renders', false)
on conflict (id) do nothing;
create policy "team reads reel media" on storage.objects for select to authenticated
  using (bucket_id in ('assets', 'renders'));

-- Realtime (RLS still applies per subscriber)
alter publication supabase_realtime add table public.jobs, public.storyboards, public.renders;

-- Queue: claim the oldest queued job atomically; requeue jobs whose worker stopped heartbeating.
create function public.claim_job(p_worker text) returns setof public.jobs
language plpgsql security definer set search_path = '' as $$
begin
  return query
  update public.jobs j
     set status = 'running', locked_by = p_worker, started_at = now(), heartbeat_at = now(), attempts = j.attempts + 1
   where j.id = (
     select q.id from public.jobs q
      where q.status = 'queued'
      order by q.created_at
      for update skip locked
      limit 1)
  returning j.*;
end $$;

create function public.requeue_stale_jobs(p_stale_seconds int default 120) returns int
language sql security definer set search_path = '' as $$
  with stale as (
    update public.jobs
       set status = 'queued', locked_by = null
     where status = 'running' and heartbeat_at < now() - make_interval(secs => p_stale_seconds)
    returning 1)
  select count(*)::int from stale;
$$;

revoke execute on function public.claim_job(text) from public, anon, authenticated;
revoke execute on function public.requeue_stale_jobs(int) from public, anon, authenticated;
grant execute on function public.claim_job(text) to service_role;
grant execute on function public.requeue_stale_jobs(int) to service_role;
