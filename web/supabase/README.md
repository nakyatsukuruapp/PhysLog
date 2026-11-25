# データベース（Supabase の physlog プロジェクト）

## migrations/

上から順に適用する SQL。

| ファイル | 内容 | 本番への適用 |
|---|---|---|
| `20261122124941_physlog_sync_init.sql` | グループ・参加者・記録の表と、同期の基本 | 済み |
| `20261122124959_move_is_member_private.sql` | 判定用の関数を private へ | 済み |
| `20261122125144_records_realtime.sql` | 記録の変更をすぐ届ける設定 | 済み |
| `20261124150000_roles_and_invites.sql` | 役割（owner・coach・client）、1回きり・期限つきの招待、抜けるとき・外すときの記録の扱い、取りこぼさない受け取り | **まだ**（2026-11-25 時点） |

- 適用済みの3つは、Supabase に記録されている SQL と同じ内容。
- `roles_and_invites` を適用したら、ファイル名の番号を、Supabase に記録された版番号に合わせる。
- 適用すると、旧・共通の招待コード（`workspaces.invite_code`）は使えなくなる。アプリも `src/lib/sync.ts` の新しい版が要る。

## tests/

- `roles_test.sql` … 役割ごとの権限のテスト（owner・coach 2人・client 3人・部外者・ログインなし）。
  テスト用の利用者と記録を1つの処理の中で作り、最後にわざと例外を出してすべて巻き戻す。結果は例外の本文に入る。
- `local_stub.sql` … 手元の素の Postgres を Supabase に似せる（ロールと `auth.uid()`）。テスト専用。
- `run_local.sh` … 手元の Postgres に、マイグレーションを最初から流してテストする。

```
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres ./supabase/tests/run_local.sh
```

アプリの同期のコードを通しで確かめるテストは `../tests/sync-roles.test.mjs`。
