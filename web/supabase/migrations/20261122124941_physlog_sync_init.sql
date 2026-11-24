-- PhysLog：端末間の記録の同期
-- ワークスペース（記録を共有するグループ。例：Ryota と Katsura）
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'PhysLog',
  invite_code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  created_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index on public.workspace_members (user_id);

-- 記録はコレクション名＋端末で作ったID＋中身（JSON）で持つ。後から書いた方を正とする
create table public.records (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  collection text not null check (collection in ('members','sessions','bodies','abilities','conditions','photos','activities','profile')),
  id text not null,
  data jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid() references auth.users(id) on delete set null,
  primary key (workspace_id, collection, id)
);
create index records_pull_idx on public.records (workspace_id, updated_at);

-- 受け取り順をサーバー時刻にそろえる（端末の時計ずれ対策）
create or replace function public.touch_record() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
create trigger records_touch before insert or update on public.records
for each row execute function public.touch_record();

-- 自分が入っているワークスペースか
create or replace function public.is_member(ws uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_members m where m.workspace_id = ws and m.user_id = auth.uid())
$$;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.records enable row level security;

create policy "members can read workspace" on public.workspaces for select to authenticated using (public.is_member(id));
create policy "members can rename workspace" on public.workspaces for update to authenticated using (public.is_member(id)) with check (public.is_member(id));

create policy "read own memberships and co-members" on public.workspace_members for select to authenticated using (public.is_member(workspace_id));
create policy "leave workspace" on public.workspace_members for delete to authenticated using (user_id = auth.uid());

create policy "members read records" on public.records for select to authenticated using (public.is_member(workspace_id));
create policy "members insert records" on public.records for insert to authenticated with check (public.is_member(workspace_id));
create policy "members update records" on public.records for update to authenticated using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));

-- 新しいワークスペースを作り、自分を入れる
create or replace function public.create_workspace(ws_name text default 'PhysLog') returns public.workspaces
language plpgsql security definer set search_path = '' as $$
declare w public.workspaces;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into public.workspaces (name, created_by) values (coalesce(nullif(ws_name, ''), 'PhysLog'), auth.uid()) returning * into w;
  insert into public.workspace_members (workspace_id, user_id) values (w.id, auth.uid());
  return w;
end $$;

-- 招待コードで参加する
create or replace function public.join_workspace(code text) returns public.workspaces
language plpgsql security definer set search_path = '' as $$
declare w public.workspaces;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into w from public.workspaces where invite_code = upper(trim(code));
  if w.id is null then raise exception 'invite code not found'; end if;
  insert into public.workspace_members (workspace_id, user_id) values (w.id, auth.uid()) on conflict do nothing;
  return w;
end $$;

revoke all on function public.create_workspace(text) from public, anon;
revoke all on function public.join_workspace(text) from public, anon;
revoke all on function public.is_member(uuid) from public, anon;
grant execute on function public.create_workspace(text) to authenticated;
grant execute on function public.join_workspace(text) to authenticated;
grant execute on function public.is_member(uuid) to authenticated;
