-- PhysLog：役割分け（owner・coach・client）と、1回きり・期限つきの招待
--
--   owner  … グループを作った人。全員の記録を読み書きでき、人（指導者・本人）を招く・外すができる。
--            指導者を外すとき、その人の端末に残っているグループの記録を消すかどうかを選べる
--   coach  … 指導者。全員の記録を読み書きでき、本人を招ける（指導者を招く・人を外すのは owner だけ）
--   client … 本人。自分の記録だけ読み書きできる。抜けるときに、自分の記録をグループに残すか消すかを選べる
--
-- 「誰の記録か」は records.member_id で判定する（members コレクションの id と同じ値）。
-- 旧・共通招待コード（workspaces.invite_code。何度でも使えて全権限が付く）は使わない。
-- 参加・招待・外す操作は、すべて関数（RPC）を通す。表を直接さわれるのは records と、workspaces の名前だけ。

-- ───────── 1. 役割と「誰の記録か」の列 ─────────

alter table public.workspace_members
  add column role text,
  add column member_id text;

-- これまでの参加者：作った人は owner、ほかは coach（いままでどおり全員の記録を読み書きできる）
update public.workspace_members m
   set role = case when w.created_by = m.user_id then 'owner' else 'coach' end
  from public.workspaces w
 where w.id = m.workspace_id and m.role is null;

alter table public.workspace_members
  alter column role set not null,
  alter column role set default 'client',
  add constraint workspace_members_role_check check (role in ('owner', 'coach', 'client')),
  add constraint workspace_members_client_has_member check (role <> 'client' or member_id is not null);

comment on column public.workspace_members.role is 'owner（作った人）・coach（指導者）・client（本人）';
comment on column public.workspace_members.member_id is 'この利用者が「記録される人」のうち誰か（records の members コレクションの id）。client は必須';

-- owner は1つのグループに1人。1人の「記録される人」に結びつくアカウントは1つ
create unique index workspace_members_one_owner on public.workspace_members (workspace_id) where role = 'owner';
create unique index workspace_members_member_once on public.workspace_members (workspace_id, member_id) where member_id is not null;

alter table public.records add column member_id text;
comment on column public.records.member_id is '誰の記録か。権限の判定に使う。送られてきた値は使わず、トリガー（touch_record）が data から決める';
create index records_member_idx on public.records (workspace_id, member_id, updated_at);

-- 旧・共通招待コードは止める（列は残すが、新しく作らない）
alter table public.workspaces
  alter column invite_code drop default,
  alter column invite_code drop not null;
update public.workspaces set invite_code = null where invite_code is not null;
comment on column public.workspaces.invite_code is '使っていない（旧・共通招待コード）。招待は public.invites を使う';

-- ───────── 2. 権限の判定に使う関数（private。API からは呼べない） ─────────

create or replace function private.my_role(ws uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.workspace_members m where m.workspace_id = ws and m.user_id = auth.uid()
$$;

create or replace function private.my_member_id(ws uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.member_id from public.workspace_members m where m.workspace_id = ws and m.user_id = auth.uid()
$$;

-- 全員の記録を読み書きできるグループ（owner・coach として入っているもの）
create or replace function private.staff_workspace_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.workspace_id from public.workspace_members m where m.user_id = auth.uid() and m.role in ('owner', 'coach')
$$;

create or replace function private.owner_workspace_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.workspace_id from public.workspace_members m where m.user_id = auth.uid() and m.role = 'owner'
$$;

-- 本人（client）として入っているグループと、そこでの自分の member_id
create or replace function private.client_links() returns table (workspace_id uuid, member_id text)
language sql stable security definer set search_path = '' as $$
  select m.workspace_id, m.member_id from public.workspace_members m
   where m.user_id = auth.uid() and m.role = 'client' and m.member_id is not null
$$;

-- 招待コードの照合用（英数字だけ・大文字にそろえてからハッシュ）。コードそのものは保存しない
create or replace function private.invite_hash(code text) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(upper(regexp_replace(coalesce(code, ''), '[^0-9A-Za-z]', '', 'g')), 'UTF8')), 'hex')
$$;

revoke all on function private.my_role(uuid) from public;
revoke all on function private.my_member_id(uuid) from public;
revoke all on function private.staff_workspace_ids() from public;
revoke all on function private.owner_workspace_ids() from public;
revoke all on function private.client_links() from public;
revoke all on function private.invite_hash(text) from public;
grant execute on function private.my_role(uuid) to authenticated, service_role;
grant execute on function private.my_member_id(uuid) to authenticated, service_role;
grant execute on function private.staff_workspace_ids() to authenticated, service_role;
grant execute on function private.owner_workspace_ids() to authenticated, service_role;
grant execute on function private.client_links() to authenticated, service_role;

