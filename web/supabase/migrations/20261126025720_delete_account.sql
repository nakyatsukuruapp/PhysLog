-- PhysLog：アカウントの削除（アプリの中から、本人が自分のアカウントを消す）
--
-- 決まり（Ryota・2026-11-26）：アカウントは消し、その人は「unknown user」と表示して、記録は残す。
--   ・本人（client）：グループの名簿のその人の名前を「unknown user」に変える。記録はグループに残る
--   ・管理者（owner）：グループと記録は残る。いちばん古くから参加している指導者が管理者を引き継ぐ。
--     指導者がいなければ、管理者のいないグループとして残る（本人は自分の記録を引き続き読み書きできる）
--   ・指導者（coach）：参加が外れるだけ。グループの記録は変わらない
--   ・その人が作った、まだ使われていない招待は消える。離れたときの控え・預かりも消える

-- グループを作った人のアカウントが消えても、グループ（と全員の記録）を消さない
alter table public.workspaces alter column created_by drop not null;
alter table public.workspaces drop constraint workspaces_created_by_fkey;
alter table public.workspaces
  add constraint workspaces_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
comment on column public.workspaces.created_by is 'グループを作った人。アカウントが削除されたら空になる（グループは残る）';

create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  m record;
  heir uuid;
begin
  if me is null then raise exception 'not signed in'; end if;
  for m in select wm.workspace_id, wm.role, wm.member_id from public.workspace_members wm where wm.user_id = me loop
    if m.role = 'client' then
      -- 名簿の名前を「unknown user」に（記録はそのまま）
      update public.records x set data = jsonb_set(x.data, '{name}', to_jsonb('unknown user'::text))
       where x.workspace_id = m.workspace_id and x.collection = 'members' and x.id = m.member_id and not x.deleted and x.data is not null;
    elsif m.role = 'owner' then
      -- 管理者を引き継ぐ：いちばん古くから参加している指導者
      select wm.user_id into heir from public.workspace_members wm
       where wm.workspace_id = m.workspace_id and wm.role = 'coach'
       order by wm.joined_at, wm.user_id limit 1;
      delete from public.workspace_members wm where wm.workspace_id = m.workspace_id and wm.user_id = me;
      if heir is not null then
        update public.workspace_members wm set role = 'owner' where wm.workspace_id = m.workspace_id and wm.user_id = heir;
      end if;
    end if;
  end loop;
  -- 参加・作った招待・離れたときの控えと預かりは、アカウントと一緒に消える（外部キーの on delete cascade）。
  -- 記録の「最後に書いた人」・グループの「作った人」は空になる（on delete set null）
  -- 記録のトリガー（touch_record）は、書いた人に auth.uid() を入れる。消す人のままだと、
  -- 「最後に書いた人」を空にする処理（on delete set null）がその人を書き戻してしまうので、先にログイン情報を外す
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  delete from auth.users u where u.id = me;
end $$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
