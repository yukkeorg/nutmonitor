# NUT UPS Monitor — GNOME Shell 拡張機能

NUT (Network UPS Tools) の `upsd` から UPS の状態を取得し、GNOME Shell のトップバーに表示します。
停電・低バッテリー・復電・通信断ではデスクトップ通知を出します。

```
[🔋 100%]                 ← トップバー
 ├ myups@localhost
 ├ Mock Power Corp. UPS 1500
 ├ 状態            オンライン
 ├ バッテリー残量   100%
 ├ 残り時間        1 時間 23 分
 ├ 負荷            23%
 ├ 入力電圧        101.2 V
 ├ 出力電圧        101.0 V
 ├ バッテリー電圧   27.3 V
 ├ 定格出力        900 W
 ├ ──────────────
 ├ 今すぐ更新
 └ 設定…
```

## 特徴

- `upsc` などの外部コマンドを使わず、NUT のネットワークプロトコル (TCP 3493) を GJS から直接、非同期で話します
- ローカルの `upsd` にもリモートの `upsd` にも接続できます。認証 (`USERNAME`/`PASSWORD`) は任意です
- 応答が遅いサーバーでも GNOME Shell を固めないよう、すべての I/O にタイムアウトとキャンセルを入れています
- 接続に失敗している間はポーリング間隔を指数的に伸ばし (最大 60 秒)、復帰したら元に戻します
- 日本語と英語に対応しています

## 動作環境

- GNOME Shell 50
- NUT 2.x の `upsd`（ローカルまたはリモート）

## インストール

```sh
make install
```

インストール先は `~/.local/share/gnome-shell/extensions/nutmonitor@yukke.org/` です。
GNOME 50 は Wayland のみで Shell の再起動ができないため、**一度ログアウトして入り直してください**。
その後、有効化します。

```sh
gnome-extensions enable nutmonitor@yukke.org   # make enable でも可
gnome-extensions prefs  nutmonitor@yukke.org   # make prefs  でも可
```

配布用の ZIP は `make pack` で `build/` に作られます。

## 設定

設定画面（`make prefs`）または `gsettings` で変更できます。

| キー | 既定値 | 内容 |
| --- | --- | --- |
| `host` | `localhost` | `upsd` が動いているホスト |
| `port` | `3493` | `upsd` のポート |
| `ups-name` | 空 | `ups.conf` の UPS 名。空ならサーバーが返す最初の UPS |
| `username` / `password` | 空 | `upsd.users` の認証情報（任意） |
| `poll-interval` | `5` | 取得間隔（秒） |
| `connection-timeout` | `5` | 応答待ちの上限（秒） |
| `panel-label` | `charge` | トップバーに出す値: `charge` / `runtime` / `load` / `status` / `none` |
| `panel-box` | `right` | トップバーのどの区画に置くか: `left` / `center` / `right` |
| `panel-position` | `0` | 区画内での並び順。0 が一番左で、区画の項目数を超える値は末尾になる |
| `show-menu-detail` | `true` | メニューに電圧・定格出力を出すか |
| `notify-*` | `true` | 通知の種類ごとの ON/OFF |

```sh
gsettings --schemadir ~/.local/share/gnome-shell/extensions/nutmonitor@yukke.org/schemas \
    set org.gnome.shell.extensions.nutmonitor host nas.local
```

> **パスワードについて**: 設定したパスワードは dconf に平文で保存されます。
> NUT では変数の読み取り（`LIST VAR`）に認証が不要な構成が一般的なので、
> 監視目的であればユーザー名とパスワードは空のままにしておくのが安全です。

## NUT サーバー側の準備

ローカルで動かす場合は `upsd` が起動していて、`upsd.conf` が `localhost` を待ち受けていれば十分です。

```sh
upsc -l localhost          # UPS 名の一覧
upsc myups@localhost       # 変数の一覧
systemctl status nut-server
```

別のマシン（NAS など）の `upsd` を見る場合は、サーバー側の `upsd.conf` で外部からの接続を待ち受け、
ファイアウォールで 3493/tcp を開けてください。

```
# /etc/nut/upsd.conf
LISTEN 0.0.0.0 3493
```

## 開発