-- ───────── 3. 記録を書くたびに「誰の記録か」を決める ─────────

create or replace function public.touch_record() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- 受け取り順をサーバー時刻にそろえる（端末の時計ずれ対策）。誰が入れたかも残す
  new.updated_at := now();
  new.updated_by := auth.uid();
  if new.collection = 'members' then
    new.member_id := new.id;
  elsif new.collection = 'profile' then
    new.member_id := null;
  elsif new.data is not null then
    new.member_id := new.data->>'memberId';
  elsif tg_op = 'UPDATE' then
    -- 削除（data が null）は、元の持ち主のまま
    new.member_id := old.member_id;
  else
    -- サーバーにない記録の削除。本人（client）が送ったものは、本人のものとして置く
    new.member_id := private.my_member_id(new.workspace_id);
  end if;
  return new;
end $$;
revoke all on function public.touch_record() from public, anon, authenticated;

-- すでにある記録にも入れる
update public.records
   set member_id = case when collection = 'members' then id when collection = 'profile' then null else data->>'memberId' end
 where member_id is null;

-- ───────── 4. 招待（1回きり・期限つき） ─────────

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  code_hash text not null unique,
  role text not null check (role in ('coach', 'client')),
  member_id text,
  created_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_by uuid references auth.users(id) on delete set null,
  used_at timestamptz,
  revoked_at timestamptz,
  constraint invites_client_has_member check ((role = 'client') = (member_id is not null))
);
comment on table public.invites is '招待。1回使うと使用済みになり、期限が過ぎると使えない。コードはハッシュだけを持つ';
create index invites_workspace_idx on public.invites (workspace_id, created_at desc);
alter table public.invites enable row level security;
-- 行の方針は置かない（表を直接は読ませない。owner も関数 list_invites を通す）

-- 外された人への知らせ。指導者を外すとき、外す側（グループに残る側）が、その人の端末に残っているグループの記録を
-- 消すかどうかを選ぶ（wipe_device）。外された人の端末は、次に同期しようとしたときにこれを読んで従う。
-- 入り直したら、知らせは消える
create table public.departures (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  wipe_device boolean not null default false,
  departed_at timestamptz not null default now(),
  removed_by uuid references auth.users(id) on delete set null,
  primary key (workspace_id, user_id)
);
comment on table public.departures is '外された人への知らせ。wipe_device が true なら、その人の端末は、グループの記録を端末から消す';
alter table public.departures enable row level security;
-- 行の方針は置かない（関数 remove_member・my_departure だけがさわる）

-- ───────── 5. 行ごとの権限（RLS） ─────────

-- 記録：owner・coach は全件、client は自分の member_id の行だけ
alter policy "members read records" on public.records rename to "read records by role";
alter policy "read records by role" on public.records using (
  workspace_id in (select private.staff_workspace_ids())
  or (workspace_id, member_id) in (select l.workspace_id, l.member_id from private.client_links() l)
);

-- client が書けるのは、自分の記録（6つのコレクション）だけ。人（members）と profile は書けない
alter policy "members insert records" on public.records rename to "insert records by role";
alter policy "insert records by role" on public.records with check (
  workspace_id in (select private.staff_workspace_ids())
  or (
    collection in ('sessions', 'bodies', 'abilities', 'conditions', 'photos', 'activities')
    and (workspace_id, member_id) in (select l.workspace_id, l.member_id from private.client_links() l)
  )
);

alter policy "members update records" on public.records rename to "update records by role";
alter policy "update records by role" on public.records
  using (
    workspace_id in (select private.staff_workspace_ids())
    or (
      collection in ('sessions', 'bodies', 'abilities', 'conditions', 'photos', 'activities')
      and (workspace_id, member_id) in (select l.workspace_id, l.member_id from private.client_links() l)
    )
  )
  with check (
    workspace_id in (select private.staff_workspace_ids())
    or (
      collection in ('sessions', 'bodies', 'abilities', 'conditions', 'photos', 'activities')
      and (workspace_id, member_id) in (select l.workspace_id, l.member_id from private.client_links() l)
    )
  );

-- グループ：名前を変えられるのは owner だけ
alter policy "members can rename workspace" on public.workspaces rename to "owner can rename workspace";
alter policy "owner can rename workspace" on public.workspaces
  using (id in (select private.owner_workspace_ids()))
  with check (id in (select private.owner_workspace_ids()));

