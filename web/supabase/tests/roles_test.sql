-- PhysLog：役割ごとの権限のテスト（owner・coach・client 3人・部外者・ログインなし）
--
-- テスト用の利用者と記録を、1つの処理の中で作り、最後にわざと例外を出してすべて巻き戻す。
-- データベースには何も残らない。結果は例外の本文に入る（ROLLBACK_OK pass=… fail=…）。
--
-- 手元で流す：  tests/run_local.sh
-- 本番で流す：  このファイルの中身をそのまま SQL として実行する（失敗した行だけが返る）
--
-- 1行の形：  誰が | 期待 | 説明 | SQL
--   誰が … O=owner  C=coach  A・B・D=client（D は指導者が招く）  X=部外者（ログイン済み）  N=ログインなし  P=管理者（権限の確認用）
--   期待 … rows=件数 / val=値 / save=名前（値を {名前} として後で使う） / err=SQLSTATE / msg=エラー文の一部
--   SQL  … UPSERT <コレクション> <id> <JSON> ＝アプリの同期と同じ形の upsert、TOMB <コレクション> <id> ＝削除（data を null に）、
--           IDS ＝そのグループで見える記録の一覧、COUNT ＝その件数
do $test$
declare
  steps text[] := array[
    -- ───── 準備：グループ・人・招待・参加 ─────
    $s$O | save=ws | グループを作る | select (public.create_workspace('  Test Gym  ')).id::text$s$,
    $s$P | val=Test Gym/NULL | 名前は前後の空白を落とす。旧・共通コードは作られない | select name || '/' || coalesce(invite_code, 'NULL') from public.workspaces where id = '{ws}'$s$,
    $s$O | val=owner/NULL | 作った人は owner | select role || '/' || coalesce(member_id, 'NULL') from public.my_workspaces() where id = '{ws}'$s$,
    $s$O | rows=1 | 人（A）を足す | UPSERT members mA {"id":"mA","name":"Client A"}$s$,
    $s$O | rows=1 | 人（B）を足す | UPSERT members mB {"id":"mB","name":"Client B"}$s$,
    $s$O | rows=1 | 人（owner 自身）を足す | UPSERT members mO {"id":"mO","name":"Owner"}$s$,
    $s$O | rows=1 | profile を書く | UPSERT profile profile {"name":"Owner","sport":"basketball"}$s$,
    $s$O | save=codeC | 指導者の招待を作る | select public.create_invite('{ws}', 'coach') ->> 'code'$s$,
    $s$P | val=10/true | コードは10文字で、紛らわしい文字を含まない | select length('{codeC}') || '/' || ('{codeC}' ~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{10}$')::text$s$,
    $s$P | val=0 | コードそのものは保存しない（ハッシュだけ） | select count(*)::text from public.invites where code_hash = '{codeC}'$s$,
    $s$C | val={ws} | 指導者が参加する | select (public.join_workspace('{codeC}')).id::text$s$,
    $s$O | save=codeA | 本人Aの招待を作る | select public.create_invite('{ws}', 'client', 'mA') ->> 'code'$s$,
    $s$A | val=Test Gym/client/Client A/false | 参加する前に、招待の中身を確かめられる | select (i ->> 'workspace_name') || '/' || (i ->> 'role') || '/' || (i ->> 'member_name') || '/' || (i ->> 'already_member') from public.invite_info('{codeA}') i$s$,
    $s$P | val=unused | 確かめただけでは、コードは使われない | select case when used_at is null then 'unused' else 'used' end from public.invites where code_hash = private.invite_hash('{codeA}')$s$,
    $s$C | val=true | 参加済みの人が確かめると、参加済みと分かる | select public.invite_info('{codeA}') ->> 'already_member'$s$,
    $s$N | err=42501 | ログインなしでは招待の中身を確かめられない | select public.invite_info('{codeA}')$s$,
    $s$A | val={ws} | 本人Aが参加する（小文字・ハイフン・空白が入っていても通る） | select (public.join_workspace(' ' || lower(substr('{codeA}', 1, 5)) || '-' || substr('{codeA}', 6) || ' ')).id::text$s$,
    $s$O | save=codeB | 本人Bの招待を作る | select public.create_invite('{ws}', 'client', 'mB') ->> 'code'$s$,
    $s$B | val={ws} | 本人Bが参加する | select (public.join_workspace('{codeB}')).id::text$s$,
    $s$C | val=coach/NULL | 指導者の役割 | select role || '/' || coalesce(member_id, 'NULL') from public.my_workspaces()$s$,
    $s$A | val=client/mA | 本人Aの役割と、誰の記録か | select role || '/' || coalesce(member_id, 'NULL') from public.my_workspaces()$s$,
    $s$B | val=client/mB | 本人Bの役割と、誰の記録か | select role || '/' || coalesce(member_id, 'NULL') from public.my_workspaces()$s$,
    $s$X | val=0 | 部外者はどのグループにも入っていない | select count(*)::text from public.my_workspaces()$s$,
    $s$O | rows=1 | owner が本人Aの記録を入れる | UPSERT sessions sA1 {"id":"sA1","memberId":"mA","date":"2026-11-24","exercises":[]}$s$,
    $s$C | rows=1 | 指導者が本人Bの記録を代わりに入れる | UPSERT sessions sB1 {"id":"sB1","memberId":"mB","date":"2026-11-24","exercises":[]}$s$,
    $s$O | rows=1 | owner が自分の記録を入れる | UPSERT bodies bO1 {"id":"bO1","memberId":"mO","date":"2026-11-24","weight":70}$s$,
    $s$P | val=mB/{uC} | 代わりに入れた記録は本人のもの。入れた人も残る | select member_id || '/' || updated_by from public.records where workspace_id = '{ws}' and id = 'sB1'$s$,
    $s$P | val=mA | 人（members）の行は、その人のものとして扱う | select member_id from public.records where workspace_id = '{ws}' and collection = 'members' and id = 'mA'$s$,
    $s$P | val=NULL | profile は誰のものでもない | select coalesce(member_id, 'NULL') from public.records where workspace_id = '{ws}' and collection = 'profile'$s$,

    -- ───── 読む ─────
    $s$O | val=bodies/bO1,members/mA,members/mB,members/mO,profile/profile,sessions/sA1,sessions/sB1 | owner は全件読める | IDS$s$,
    $s$C | val=bodies/bO1,members/mA,members/mB,members/mO,profile/profile,sessions/sA1,sessions/sB1 | 指導者は全件読める | IDS$s$,
    $s$A | val=members/mA,sessions/sA1 | 本人Aは自分の分だけ読める | IDS$s$,
    $s$B | val=members/mB,sessions/sB1 | 本人Bは自分の分だけ読める | IDS$s$,
    $s$X | val= | 部外者は何も読めない | IDS$s$,
    $s$N | err=42501 | ログインなしでは読めない | COUNT$s$,

    -- ───── 足す ─────
    $s$A | rows=1 | 本人Aが自分の記録を足す | UPSERT sessions sA2 {"id":"sA2","memberId":"mA","date":"2026-11-25","exercises":[]}$s$,
    $s$A | rows=1 | 本人Aが自分の体組成を足す | UPSERT bodies bA1 {"id":"bA1","memberId":"mA","date":"2026-11-25","weight":60,"bodyFat":20}$s$,
    $s$P | val=mA/{uA} | 本人が入れた記録の持ち主と、入れた人 | select member_id || '/' || updated_by from public.records where workspace_id = '{ws}' and id = 'sA2'$s$,
    $s$A | err=42501 | 本人Aが、Bの記録として足す | UPSERT sessions sA3 {"id":"sA3","memberId":"mB"}$s$,
    $s$A | err=42501 | 本人Aが、誰のものか書かずに足す | UPSERT sessions sA4 {"id":"sA4"}$s$,
    $s$A | err=42501 | 本人Aが、人を足す | UPSERT members mZ {"id":"mZ","name":"Z"}$s$,
    $s$A | err=42501 | 本人Aが、profile を書く | UPSERT profile profile {"name":"A"}$s$,
    $s$A | err=42501 | 本人Aが、自分の名前（members）を書き換える | UPSERT members mA {"id":"mA","name":"Renamed"}$s$,
    $s$A | err=42501 | member_id の列だけ自分にして、中身はBの記録 | insert into public.records (workspace_id, collection, id, data, member_id) values ('{ws}', 'sessions', 'sA5', '{"id":"sA5","memberId":"mB"}', 'mA')$s$,
    $s$A | rows=1 | member_id の列にBと書いても、中身が自分なら自分の記録になる | insert into public.records (workspace_id, collection, id, data, member_id) values ('{ws}', 'sessions', 'sA6', '{"id":"sA6","memberId":"mA"}', 'mB')$s$,
    $s$P | val=mA | 列に書いた値は使われない | select member_id from public.records where workspace_id = '{ws}' and id = 'sA6'$s$,
    $s$X | err=42501 | 部外者が足す | UPSERT sessions sX1 {"id":"sX1","memberId":"mA"}$s$,
    $s$N | err=42501 | ログインなしで足す | UPSERT sessions sN1 {"id":"sN1","memberId":"mA"}$s$,

    -- ───── 直す ─────
    $s$A | rows=1 | 本人Aが自分の記録を直す | UPSERT sessions sA1 {"id":"sA1","memberId":"mA","date":"2026-11-24","memo":"edited by A","exercises":[]}$s$,
    $s$P | val=edited by A/{uA} | 直した内容と、直した人 | select (data ->> 'memo') || '/' || updated_by from public.records where workspace_id = '{ws}' and id = 'sA1'$s$,
    $s$A | rows=0 | 本人AがBの記録を UPDATE（見えないので0件） | update public.records set data = '{"id":"sB1","memberId":"mB","memo":"x"}' where workspace_id = '{ws}' and id = 'sB1'$s$,
    $s$A | err=42501 | 本人AがBの記録のIDに上書きする | UPSERT sessions sB1 {"id":"sB1","memberId":"mA","memo":"hijack"}$s$,
    $s$A | err=42501 | 本人Aが自分の記録をBのものに付け替える | UPSERT sessions sA2 {"id":"sA2","memberId":"mB"}$s$,
    $s$A | rows=0 | 本人Aが自分の members 行を UPDATE | update public.records set data = '{"id":"mA","name":"Renamed"}' where workspace_id = '{ws}' and collection = 'members' and id = 'mA'$s$,
    $s$P | val=Client A | 名前は変わっていない | select data ->> 'name' from public.records where workspace_id = '{ws}' and collection = 'members' and id = 'mA'$s$,
    $s$P | val=mB/NULL | Bの記録は変わっていない | select member_id || '/' || coalesce(data ->> 'memo', 'NULL') from public.records where workspace_id = '{ws}' and id = 'sB1'$s$,
    $s$C | rows=1 | 指導者が本人Aの記録を直す | UPSERT sessions sA1 {"id":"sA1","memberId":"mA","date":"2026-11-24","memo":"edited by coach","exercises":[]}$s$,
    $s$A | val=edited by coach | 指導者が直した内容が本人に見える | select data ->> 'memo' from public.records where workspace_id = '{ws}' and id = 'sA1'$s$,
    $s$O | rows=1 | owner が本人Bの記録を直す | UPSERT sessions sB1 {"id":"sB1","memberId":"mB","date":"2026-11-24","memo":"edited by owner","exercises":[]}$s$,
    $s$C | rows=1 | 指導者が人の名前を直す | UPSERT members mA {"id":"mA","name":"Client A2"}$s$,
    $s$A | val=Client A2 | 直した名前が本人に見える | select data ->> 'name' from public.records where workspace_id = '{ws}' and collection = 'members' and id = 'mA'$s$,

    -- ───── 消す（data を null にする） ─────
    $s$A | rows=1 | 本人Aが自分の記録を消す | TOMB sessions sA2$s$,
    $s$P | val=mA/true | 消した記録の持ち主は変わらない | select member_id || '/' || deleted from public.records where workspace_id = '{ws}' and id = 'sA2'$s$,
    $s$A | err=42501 | 本人AがBの記録を消す | TOMB sessions sB1$s$,
    $s$A | rows=1 | 本人Aが、サーバーにない記録の削除を送る | TOMB sessions sA9$s$,
    $s$P | val=mA | その削除は本人のものとして置かれる | select member_id from public.records where workspace_id = '{ws}' and id = 'sA9'$s$,
    $s$C | rows=1 | 指導者が本人Bの記録を消す | TOMB sessions sB1$s$,
    $s$B | val=true | 削除が本人Bに届く | select deleted::text from public.records where workspace_id = '{ws}' and id = 'sB1'$s$,
    $s$C | rows=1 | 指導者が、サーバーにない記録の削除を送る | TOMB sessions sC9$s$,
    $s$P | val=NULL | その削除は誰のものでもない | select coalesce(member_id, 'NULL') from public.records where workspace_id = '{ws}' and id = 'sC9'$s$,
    $s$C | rows=1 | 指導者が、消した記録を入れ直す | UPSERT sessions sB1 {"id":"sB1","memberId":"mB","date":"2026-11-24","exercises":[]}$s$,
    $s$B | val=false | 入れ直しが本人Bに届く | select deleted::text from public.records where workspace_id = '{ws}' and id = 'sB1'$s$,
    $s$A | err=42501 | 行そのものの削除（DELETE）は本人にできない | delete from public.records where workspace_id = '{ws}' and id = 'sA1'$s$,
    $s$O | err=42501 | 行そのものの削除（DELETE）は owner にもできない | delete from public.records where workspace_id = '{ws}' and id = 'sA1'$s$,
    $s$A | val=bodies/bA1,members/mA,sessions/sA1,sessions/sA2,sessions/sA6,sessions/sA9 | ここまでで本人Aに見える記録 | IDS$s$,
    $s$B | val=members/mB,sessions/sB1 | ここまでで本人Bに見える記録 | IDS$s$,
    $s$O | val=12 | owner に見える件数 | COUNT$s$,

    -- ───── 受け取る（同期で使う関数。同じ時刻の記録でも取りこぼさない） ─────
    $s$O | val=12 | 受け取りの関数でも、owner は全件 | select count(*)::text from public.pull_records('{ws}')$s$,
    $s$C | val=12 | 受け取りの関数でも、指導者は全件 | select count(*)::text from public.pull_records('{ws}')$s$,
    $s$A | val=bodies/bA1,members/mA,sessions/sA1,sessions/sA2,sessions/sA6,sessions/sA9 | 受け取りの関数でも、本人は自分の分だけ | select string_agg(collection || '/' || id, ',' order by collection, id) from public.pull_records('{ws}')$s$,
    $s$X | val=0 | 部外者は何も受け取れない | select count(*)::text from public.pull_records('{ws}')$s$,
    $s$N | err=42501 | ログインなしでは受け取れない | select count(*) from public.pull_records('{ws}')$s$,
    $s$O | val=12/12 | 同じ時刻の記録を5件ずつ受け取っても、抜けも重複もない | with recursive pages as (select 1 as n, (select jsonb_agg(to_jsonb(p) order by p.updated_at, p.collection, p.id) from public.pull_records('{ws}', null, '', '', 5) p) as page union all select pages.n + 1, (select jsonb_agg(to_jsonb(p) order by p.updated_at, p.collection, p.id) from public.pull_records('{ws}', (pages.page -> -1 ->> 'updated_at')::timestamptz, pages.page -> -1 ->> 'collection', pages.page -> -1 ->> 'id', 5) p) from pages where jsonb_array_length(pages.page) = 5) select count(*) || '/' || count(distinct (x ->> 'collection') || '/' || (x ->> 'id')) from pages, jsonb_array_elements(pages.page) x$s$,
    $s$O | val=3 | 5件ずつなら3回で受け取り終わる | with recursive pages as (select 1 as n, (select jsonb_agg(to_jsonb(p) order by p.updated_at, p.collection, p.id) from public.pull_records('{ws}', null, '', '', 5) p) as page union all select pages.n + 1, (select jsonb_agg(to_jsonb(p) order by p.updated_at, p.collection, p.id) from public.pull_records('{ws}', (pages.page -> -1 ->> 'updated_at')::timestamptz, pages.page -> -1 ->> 'collection', pages.page -> -1 ->> 'id', 5) p) from pages where jsonb_array_length(pages.page) = 5) select count(*)::text from pages where page is not null$s$,
    $s$O | val=9 | 続きは、(時刻, コレクション, ID) の次から返る | select count(*)::text from public.pull_records('{ws}', now(), 'members', 'mA')$s$,
    $s$O | val=12 | 時刻だけの続き（前の形の端末）は、同じ時刻の分をもう一度返す | select count(*)::text from public.pull_records('{ws}', now())$s$,
    $s$O | val=0 | 最後より後は、何も返らない | select count(*)::text from public.pull_records('{ws}', now() + interval '1 hour')$s$,

    -- ───── グループと、参加者・招待の表 ─────
    $s$A | val=1 | 本人は自分のグループを読める | select count(*)::text from public.workspaces$s$,
    $s$X | val=0 | 部外者はグループを読めない | select count(*)::text from public.workspaces$s$,
    $s$A | rows=0 | グループ名の変更（本人） | update public.workspaces set name = 'x' where id = '{ws}'$s$,
    $s$C | rows=0 | グループ名の変更（指導者） | update public.workspaces set name = 'x' where id = '{ws}'$s$,
    $s$O | rows=1 | グループ名の変更（owner） | update public.workspaces set name = 'Test Gym 2' where id = '{ws}'$s$,
    $s$O | err=42501 | 名前以外の列は owner にも変えられない | update public.workspaces set created_by = '{uA}' where id = '{ws}'$s$,
    $s$A | err=42501 | 参加者の表を直接読む | select count(*) from public.workspace_members$s$,
    $s$A | err=42501 | 自分の役割を owner に書き換える | update public.workspace_members set role = 'owner' where user_id = '{uA}'$s$,
    $s$X | err=42501 | 自分を参加者に足す | insert into public.workspace_members (workspace_id, user_id, role) values ('{ws}', '{uX}', 'owner')$s$,
    $s$A | err=42501 | 参加者の行を直接消す | delete from public.workspace_members where workspace_id = '{ws}'$s$,
    $s$O | err=42501 | 招待の表を直接読む（owner でも） | select count(*) from public.invites$s$,
    $s$X | err=42501 | 招待の表に直接書く | insert into public.invites (workspace_id, code_hash, role, expires_at) values ('{ws}', 'x', 'coach', now() + interval '1 day')$s$,
    $s$O | val=4/4 | 参加者の一覧（owner）。メールアドレスつき | select count(*) || '/' || count(*) filter (where email like '%@%') from public.list_members('{ws}')$s$,
    $s$C | val=0 | 参加者の一覧（指導者には出さない） | select count(*)::text from public.list_members('{ws}')$s$,
    $s$A | val=0 | 参加者の一覧（本人には出さない） | select count(*)::text from public.list_members('{ws}')$s$,
    $s$O | val=3 | 招待の一覧（owner） | select count(*)::text from public.list_invites('{ws}')$s$,
    $s$C | val=0 | 招待の一覧（指導者に見えるのは、自分が作ったものだけ） | select count(*)::text from public.list_invites('{ws}')$s$,
    $s$A | val=0 | 招待の一覧（本人には出さない） | select count(*)::text from public.list_invites('{ws}')$s$,
    $s$C | msg=not allowed | 指導者は、指導者を招けない | select public.create_invite('{ws}', 'coach')$s$,
    $s$A | msg=not allowed | 本人は、指導者を招けない | select public.create_invite('{ws}', 'coach')$s$,
    $s$A | msg=not allowed | 本人は、本人も招けない | select public.create_invite('{ws}', 'client', 'mO')$s$,
    $s$X | msg=not allowed | 招待を作る（部外者） | select public.create_invite('{ws}', 'coach')$s$,
    $s$C | msg=not allowed | 人を外す（指導者） | select public.remove_member('{ws}', '{uA}')$s$,
    $s$A | msg=not allowed | 人を外す（本人） | select public.remove_member('{ws}', '{uB}')$s$,
    $s$O | msg=member not found | owner は自分を外せない | select public.remove_member('{ws}', '{uO}')$s$,
    $s$O | msg=owner cannot leave | owner は抜けられない | select public.leave_workspace('{ws}')$s$,

    -- ───── 招待コードのきまり ─────
    $s$X | msg=already used | 使用済みのコードは、中身も確かめられない | select public.invite_info('{codeA}')$s$,
    $s$X | msg=not found | でたらめなコードは、中身も確かめられない | select public.invite_info('ZZZZZ-ZZZZZ')$s$,
    $s$X | msg=already used | 使用済みのコードは使えない | select public.join_workspace('{codeA}')$s$,
    $s$X | msg=not found | でたらめなコードは使えない | select public.join_workspace('ABCDE-FGHJK')$s$,
    $s$X | msg=not found | 空のコードは使えない | select public.join_workspace('')$s$,
    $s$O | msg=member already linked | 連携済みの人あての招待は作れない | select public.create_invite('{ws}', 'client', 'mA')$s$,
    $s$O | msg=member not found | いない人あての招待は作れない | select public.create_invite('{ws}', 'client', 'nobody')$s$,
    $s$O | msg=member required | 本人の招待には、誰の記録かが要る | select public.create_invite('{ws}', 'client')$s$,
    $s$O | msg=invalid role | owner の招待は作れない | select public.create_invite('{ws}', 'owner')$s$,
    $s$O | save=codeO1 | owner 自身の記録あてに招待を作る | select public.create_invite('{ws}', 'client', 'mO') ->> 'code'$s$,
    $s$O | save=codeO2 | 同じ人あてに出し直す | select public.create_invite('{ws}', 'client', 'mO') ->> 'code'$s$,
    $s$X | msg=not found | 出し直す前の古いコードは使えない | select public.join_workspace('{codeO1}')$s$,
    $s$C | msg=already a member | 参加済みの人は、別の招待で入り直せない | select public.join_workspace('{codeO2}')$s$,
    $s$P | val=unused | そのとき、コードは使われたことにならない | select case when used_at is null then 'unused' else 'used' end from public.invites where code_hash = private.invite_hash('{codeO2}')$s$,
    $s$O | save=invO2 | 使われていない招待を一覧から探す | select id::text from public.list_invites('{ws}') where member_id = 'mO' and used_at is null$s$,
    $s$C | msg=not allowed | 指導者は、ほかの人が作った招待を取り消せない | select public.revoke_invite('{invO2}')$s$,
    $s$A | msg=not allowed | 本人は、招待を取り消せない | select public.revoke_invite('{invO2}')$s$,
    $s$O | rows=1 | 招待の取り消し（owner） | select public.revoke_invite('{invO2}')$s$,
    $s$X | msg=not found | 取り消したコードは使えない | select public.join_workspace('{codeO2}')$s$,
    $s$O | save=codeE | 期限1日の招待を作る | select public.create_invite('{ws}', 'coach', null, 1) ->> 'code'$s$,
    $s$P | rows=1 | （期限を過去にする） | update public.invites set expires_at = now() - interval '1 minute' where code_hash = private.invite_hash('{codeE}')$s$,
    $s$X | msg=expired | 期限切れのコードは、中身も確かめられない | select public.invite_info('{codeE}')$s$,
    $s$X | msg=expired | 期限切れのコードは使えない | select public.join_workspace('{codeE}')$s$,
    $s$O | val=7 | 期限は既定で7日 | select round(extract(epoch from ((public.create_invite('{ws}', 'coach') ->> 'expires_at')::timestamptz - now())) / 86400)::text$s$,
    $s$O | val=30 | 期限は最長30日 | select round(extract(epoch from ((public.create_invite('{ws}', 'coach', null, 999) ->> 'expires_at')::timestamptz - now())) / 86400)::text$s$,
    $s$X | val=0 | 参加に失敗した部外者は、何も読めないまま | select count(*)::text from public.records$s$,

    -- ───── 指導者も、本人を招ける ─────
    $s$C | rows=1 | 指導者が人（D）を足す | UPSERT members mD {"id":"mD","name":"Client D"}$s$,
    $s$C | save=codeD | 指導者が本人Dの招待を作る | select public.create_invite('{ws}', 'client', 'mD') ->> 'code'$s$,
    $s$C | val=1 | 指導者に見える招待は、自分が作ったものだけ | select count(*)::text from public.list_invites('{ws}')$s$,
    $s$O | val=1 | owner には、指導者が作った招待も見える | select count(*)::text from public.list_invites('{ws}') where member_id = 'mD'$s$,
    $s$C | val=mA,mB | 指導者に、アカウントが結びつき済みの人が分かる | select string_agg(x, ',' order by x) from public.linked_member_ids('{ws}') x$s$,
    $s$O | val=mA,mB | owner にも分かる | select string_agg(x, ',' order by x) from public.linked_member_ids('{ws}') x$s$,
    $s$A | val=0 | 本人には、結びつき済みの人を出さない | select count(*)::text from public.linked_member_ids('{ws}')$s$,
    $s$X | val=0 | 部外者には、結びつき済みの人を出さない | select count(*)::text from public.linked_member_ids('{ws}')$s$,
    $s$D | val=Test Gym 2/client/Client D/false | 招かれた本人Dが、招待の中身を確かめる | select (i ->> 'workspace_name') || '/' || (i ->> 'role') || '/' || (i ->> 'member_name') || '/' || (i ->> 'already_member') from public.invite_info('{codeD}') i$s$,
    $s$D | val={ws} | 指導者の招待で、本人Dが参加する | select (public.join_workspace('{codeD}')).id::text$s$,
    $s$D | val=client/mD | 本人Dの役割と、誰の記録か | select role || '/' || coalesce(member_id, 'NULL') from public.my_workspaces()$s$,
    $s$C | val=mA,mB,mD | 結びつき済みの人に、Dが加わる | select string_agg(x, ',' order by x) from public.linked_member_ids('{ws}') x$s$,
    $s$C | msg=member already linked | 指導者も、結びつき済みの人は招けない | select public.create_invite('{ws}', 'client', 'mD')$s$,
    $s$C | save=codeO3 | 指導者が、別の人あての招待を作る | select public.create_invite('{ws}', 'client', 'mO') ->> 'code'$s$,
    $s$C | save=invO3 | 指導者が、自分の招待を一覧から探す | select id::text from public.list_invites('{ws}') where member_id = 'mO' and used_at is null$s$,
    $s$D | msg=not allowed | 本人は、指導者の招待を取り消せない | select public.revoke_invite('{invO3}')$s$,
    $s$C | rows=1 | 指導者は、自分が作った招待を取り消せる | select public.revoke_invite('{invO3}')$s$,
    $s$X | msg=not found | 指導者が取り消したコードは使えない | select public.join_workspace('{codeO3}')$s$,
    $s$C | msg=not allowed | 指導者は、人を外せない | select public.remove_member('{ws}', '{uD}')$s$,

    -- ───── 抜けるときに、記録を残すか消すかを本人が選ぶ ─────
    $s$D | rows=1 | 本人Dが自分の記録を足す | UPSERT sessions sD1 {"id":"sD1","memberId":"mD","date":"2026-11-25","exercises":[]}$s$,
    $s$D | rows=1 | 本人Dが自分の体組成を足す | UPSERT bodies bD1 {"id":"bD1","memberId":"mD","date":"2026-11-25","weight":65}$s$,
    $s$C | rows=1 | 指導者が本人Dの記録を代わりに入れる | UPSERT sessions sD2 {"id":"sD2","memberId":"mD","date":"2026-11-26","exercises":[]}$s$,
    $s$D | rows=1 | 本人Dが、そのうち1件を自分で消しておく | TOMB sessions sD1$s$,
    $s$P | val=4 | ほかの人（A）の、消えていない記録の数 | select count(*)::text from public.records where workspace_id = '{ws}' and member_id = 'mA' and not deleted$s$,
    $s$D | rows=1 | 本人Dが、記録を消して抜ける | select public.leave_workspace('{ws}', false)$s$,
    $s$P | val=3/3 | Dの記録は3件とも、中身が空の「削除済み」になる | select count(*) || '/' || count(*) filter (where deleted and data is null) from public.records where workspace_id = '{ws}' and member_id = 'mD' and collection <> 'members'$s$,
    $s$P | val={uD} | 消したのは本人、と残る（抜けるときに消えた2件） | select string_agg(distinct updated_by::text, ',') from public.records where workspace_id = '{ws}' and id in ('bD1', 'sD2')$s$,
    $s$P | val=false/Client D | 人（members）の行は残る | select deleted || '/' || (data ->> 'name') from public.records where workspace_id = '{ws}' and collection = 'members' and id = 'mD'$s$,
    $s$C | val=true | 削除が、指導者に届く | select bool_and(deleted)::text from public.pull_records('{ws}') where id in ('sD1', 'sD2', 'bD1')$s$,
    $s$P | val=4 | ほかの人（A）の記録は、消えていない | select count(*)::text from public.records where workspace_id = '{ws}' and member_id = 'mA' and not deleted$s$,
    $s$D | val= | 抜けた本人Dは読めない | IDS$s$,
    $s$D | val=0 | 抜けた本人Dは、どのグループにも入っていない | select count(*)::text from public.my_workspaces()$s$,
    $s$D | rows=1 | 入っていない人が「消して抜ける」を呼んでも、何も起きない | select public.leave_workspace('{ws}', false)$s$,
    $s$P | val=4 | そのとき、ほかの人（A）の記録は消えていない | select count(*)::text from public.records where workspace_id = '{ws}' and member_id = 'mA' and not deleted$s$,
    $s$C | val=mA,mB | 抜けた人は、結びつき済みから外れる | select string_agg(x, ',' order by x) from public.linked_member_ids('{ws}') x$s$,

    -- ───── 別のグループとの仕切り ─────
    $s$X | save=w2 | 部外者が自分のグループを作る | select (public.create_workspace('Other')).id::text$s$,
    $s$X | rows=1 | そこに人を足す | insert into public.records (workspace_id, collection, id, data) values ('{w2}', 'members', 'mX', '{"id":"mX","name":"X"}')$s$,
    $s$X | rows=1 | そこに記録を足す | insert into public.records (workspace_id, collection, id, data) values ('{w2}', 'sessions', 'sA1', '{"id":"sA1","memberId":"mX"}')$s$,
    $s$O | val=0 | owner でも、別のグループは読めない | select count(*)::text from public.records where workspace_id = '{w2}'$s$,
    $s$O | err=42501 | owner でも、別のグループには書けない | insert into public.records (workspace_id, collection, id, data) values ('{w2}', 'sessions', 'sO9', '{"id":"sO9","memberId":"mX"}')$s$,
    $s$X | val= | 別のグループの owner は、こちらを読めない | IDS$s$,
    $s$X | err=42501 | 別のグループの owner は、こちらに書けない | UPSERT sessions sX2 {"id":"sX2","memberId":"mA"}$s$,
    $s$X | msg=not allowed | 別のグループの owner は、こちらの招待を作れない | select public.create_invite('{ws}', 'coach')$s$,
    $s$X | msg=member not found | 別のグループの人あての招待は作れない | select public.create_invite('{w2}', 'client', 'mA')$s$,
    $s$X | val=0 | 別のグループの owner は、こちらの参加者を見られない | select count(*)::text from public.list_members('{ws}')$s$,
    $s$A | save=w3 | 本人Aが、自分のグループも作る | select (public.create_workspace('A own')).id::text$s$,
    $s$A | val=bodies/bA1,members/mA,sessions/sA1,sessions/sA2,sessions/sA6,sessions/sA9 | それでも元のグループでは自分の分だけ | IDS$s$,
    $s$A | err=42501 | 元のグループでは、他人の分は書けないまま | UPSERT sessions sB7 {"id":"sB7","memberId":"mB"}$s$,
    $s$A | val=2 | 入っているグループは2つ | select count(*)::text from public.my_workspaces()$s$,

    -- ───── 外す・抜ける ─────
    $s$O | rows=1 | owner が本人Aを外す | select public.remove_member('{ws}', '{uA}')$s$,
    $s$A | val= | 外された本人は読めない | IDS$s$,
    $s$A | err=42501 | 外された本人は書けない | UPSERT sessions sA7 {"id":"sA7","memberId":"mA"}$s$,
    $s$A | val=A own/owner | 外された本人に残るのは、自分のグループだけ | select string_agg(name || '/' || role, ',') from public.my_workspaces()$s$,
    $s$O | val=6 | 外しても、その人の記録は残る | select count(*)::text from public.records where workspace_id = '{ws}' and member_id = 'mA'$s$,
    $s$B | rows=1 | 本人Bが、何も指定せずに抜ける（＝記録を残す） | select public.leave_workspace('{ws}')$s$,
    $s$B | val= | 抜けた本人は読めない | IDS$s$,
    $s$P | val=2 | 残して抜けると、その人の記録は消えない | select count(*)::text from public.records where workspace_id = '{ws}' and member_id = 'mB' and not deleted$s$,
    $s$O | val=2 | 残っている参加者は owner と指導者 | select count(*)::text from public.list_members('{ws}')$s$,
    $s$O | save=codeA2 | 外した人を、もう一度招く | select public.create_invite('{ws}', 'client', 'mA') ->> 'code'$s$,
    $s$A | val={ws} | 本人Aが入り直す | select (public.join_workspace('{codeA2}')).id::text$s$,
    $s$A | val=bodies/bA1,members/mA,sessions/sA1,sessions/sA2,sessions/sA6,sessions/sA9 | 入り直すと、自分の記録がまた読める | IDS$s$,
    $s$O | rows=1 | owner が人（B）を消す | TOMB members mB$s$,
    $s$P | val=mB/true | 消した人の行も、その人のものとして残る | select member_id || '/' || deleted from public.records where workspace_id = '{ws}' and collection = 'members' and id = 'mB'$s$,
    $s$O | msg=member not found | 消した人あての招待は作れない | select public.create_invite('{ws}', 'client', 'mB')$s$,
    $s$P | val=9 | 指導者が抜ける前の、消えていない記録の数（人3・profile 1・体組成2・セッション3） | select count(*)::text from public.records where workspace_id = '{ws}' and not deleted$s$,
    $s$C | rows=1 | 指導者が「消す」を選んで抜ける | select public.leave_workspace('{ws}', false)$s$,
    $s$P | val=9 | 指導者が「消す」を選んでも、記録は消えない | select count(*)::text from public.records where workspace_id = '{ws}' and not deleted$s$,
    $s$C | val= | 抜けた指導者は読めない | IDS$s$,
    $s$C | err=42501 | 抜けた指導者は書けない | UPSERT sessions sC1 {"id":"sC1","memberId":"mA"}$s$,

    -- ───── 1000件を超える受け取り ─────
    $s$P | rows=1005 | （記録を1005件入れる） | insert into public.records (workspace_id, collection, id, data) select '{ws}', 'conditions', 'g' || g, jsonb_build_object('id', 'g' || g, 'memberId', 'mO') from generate_series(1, 1005) g$s$,
    $s$O | val=1000/true | 1回に返るのは1000件まで。続きを頼むと、残りがちょうど返る | with p1 as (select * from public.pull_records('{ws}', null, '', '', 5000)), last as (select updated_at, collection, id from p1 order by updated_at desc, collection desc, id desc limit 1) select (select count(*) from p1) || '/' || ((select count(*) from public.pull_records('{ws}', (select updated_at from last), (select collection from last), (select id from last))) = (select count(*) from public.records where workspace_id = '{ws}') - 1000)$s$,
    $s$O | val=1 | 件数に0を頼んでも、1件は返る | select count(*)::text from public.pull_records('{ws}', null, '', '', 0)$s$,

    -- ───── ログインなし ─────
    $s$N | err=42501 | ログインなしで記録を読む | select count(*) from public.records$s$,
    $s$N | err=42501 | ログインなしでグループを読む | select count(*) from public.workspaces$s$,
    $s$N | err=42501 | ログインなしでグループを作る | select public.create_workspace('x')$s$,
    $s$N | err=42501 | ログインなしで参加する | select public.join_workspace('{codeA2}')$s$,
    $s$N | err=42501 | ログインなしで自分のグループを聞く | select count(*) from public.my_workspaces()$s$,
    $s$N | err=42501 | ログインなしで参加者の一覧を聞く | select count(*) from public.list_members('{ws}')$s$,
    $s$N | err=42501 | ログインなしで、結びつき済みの人を聞く | select count(*) from public.linked_member_ids('{ws}')$s$,
    $s$N | err=42501 | ログインなしで「消して抜ける」を呼ぶ | select public.leave_workspace('{ws}', false)$s$
  ];
  upsert_tail constant text := ' on conflict (workspace_id, collection, id) do update set workspace_id = excluded.workspace_id, collection = excluded.collection, id = excluded.id, data = excluded.data, deleted = excluded.deleted';
  show_all boolean := coalesce(nullif(current_setting('physlog.test_verbose', true), ''), 'off') = 'on';
  vars jsonb;
  st text; actor text; want text; label text; q text; k text; v text; got text;
  n bigint; ok boolean; m text[];
  res text := ''; pass integer := 0; fail integer := 0;
begin
  -- テスト用の利用者（最後の例外で巻き戻る）
  vars := jsonb_build_object('uO', gen_random_uuid(), 'uC', gen_random_uuid(), 'uA', gen_random_uuid(), 'uB', gen_random_uuid(), 'uD', gen_random_uuid(), 'uX', gen_random_uuid());
  for k in select jsonb_object_keys(vars) loop
    insert into auth.users (id, email) values ((vars ->> k)::uuid, 'physlog-roles-test-' || (vars ->> k) || '@example.invalid');
  end loop;

  foreach st in array steps loop
    actor := trim(split_part(st, '|', 1));
    want := trim(split_part(st, '|', 2));
    label := trim(split_part(st, '|', 3));
    q := trim(substr(st, length(split_part(st, '|', 1)) + length(split_part(st, '|', 2)) + length(split_part(st, '|', 3)) + 4));

    -- 省略形を SQL にする
    if q = 'IDS' then
      q := $q$select coalesce(string_agg(collection || '/' || id, ',' order by collection, id), '') from public.records where workspace_id = '{ws}'$q$;
    elsif q = 'COUNT' then
      q := $q$select count(*)::text from public.records where workspace_id = '{ws}'$q$;
    elsif q like 'UPSERT %' then
      m := regexp_match(q, '^UPSERT (\S+) (\S+) (.*)$');
      q := format('insert into public.records (workspace_id, collection, id, data, deleted) values (%L, %L, %L, %L::jsonb, false)', '{ws}', m[1], m[2], m[3]) || upsert_tail;
    elsif q like 'TOMB %' then
      m := regexp_match(q, '^TOMB (\S+) (\S+)$');
      q := format('insert into public.records (workspace_id, collection, id, data, deleted) values (%L, %L, %L, null, true)', '{ws}', m[1], m[2]) || upsert_tail;
    end if;
    for k in select jsonb_object_keys(vars) loop
      q := replace(q, '{' || k || '}', vars ->> k);
      want := replace(want, '{' || k || '}', vars ->> k);
    end loop;

    -- その人になりきる
    if actor = 'P' then
      perform set_config('request.jwt.claims', '', true);
    elsif actor = 'N' then
      perform set_config('request.jwt.claims', '{"role":"anon"}', true);
      execute 'set local role anon';
    else
      perform set_config('request.jwt.claims', jsonb_build_object('sub', vars ->> ('u' || actor), 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
    end if;

    v := null;
    begin
      if want like 'val=%' or want like 'save=%' then
        execute q into v;
        got := 'val=' || coalesce(v, 'NULL');
      else
        execute q;
        get diagnostics n = row_count;
        got := 'rows=' || n;
      end if;
    exception when others then
      got := 'err=' || sqlstate || ' ' || sqlerrm;
    end;

    execute 'reset role';
    perform set_config('request.jwt.claims', '', true);

    if want like 'save=%' then
      ok := got like 'val=%' and v is not null;
      if ok then vars := vars || jsonb_build_object(substr(want, 6), v); end if;
    elsif want like 'err=%' then
      ok := left(got, length(want)) = want;
    elsif want like 'msg=%' then
      ok := got like 'err=%' and position(substr(want, 5) in got) > 0;
    else
      ok := got = want;
    end if;

    if ok then pass := pass + 1; else fail := fail + 1; end if;
    if show_all or not ok then
      res := res || format(E'%s | %s | %s | got %s%s\n', case when ok then 'PASS' else 'FAIL' end, actor, label, left(got, 160),
                           case when ok then '' else ' | want ' || want end);
    end if;
  end loop;

  raise exception E'ROLLBACK_OK pass=% fail=%\n%', pass, fail, res;
end $test$;
