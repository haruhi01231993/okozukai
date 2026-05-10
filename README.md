# おこづかい (PWA版)

iPhoneの「ホーム画面に追加」で使えるWebアプリ版のおこづかい管理アプリです。Swift版と同じ機能を持ちつつ、ケーブル接続や7日制限がありません。

---

## このフォルダの中身

```
web-app/
├── index.html         画面本体
├── styles.css         スタイル
├── app.js             アプリのロジック（Sheets連携・週計算・サマリー等）
├── manifest.json      PWA定義
├── service-worker.js  オフライン対応
├── icon-192.png       アイコン
├── icon-512.png       アイコン
└── README.md          このファイル
```

---

## セットアップ全体像

1. **Google Cloud Consoleで「Webアプリケーション」用のOAuthクライアントID** を作成（既存のiOS用と並行で作れる）
2. `app.js` の `GOOGLE_CLIENT_ID` をその値に書き換え
3. **GitHub Pages** などの無料ホスティングにアップロード（HTTPSが必須なのでローカルファイルでは動きません）
4. iPhoneでURLを開いて **「ホーム画面に追加」**

---

## 1. Google Cloud で Web 用 OAuth クライアントを作成

既存のkakeiboPocketプロジェクトで、追加でWebアプリ用のクライアントIDを作ります。

### 1-1. Web用クライアントIDの作成

1. https://console.cloud.google.com/ を開く
2. プロジェクトが `kakeiboPocket`（既存のもの）になっていることを確認
3. 左メニュー → **「APIとサービス」** → **「認証情報」**
4. 上部 **「+ 認証情報を作成」** → **「OAuthクライアントID」**
5. 「アプリケーションの種類」: **「ウェブアプリケーション」** を選択
6. 名前: `Kakeibo Web`（任意）
7. **承認済みのJavaScript生成元**: 後でホスティングしたURLを追加（例: `https://yourname.github.io`）
   - 一旦空でもOK（後で追加できる）
   - ローカル開発用に `http://localhost:8000` を追加しておくと便利
8. **承認済みのリダイレクトURI**: 空でOK（このアプリでは使わない）
9. 「作成」 → 表示された**クライアントID**をコピー

### 1-2. クライアントIDをアプリに設定

`app.js` を開いて、以下の行を書き換え：

```javascript
const GOOGLE_CLIENT_ID = "REPLACE_WITH_YOUR_WEB_CLIENT_ID";
```

↓

```javascript
const GOOGLE_CLIENT_ID = "1234567890-xxxx.apps.googleusercontent.com";
```

---

## 2. ローカルでの動作確認

ファイルを直接開く（`file://`）と Service Worker や OAuth が動かないので、**簡易HTTPサーバー**で確認します。Macなら：

```bash
cd web-app
python3 -m http.server 8000
```

ブラウザで http://localhost:8000 を開く。

⚠️ ローカルの場合は Google Cloud の「承認済みのJavaScript生成元」に `http://localhost:8000` を追加してください。

---

## 3. GitHub Pagesでホスティング

無料でHTTPS対応URLをもらえる方法。手順は10分程度。

### 3-1. GitHubアカウントを作る

すでにあれば飛ばす。なければ https://github.com/ で無料登録。

### 3-2. リポジトリを作る

1. https://github.com/new
2. Repository name: `okozukai`（任意）
3. **Public** を選択（Private でもPagesは使えますが少し設定が違います）
4. 「Create repository」

### 3-3. ファイルをアップロード

GitHubの作ったリポジトリ画面で、「uploading an existing file」リンクをクリック。
このフォルダ（`web-app/`）の中身を**全部選択してドラッグ＆ドロップ**：

- index.html
- styles.css
- app.js
- manifest.json
- service-worker.js
- icon-192.png
- icon-512.png
- README.md（任意）

下部の「Commit changes」をクリック。

### 3-4. Pages を有効化

1. リポジトリページ上部の **「Settings」** タブ
2. 左メニュー **「Pages」**
3. **Branch** で `main` を選択 → フォルダは `/ (root)` のまま → **Save**
4. 数十秒〜数分後、上部に `Your site is live at https://yourname.github.io/okozukai/` のような表示が出る

### 3-5. Google Cloudに正規URLを追加

1. Google Cloud → 認証情報 → さっき作った「Kakeibo Web」を開く
2. **承認済みのJavaScript生成元** に GitHub Pages のURL（例: `https://yourname.github.io`）を追加
3. 保存

### 3-6. iPhoneで開いて「ホーム画面に追加」

1. iPhoneの**Safari**で、PagesのURLを開く（Chromeはホーム画面追加に未対応）
2. 下部の **共有ボタン**（四角に矢印）→ **「ホーム画面に追加」**
3. 名前を確認して「追加」
4. ホーム画面にアイコンが追加される。タップで起動！

奥さまのiPhoneにも同じURLを送って、同じ手順でホーム画面に追加すればOK。

---

## 4. 使い方

Swift版と同じです。

### 4-1. 初回設定

1. アプリを開く → ようこそ画面でおこづかいの目標金額を入力
2. 設定（左上の歯車）を開く：
   - スプレッドシートIDを入力（URLの `/d/` と `/edit` の間）
   - シート名（タブ名）を入力
   - **Googleでサインイン** をタップ → アカウント選択 → アクセス許可
   - **「シートからカテゴリを取り込む」** をタップ
   - セクション見出し（自己投資など）を ✕ ボタンで削除

### 4-2. 普段の使い方

- 右下の **「+」** で支出を追加（カテゴリは自動推定）
- 支出の行をタップで **編集** 可能
- 右上の **同期アイコン** でスプレッドシートに書き込み

### 4-3. 月切替

毎月1日にアプリを開くと、自動で前月のデータが履歴に移動して、サマリー画面が表示されます。

---

## 5. 注意事項

- **データはブラウザのlocalStorageに保存**されます。ブラウザのデータを消すと記録も消えるので、定期的にスプレッドシートに同期してください。
- **2台でデータは共有されません**。それぞれのスマホが独立した家計簿として動きます。
- **Google サインインは1時間で切れる**ことがあります。切れたら再度サインインボタンで再認証してください。
- **iOS Safariでしか「ホーム画面追加」が標準サポート**されていません。Chrome等は別の手順になります。

---

## トラブルシューティング

| 症状 | 対処 |
|------|------|
| サインインで「unauthorized client」エラー | Google CloudでJavaScript生成元の URL が正しく登録されているか確認 |
| 「Google Identity Services が読み込めていません」 | ネットワーク確認、ページをリロード |
| 同期で「シートが見つかりません」 | シート名（タブ名）が正確か確認 |
| 「ホーム画面に追加」がない | Safariで開いているか確認（Chromeにはない） |