-- 参加者の表：自分の行と、owner なら全員分。抜けられるのは owner 以外
alter policy "read own memberships and co-members" on public.workspace_members rename to "read own membership or as owner";
alter policy "read own membership or as owner" on public.workspace_members
  using (user_id = (select auth.uid()) or workspace_id in (select private.owner_workspace_ids()));
alter policy "leave workspace" on public.workspace_members
  using (user_id = (select auth.uid()) and role <> 'owner');

-- 表への権限は必要な分だけにする（ログインしていない人には何も渡さない）
revoke all on public.workspaces, public.workspace_members, public.records, public.invites, public.departures from anon, authenticated;
grant select on public.workspaces to authenticated;
grant update (name) on public.workspaces to authenticated;
grant select, insert, update on public.records to authenticated;

-- ───────── 6. 操作の関数（RPC） ─────────

-- 新しいグループを作り、自分を owner として入れる
create or replace function public.create_workspace(ws_name text default 'PhysLog') returns public.workspaces
language plpgsql security definer set search_path = '' as $$
declare w public.workspaces;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into public.workspaces (name, created_by)
    values (left(coalesce(nullif(trim(ws_name), ''), 'PhysLog'), 80), auth.uid()) returning * into w;
  insert into public.workspace_members (workspace_id, user_id, role) values (w.id, auth.uid(), 'owner');
  return w;
end $$;

-- 招待コードで参加する（コードは1回きり・期限つき。役割はコードで決まる）
create or replace function public.join_workspace(code text) returns public.workspaces
language plpgsql security definer set search_path = '' as $$
declare
  inv public.invites;
  w public.workspaces;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into inv from public.invites i where i.code_hash = private.invite_hash(code) for update;
  if inv.id is null or inv.revoked_at is not null then raise exception 'invite code not found'; end if;
  if inv.used_at is not null then raise exception 'invite code already used'; end if;
  if inv.expires_at <= now() then raise exception 'invite code expired'; end if;
  if exists (select 1 from public.workspace_members m where m.workspace_id = inv.workspace_id and m.user_id = auth.uid()) then
    raise exception 'already a member';
  end if;
  if inv.role = 'client' and exists (select 1 from public.workspace_members m where m.workspace_id = inv.workspace_id and m.member_id = inv.member_id) then
    raise exception 'member already linked';
  end if;
  insert into public.workspace_members (workspace_id, user_id, role, member_id)
    values (inv.workspace_id, auth.uid(), inv.role, inv.member_id);
  -- 前に外されたときの知らせ（端末の記録を消す、など）は、入り直したら無効にする
  delete from public.departures d where d.workspace_id = inv.workspace_id and d.user_id = auth.uid();
  update public.invites set used_by = auth.uid(), used_at = now() where id = inv.id;
  select * into w from public.workspaces where id = inv.workspace_id;
  return w;
end $$;