```sh
make test      # プロトコル実装とフォーマッタの単体テスト（モックサーバを自動起動）
make mock      # モックの NUT サーバーを起動（OL → OB → OB LB → OL を巡回）
make nested    # 使い捨ての GNOME Shell をウィンドウで起動し、拡張機能を有効化する
make headless  # 同じものをウィンドウなしで起動
make pot       # 翻訳テンプレートの更新と .po のマージ
make pack      # 配布用 ZIP の作成
make logs      # gnome-shell のログを追う
```

`make nested` は `dbus-run-session -- gnome-shell --devkit --wayland` を使います。
`--nested` は GNOME 49 で削除されており、単なる `--wayland` はシートを奪おうとして
`Failed to take control of the session: EBUSY` で落ちます。
入れ子の Shell は自分専用の D-Bus セッションを持つため、外の端末から `gnome-extensions enable`
は届きません。`make nested` は起動後に中で有効化まで済ませます。

> `Failed to launch devkit: ... /usr/libexec/mutter-devkit` という警告が出ますが、
> 入れ子の Shell 自体は動きます。開発用ツールバーも使いたい場合は
> `sudo apt install mutter-dev-bin` を入れてください。

### モックサーバーで通知を確かめる

`upsd` や実機の UPS がなくても、`tools/mock-nutd.mjs` で一通り確認できます。

```sh
make mock &     # モックサーバー（ポート 13493）
gsettings --schemadir ~/.local/share/gnome-shell/extensions/nutmonitor@yukke.org/schemas \
    set org.gnome.shell.extensions.nutmonitor host localhost
gsettings --schemadir ~/.local/share/gnome-shell/extensions/nutmonitor@yukke.org/schemas \
    set org.gnome.shell.extensions.nutmonitor port 13493
make nested     # make install してから入れ子の Shell が立ち上がり、有効化まで済む
```

設定は dconf 経由でホストのセッションと共有されるので、確認が済んだら元の接続先に戻してください。

状態は 4 回読まれるごとに `OL → OB → OB LB → OL` と進みます。任意のタイミングで進めたい場合は次のようにします。

```sh
kill -USR1 $(pgrep -f mock-nutd)
```

モックには次の特殊な UPS 名があります。

| 名前 | 動作 |
| --- | --- |
| `mockups` | 通常のデバイス |
| `secretups` | 認証前は `ERR ACCESS-DENIED` を返す |
| `slowups` | 応答しない（タイムアウトの確認用） |

## 構成

| ファイル | 役割 |
| --- | --- |
| `src/extension.js` | トップバーのインジケーターとポーリング |
| `src/prefs.js` | 設定画面（GTK4 / libadwaita）と接続テスト |
| `src/lib/nutClient.js` | NUT プロトコルの非同期クライアント |
| `src/lib/upsState.js` | `ups.status` の解釈、アイコン選択、値の整形 |
| `src/lib/notifier.js` | 状態遷移から通知を出す（唯一の Shell 依存モジュール） |
| `tools/mock-nutd.mjs` | テスト用のモック `upsd`（Node.js） |
| `tools/test-nutclient.js` | `gjs` で走る単体テスト |

`src/lib/nutClient.js` と `src/lib/upsState.js` は GNOME Shell に依存しないため、Shell・設定画面・テストの
3 か所から同じコードを使っています。

## 現時点でやっていないこと

- 複数 UPS の同時監視（設定で 1 台を選ぶ方式）
- `INSTCMD` による UPS への命令送信（ビープ停止、テスト開始など）
- STARTTLS による暗号化
- libsecret へのパスワード保管

## 参考

- [NUT: Network protocol information](https://networkupstools.org/docs/developer-guide.chunked/net-protocol.html)
- [NUT: Variables](https://networkupstools.org/docs/developer-guide.chunked/_variables.html)
- [NUT: Configuration notes（`ups.status` のフラグ）](https://networkupstools.org/docs/user-manual.chunked/Configuration_notes.html)
- [GNOME: Anatomy of an Extension](https://gjs.guide/extensions/overview/anatomy.html)
- [GNOME: Port Extensions to GNOME Shell 50](https://gjs.guide/extensions/upgrading/gnome-shell-50.html)
