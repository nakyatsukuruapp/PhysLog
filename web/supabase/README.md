# データベース（Supabase の physlog プロジェクト）

## migrations/

上から順に適用する SQL。

| ファイル | 内容 | 本番への適用 |
|---|---|---|
| `20261122124941_physlog_sync_init.sql` | グループ・参加者・記録の表と、同期の基本 | 済み |
| `20261122124959_move_is_member_private.sql` | 判定用の関数を private へ | 済み |
| `20261122125144_records_realtime.sql` | 記録の変更をすぐ届ける設定 | 済み |
| `20261126023258_roles_and_invites.sql` | 役割（owner・coach・client）、1回きり・期限つきの招待、離れるときの記録の扱い（本人は実績として渡すかを選ぶ・外された本人の記録の預かり・指導者の端末の片づけ）、取りこぼさない受け取り | 済み（2026-11-26。本番の定義・権限は手元でテスト済みのものと一致を確認） |
| `20261126025720_delete_account.sql` | アカウントの削除（その人は「unknown user」と表示し、記録は残す。管理者はいちばん古い指導者へ引き継ぎ） | 済み（2026-11-26。本番の関数は手元でテスト済みのものと一致を確認） |

- 適用済みの3つは、Supabase に記録されている SQL と同じ内容。
- `roles_and_invites` を適用したら、ファイル名の番号を、Supabase に記録された版番号に合わせる。
- 適用すると、旧・共通の招待コード（`workspaces.invite_code`）は使えなくなる。アプリも `src/lib/sync.ts` の新しい版が要る。

## tests/

- `roles_test.sql` … 役割ごとの権限と、離れるときの決まりのテスト（owner・coach 2人・client 3人・部外者・ログインなし。358項目）。
  テスト用の利用者と記録を1つの処理の中で作り、最後にわざと例外を出してすべて巻き戻す。結果は例外の本文に入る。
- `local_stub.sql` … 手元の素の Postgres を Supabase に似せる（ロールと `auth.uid()`）。テスト専用。
- `run_local.sh` … 手元の Postgres に、マイグレーションを最初から流してテストする。

```
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres ./supabase/tests/run_local.sh
```

アプリの同期のコードを通しで確かめるテストは `../tests/sync-roles.test.mjs`。