-- 招待コードの中身を確かめる（参加する前に、どのグループに・どの役割で入るのかを見せるため）。コードは使われない
create or replace function public.invite_info(code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare inv public.invites;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into inv from public.invites i where i.code_hash = private.invite_hash(code);
  if inv.id is null or inv.revoked_at is not null then raise exception 'invite code not found'; end if;
  if inv.used_at is not null then raise exception 'invite code already used'; end if;
  if inv.expires_at <= now() then raise exception 'invite code expired'; end if;
  return jsonb_build_object(
    'workspace_name', (select w.name from public.workspaces w where w.id = inv.workspace_id),
    'role', inv.role,
    'member_name', (select r.data ->> 'name' from public.records r
                     where r.workspace_id = inv.workspace_id and r.collection = 'members' and r.id = inv.member_id and not r.deleted),
    'already_member', exists (select 1 from public.workspace_members m where m.workspace_id = inv.workspace_id and m.user_id = auth.uid())
  );
end $$;

-- 招待コードを作る。本人（client）の招待は owner と coach、指導者（coach）の招待は owner だけ。
-- コードはこの戻り値でしか見られない
create or replace function public.create_invite(ws uuid, invite_role text, invite_member_id text default null, valid_days integer default 7)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; -- 読み間違えやすい 0・1・I・O を除いた32文字
  pos constant integer[] := array[0, 1, 2, 3, 4, 5, 9, 10, 11, 12]; -- UUID のうち乱数だけのバイト
  b bytea;
  c text := '';
  i integer;
  expires timestamptz;
  new_id uuid;
  r text := private.my_role(ws);
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if r is null or r not in ('owner', 'coach') then raise exception 'not allowed'; end if;
  if invite_role is null or invite_role not in ('coach', 'client') then raise exception 'invalid role'; end if;
  if invite_role = 'coach' and r <> 'owner' then raise exception 'not allowed'; end if;
  if invite_role = 'client' then
    if coalesce(invite_member_id, '') = '' then raise exception 'member required'; end if;
    if not exists (select 1 from public.records r where r.workspace_id = ws and r.collection = 'members' and r.id = invite_member_id and not r.deleted) then
      raise exception 'member not found';
    end if;
    if exists (select 1 from public.workspace_members m where m.workspace_id = ws and m.member_id = invite_member_id) then
      raise exception 'member already linked';
    end if;
    -- 同じ人あての古い招待は取り消す（生きているコードは1人につき1つ）
    update public.invites v set revoked_at = now()
     where v.workspace_id = ws and v.role = 'client' and v.member_id = invite_member_id and v.used_at is null and v.revoked_at is null;
  else
    invite_member_id := null;
  end if;
  expires := now() + make_interval(days => least(greatest(coalesce(valid_days, 7), 1), 30));
  b := uuid_send(gen_random_uuid());
  foreach i in array pos loop
    c := c || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
  end loop;
  insert into public.invites (workspace_id, code_hash, role, member_id, created_by, expires_at)
    values (ws, private.invite_hash(c), invite_role, invite_member_id, auth.uid(), expires)
    returning id into new_id;
  return jsonb_build_object('id', new_id, 'code', c, 'role', invite_role, 'member_id', invite_member_id, 'expires_at', expires);
end $$;

-- 使われていない招待を取り消す（owner は全部、coach は自分が作ったものだけ）
create or replace function public.revoke_invite(target uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  inv public.invites;
  r text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into inv from public.invites v where v.id = target;
  r := private.my_role(inv.workspace_id);
  if inv.id is null or r is null or not (r = 'owner' or (r = 'coach' and inv.created_by = auth.uid())) then
    raise exception 'not allowed';
  end if;
  update public.invites v set revoked_at = now() where v.id = target and v.used_at is null and v.revoked_at is null;
end $$;

-- 招待の一覧（owner は全部、coach は自分が作ったものだけ。取り消したものは出さない）
create or replace function public.list_invites(ws uuid)
returns table (id uuid, role text, member_id text, created_at timestamptz, expires_at timestamptz, used_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select v.id, v.role, v.member_id, v.created_at, v.expires_at, v.used_at
    from public.invites v
   where v.workspace_id = ws and v.revoked_at is null
     and (private.my_role(ws) = 'owner' or (private.my_role(ws) = 'coach' and v.created_by = auth.uid()))
   order by v.created_at desc
   limit 100
$$;

-- 参加者の一覧（owner だけ。誰か分かるようにメールアドレスも返す）
create or replace function public.list_members(ws uuid)
returns table (user_id uuid, email text, role text, member_id text, joined_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select m.user_id, u.email::text, m.role, m.member_id, m.joined_at
    from public.workspace_members m join auth.users u on u.id = m.user_id
   where m.workspace_id = ws and private.my_role(ws) = 'owner'
   order by m.joined_at
$$;

-- アカウントが結びついている人（members の id）。本人を招くとき、まだの人だけを選べるようにする（owner・coach だけ）
create or replace function public.linked_member_ids(ws uuid) returns setof text
language sql stable security definer set search_path = '' as $$
  select m.member_id from public.workspace_members m
   where m.workspace_id = ws and m.member_id is not null and private.my_role(ws) in ('owner', 'coach')
$$;

-- coach・client を外す（owner だけ）。記録はグループに残る。
-- 指導者を外すときは、その人の端末に残っているグループの記録を消すかどうかを、外す側が選ぶ（wipe_device。何も指定しなければ残す）。
-- 本人（client）の端末にあるのは本人の記録だけなので、本人を外すときは消さない
create or replace function public.remove_member(ws uuid, target uuid, wipe_device boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare gone text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if private.my_role(ws) is distinct from 'owner' then raise exception 'not allowed'; end if;
  delete from public.workspace_members m where m.workspace_id = ws and m.user_id = target and m.role <> 'owner'
    returning m.role into gone;
  if gone is null then raise exception 'member not found'; end if;
  insert into public.departures (workspace_id, user_id, wipe_device, removed_by)
    values (ws, target, gone = 'coach' and coalesce(wipe_device, false), auth.uid())
    on conflict (workspace_id, user_id) do update
      set wipe_device = excluded.wipe_device, departed_at = now(), removed_by = excluded.removed_by;
end $$;

-- 外された人の端末が読む知らせ：端末にあるグループの記録を消すように、外した側が選んだか
create or replace function public.my_departure(ws uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select d.wipe_device from public.departures d where d.workspace_id = ws and d.user_id = auth.uid()), false)
$$;

-- 自分から抜ける（owner は抜けられない）。
-- 本人（client）は、自分の記録をグループに残すか消すかを選べる（何も指定しなければ残す）。
-- 消すときは、行を残したまま中身を空にして「削除済み」にする。行そのものを消すと、ほかの端末に削除が届かず、
-- 古い写しが残って、つなぎ直したときに戻ってきてしまうため。
-- 人（members）の行は残る。指導者が抜けるときは、どちらを選んでも記録は変わらない
create or replace function public.leave_workspace(ws uuid, keep_records boolean default true) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r text := private.my_role(ws);
  mine text := private.my_member_id(ws);
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if r = 'owner' then raise exception 'owner cannot leave'; end if;
  if r = 'client' and mine is not null and not coalesce(keep_records, true) then
    update public.records x set data = null, deleted = true
     where x.workspace_id = ws and x.member_id = mine and not x.deleted
       and x.collection in ('sessions', 'bodies', 'abilities', 'conditions', 'photos', 'activities');
  end if;
  delete from public.workspace_members m where m.workspace_id = ws and m.user_id = auth.uid();
end $$;

-- 自分が入っているグループと、そこでの役割（別の端末でログインしたときの再接続にも使う）
create or replace function public.my_workspaces()
returns table (id uuid, name text, role text, member_id text)
language sql stable security definer set search_path = '' as $$
  select w.id, w.name, m.role, m.member_id
    from public.workspace_members m join public.workspaces w on w.id = m.workspace_id
   where m.user_id = auth.uid()
   order by m.joined_at
$$;

-- 記録を受け取る（同期）。前回の続きから、(更新時刻, コレクション, ID) の順に max_rows 件まで返す。
-- 更新時刻だけで続きを決めると、同じ時刻の記録（1回の送信や、まとめての削除）がページの境目で取りこぼされる。
-- 呼んだ人の権限（RLS）で読むので、本人に返るのは自分の記録だけ
create or replace function public.pull_records(ws uuid, after_ts timestamptz default null, after_collection text default '', after_id text default '', max_rows integer default 1000)
returns table (collection text, id text, data jsonb, deleted boolean, updated_at timestamptz)
language sql stable set search_path = '' as $$
  select r.collection, r.id, r.data, r.deleted, r.updated_at
    from public.records r
   where r.workspace_id = ws
     and (after_ts is null or (r.updated_at, r.collection, r.id) > (after_ts, coalesce(after_collection, ''), coalesce(after_id, '')))
   order by r.updated_at, r.collection, r.id
   limit least(greatest(coalesce(max_rows, 1000), 1), 1000)
$$;

revoke all on function public.create_workspace(text) from public, anon;
revoke all on function public.join_workspace(text) from public, anon;
revoke all on function public.invite_info(text) from public, anon;
revoke all on function public.create_invite(uuid, text, text, integer) from public, anon;
revoke all on function public.revoke_invite(uuid) from public, anon;
revoke all on function public.list_invites(uuid) from public, anon;
revoke all on function public.list_members(uuid) from public, anon;
revoke all on function public.remove_member(uuid, uuid, boolean) from public, anon;
revoke all on function public.my_departure(uuid) from public, anon;
revoke all on function public.linked_member_ids(uuid) from public, anon;
revoke all on function public.leave_workspace(uuid, boolean) from public, anon;
revoke all on function public.my_workspaces() from public, anon;
revoke all on function public.pull_records(uuid, timestamptz, text, text, integer) from public, anon;
grant execute on function public.create_workspace(text) to authenticated;
grant execute on function public.join_workspace(text) to authenticated;
grant execute on function public.invite_info(text) to authenticated;
grant execute on function public.create_invite(uuid, text, text, integer) to authenticated;
grant execute on function public.revoke_invite(uuid) to authenticated;
grant execute on function public.list_invites(uuid) to authenticated;
grant execute on function public.list_members(uuid) to authenticated;
grant execute on function public.remove_member(uuid, uuid, boolean) to authenticated;
grant execute on function public.my_departure(uuid) to authenticated;
grant execute on function public.linked_member_ids(uuid) to authenticated;
grant execute on function public.leave_workspace(uuid, boolean) to authenticated;
grant execute on function public.my_workspaces() to authenticated;
grant execute on function public.pull_records(uuid, timestamptz, text, text, integer) to authenticated;
