// =====================================================
// Config — Google Cloud で Web 用 OAuth クライアントを作って
// クライアントID（xxx.apps.googleusercontent.com）をここに貼る。
// =====================================================
const GOOGLE_CLIENT_ID = "872334684520-3vqjsij9age39qv8k8jdsklp9pimikf0.apps.googleusercontent.com";
const GOOGLE_SCOPES = "https://www.googleapis.com/auth/spreadsheets";

// =====================================================
// Store / 永続化
// =====================================================
const STORAGE_KEY = "kakeibo.v1";

const defaultState = {
  expenses: [],            // [{id, name, amount, category, date(YYYY-MM-DD)}]
  history: {},             // {"2026-04": [Expense, ...]}（旧構造、マイグレーション用）
  monthSummaries: {},      // {"2026-04": MonthSummary}
  categoryRows: [],        // [{name, row}]
  monthlyBudget: 0,        // 新規月のデフォルト値（設定変更で更新）
  monthlyBudgets: {},      // {"2026-05": 108556, "2026-06": 120000} 月ごとの目標額
  monthlyGoals: {},        // {"2026-06": "貯金優先！"} 月ごとの目標文言
  spreadsheetId: "",
  sheetName: "",
  rolloverEnabled: true,
  lastSeenMonth: "",
  messageSeed: 0,          // モチベメッセージのローテーション用
  piggyBank: 0,            // 貯金箱の残高（非表示）
  depositedMonths: [],     // 既に貯金箱に積算済みの月キー
  monthlyBoosts: {},       // {"2026-06": 25000} 貯金箱を解放してブーストした額
};

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...defaultState };
    const parsed = JSON.parse(raw);
    return migrateState({ ...defaultState, ...parsed });
  } catch (e) {
    return { ...defaultState };
  }
}

// マイグレーション:
//   (1) history → expenses への統合
//   (2) monthlyBudget → monthlyBudgets への展開（過去月に現在の目標額を固定）
function migrateState(s) {
  // (1) history をマージ
  if (s.history && Object.keys(s.history).length > 0) {
    const idSet = new Set((s.expenses || []).map(e => e.id));
    const merged = [...(s.expenses || [])];
    for (const [k, exps] of Object.entries(s.history)) {
      if (!Array.isArray(exps)) continue;
      for (const e of exps) {
        if (e && e.id && !idSet.has(e.id)) {
          idSet.add(e.id);
          merged.push(e);
        }
      }
    }
    s.expenses = merged;
  }
  // (2) monthlyBudgets が未設定なら、既存の全月と当月を現在の monthlyBudget で埋める
  if (!s.monthlyBudgets) s.monthlyBudgets = {};
  if (s.monthlyBudget > 0) {
    const monthsWithData = new Set();
    (s.expenses || []).forEach(e => {
      const k = (e.date || "").slice(0, 7);
      if (k) monthsWithData.add(k);
    });
    monthsWithData.add(monthKey());
    for (const k of monthsWithData) {
      if (!(k in s.monthlyBudgets)) {
        s.monthlyBudgets[k] = s.monthlyBudget;
      }
    }
  }
  return s;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// =====================================================
// 月キーとフォーマッター
// =====================================================
function pad2(n) { return n < 10 ? "0" + n : "" + n; }

function monthKey(d = new Date()) {
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1);
}

function sheetMonthHeader(d = new Date()) {
  return d.getFullYear() + "/" + pad2(d.getMonth() + 1);
}

function todayISO() {
  const d = new Date();
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function formatYen(n) {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return sign + "¥" + abs.toLocaleString("en-US");
}

function formatNumber(n) {
  return Math.abs(n).toLocaleString("en-US");
}

function formatShortDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${m}/${d}`;
}

function formatDateForList(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${m}月${d}日`;
}

function formatMonthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return `${y}年${m}月`;
}

// =====================================================
// 月リセット & expenses フィルタヘルパー
// =====================================================
function monthKeyOf(expense) {
  return (expense.date || "").slice(0, 7);
}

function expensesForMonth(key) {
  return state.expenses.filter(e => monthKeyOf(e) === key);
}

function currentMonthExpenses() {
  return expensesForMonth(monthKey());
}

function pastMonthsWithData() {
  const cur = monthKey();
  const keys = new Set();
  state.expenses.forEach(e => {
    const k = monthKeyOf(e);
    if (k && k !== cur && k <= cur) keys.add(k);
  });
  return [...keys].sort().reverse();
}

function checkMonthReset() {
  const cur = monthKey();
  const last = state.lastSeenMonth || cur;
  if (last !== cur) {
    // 前月の記録があればサマリーを表示候補に
    const pastExpenses = expensesForMonth(last);
    if (pastExpenses.length > 0) {
      pendingSummaryKey = last;
    }
    state.lastSeenMonth = cur;
    saveState();
  } else if (!state.lastSeenMonth) {
    state.lastSeenMonth = cur;
    saveState();
  }
}

let pendingSummaryKey = null;

// =====================================================
// 計算: 今月の合計、残額、節約状況
// =====================================================
/// 指定月の基本目標額（設定なしの場合は現在のデフォルトにフォールバック）
function budgetForMonth(key) {
  if (state.monthlyBudgets && state.monthlyBudgets[key] != null) {
    return state.monthlyBudgets[key];
  }
  return state.monthlyBudget || 0;
}

/// 過去月にも目標額の記録がなければ、現在のデフォルトを固定しておく
function ensureMonthBudget(key) {
  if (!state.monthlyBudgets) state.monthlyBudgets = {};
  if (!(key in state.monthlyBudgets) && state.monthlyBudget > 0) {
    state.monthlyBudgets[key] = state.monthlyBudget;
  }
}

/// 指定月の目標文言（自由記入）
function goalForMonth(key) {
  return (state.monthlyGoals && state.monthlyGoals[key]) || "";
}

function effectiveBudget(forKey = null) {
  const key = forKey || monthKey();
  return budgetForMonth(key) + (state.monthlyBoosts[key] || 0);
}

function totalSpent() {
  return currentMonthExpenses().reduce((a, e) => a + e.amount, 0);
}
function remaining() {
  return effectiveBudget() - totalSpent();
}
function isConfigured() {
  return state.monthlyBudget > 0 || Object.keys(state.monthlyBudgets || {}).length > 0;
}
function canSync() {
  return state.spreadsheetId && state.sheetName && state.categoryRows.length > 0;
}

/// 「予定ペースよりいくら節約／オーバーか」 正なら節約中
function monthSavings() {
  const bud = effectiveBudget();
  if (bud <= 0) return 0;
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const today = now.getDate();
  const expectedByToday = Math.floor(bud * today / daysInMonth);
  return expectedByToday - totalSpent();
}

/// 週ごとの内訳（1日〜7日が1週目、8〜14が2週目…）
function weekBreakdowns() {
  const bud = effectiveBudget();
  if (bud <= 0) return [];
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-based
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const weekCount = Math.ceil(daysInMonth / 7);
  if (weekCount <= 0) return [];

  const baseWeekBudget = Math.floor(bud / weekCount);
  const today = now.getDate();
  const result = [];
  let perWeekAdjustment = 0;
  const monthExpenses = currentMonthExpenses();

  for (let i = 0; i < weekCount; i++) {
    const startDay = i * 7 + 1;
    const endDay = Math.min((i + 1) * 7, daysInMonth);

    // この週の支出
    const spent = monthExpenses
      .filter(e => {
        const ed = parseInt(e.date.split("-")[2], 10);
        return ed >= startDay && ed <= endDay;
      })
      .reduce((a, e) => a + e.amount, 0);

    const weekBudget = baseWeekBudget + (state.rolloverEnabled ? perWeekAdjustment : 0);

    let stateLabel;
    if (today > endDay) stateLabel = "completed";
    else if (today >= startDay) stateLabel = "current";
    else stateLabel = "future";

    let rating = null;
    if (stateLabel === "completed") {
      rating = computeRating(spent, weekBudget);
    }

    result.push({
      weekIndex: i + 1,
      startDay, endDay,
      year, month: month + 1,
      budget: weekBudget,
      spent,
      remaining: weekBudget - spent,
      state: stateLabel,
      rating,
    });

    if (state.rolloverEnabled && stateLabel === "completed") {
      const leftover = weekBudget - spent;
      const weeksRemaining = weekCount - (i + 1);
      if (weeksRemaining > 0) {
        perWeekAdjustment += Math.floor(leftover / weeksRemaining);
      }
    }
  }
  return result;
}

function computeRating(spent, budget) {
  if (budget <= 0) return spent > 0 ? "over" : "good";
  const r = spent / budget;
  if (r < 0.5) return "excellent";
  if (r < 0.9) return "good";
  if (r <= 1.0) return "warning";
  return "over";
}

// =====================================================
// モチベーションメッセージ
// =====================================================
function savingsHint(saved) {
  if (saved >= 30000) return "ちょっとした旅行";
  if (saved >= 15000) return "ちょっと贅沢な食事";
  if (saved >= 8000) return "美味しいランチ複数回分";
  if (saved >= 4000) return "映画1回と軽食";
  if (saved >= 2000) return "コーヒー数杯〜ランチ1回";
  if (saved >= 1000) return "コンビニデザート3個";
  if (saved >= 500) return "コーヒー1杯";
  return "もう一息！";
}

const MESSAGES = {
  savings: [
    (sav) => `🌱 良いペース！この調子で続けよう`,
    (sav) => `✨ ${formatYen(sav)}の節約で${savingsHint(sav)}が買えるかも`,
    (sav) => `🎉 このペースなら年間 ${formatYen(sav * 12)} 貯まる計算！`,
    (sav) => `💪 順調にキープ中。素晴らしい！`,
    (sav) => `🌸 計画的でえらい！その調子`,
    (sav) => `☕️ 浮いた分でちょっとご褒美？`,
    (sav) => `🍀 今月の節約が来月の余裕に`,
  ],
  over: [
    (over) => `💡 残りの週でちょっと抑えてみよう`,
    (over) => `🍵 来週はゆっくり過ごすのもあり`,
    (over) => `📊 後半戦、ここから挽回！`,
    (over) => `🌷 次月の節約で取り返せる`,
    (over) => `🎯 少しペースが早めかも`,
    (over) => `🔄 気にせずマイペースに`,
  ],
  ontrack: [
    `📈 計画通りのペース`,
    `👌 ちょうどいいバランス`,
    `🌼 マイペースに進んでます`,
    `⚖️ ぴったり予算内`,
  ],
};

function pickMessage() {
  const sav = monthSavings();
  const seed = state.messageSeed || 0;
  let pool;
  if (sav > 200) pool = MESSAGES.savings;
  else if (sav < -200) pool = MESSAGES.over;
  else pool = MESSAGES.ontrack;
  const item = pool[seed % pool.length];
  if (typeof item === "function") return item(sav);
  return item;
}

function rotateMessage() {
  state.messageSeed = (state.messageSeed || 0) + 1;
  saveState();
}

// =====================================================
// 貯金箱システム
// =====================================================
/// 過去月で未積算のものを貯金箱へ自動入金。
/// 既に depositedMonths にあるものはスキップ（=金額固定、二重入金防止）。
/// 節約額は **ブースト込みの実効予算** で計算するので、
/// 開放したブーストを使い切らなかった分も貯金箱へ戻る。
function depositPastSavings() {
  const pastKeys = pastMonthsWithData();
  let changed = false;
  let depositedThisRun = 0;
  for (const key of pastKeys) {
    if (state.depositedMonths.includes(key)) continue;
    ensureMonthBudget(key);
    const monthExp = expensesForMonth(key);
    const spent = monthExp.reduce((a, e) => a + e.amount, 0);
    // 実効予算（その月の目標額 + ブースト）に対する節約分を積算
    const monthBud = budgetForMonth(key) + (state.monthlyBoosts[key] || 0);
    const saved = monthBud - spent;
    if (saved > 0) {
      state.piggyBank += saved;
      depositedThisRun += saved;
    }
    state.depositedMonths.push(key);
    changed = true;
  }
  if (changed) {
    saveState();
    if (depositedThisRun > 0) {
      // 金額は明示しない
      setTimeout(() => showToast("前月の節約が貯金箱に追加されました🐷"), 600);
    }
  }
}

/// 貯金箱を開けて当月の予算にブースト
function releasePiggyBank() {
  if (state.piggyBank <= 0) {
    showToast("貯金箱はまだ空っぽです。節約して育てよう🌱");
    return;
  }
  if (!confirm("貯金箱を開けますか？\n今月のおこづかいに上乗せされます。")) return;
  const cur = monthKey();
  const releasedAmount = state.piggyBank;
  state.monthlyBoosts[cur] = (state.monthlyBoosts[cur] || 0) + releasedAmount;
  state.piggyBank = 0;
  saveState();
  renderAll();
  // 解放時に「貯めていた金額」を明かす
  setTimeout(() => {
    alert(`🎉 貯金箱から ${formatYen(releasedAmount)} 解放！\n今月のおこづかいに追加されました。`);
  }, 100);
}

function ratingLabel(r) {
  return ({excellent: "★★★", good: "★★", warning: "★", over: "超過"})[r];
}

// =====================================================
// カテゴリ自動分類
// =====================================================
// カテゴリ自動推定用のキーワード辞書。
// 順序も重要（同スコアの場合、先に定義したものが優先される）。
const KEYWORDS = {
  // ── 自己投資 ──
  "ネイル": ["ネイル", "nail", "マニキュア", "ジェル", "ネイルオフ", "ネイルサロン", "オフ代", "スカルプ"],
  "まつぱ/眉毛": [
    "まつぱ", "まつパ", "まつ毛", "マツエク", "まつげ", "アイラッシュ", "パリジェンヌ", "ラッシュリフト", "ラッシュ",
    "眉", "アイブロウ", "まゆ", "眉毛サロン", "ワックス脱毛"
  ],
  "美容院": ["美容院", "美容室", "カット", "カラー", "パーマ", "縮毛", "ヘア", "トリートメント", "サロン", "ブリーチ", "髪染め", "染髪"],
  "コスメ": ["コスメ", "化粧品", "ファンデ", "リップ", "口紅", "アイシャドウ", "メイク", "下地", "マスカラ", "チーク", "スキンケア", "化粧水", "乳液", "美容液", "日焼け止め", "パック", "セラム", "デパコス", "アイライナー", "コンシーラー", "ハイライト", "香水", "パフューム", "洗顔", "クレンジング", "アイクリーム", "ボディクリーム", "ハンドクリーム"],
  "歯医者": ["歯医者", "歯科", "デンタル", "dental", "インプラント", "歯石", "矯正", "虫歯", "ホワイトニング", "抜歯", "詰め物", "被せ物", "根管治療", "歯"],

  // ── 趣味 ──
  "ファッション": ["ファッション", "服", "洋服", "シャツ", "パンツ", "ワンピ", "ワンピース", "コート", "スカート", "ジャケット", "Tシャツ", "ニット", "デニム", "セーター", "ブラウス", "カーディガン", "パーカー", "スウェット", "ジーンズ", "ドレス", "GU", "ユニクロ", "ZARA", "H&M", "靴", "スニーカー", "ヒール", "パンプス", "サンダル", "ブーツ", "バッグ", "カバン", "リュック", "ポーチ", "帽子", "アクセ", "アクセサリー", "ピアス", "イヤリング", "ネックレス", "指輪", "ブレスレット", "下着", "ブラ", "ショーツ", "タイツ", "ストッキング", "ソックス", "靴下", "パジャマ", "ルームウェア", "水着"],
  "本": ["本", "書籍", "雑誌", "漫画", "マンガ", "コミック", "kindle", "ブック", "単行本", "新書", "文庫", "小説", "参考書", "写真集", "ムック"],
  "趣味グッズ": ["趣味グッズ", "グッズ", "推し", "ライブ", "コンサート", "チェキ", "アクスタ", "缶バッジ", "舞台", "推し活", "応援", "ペンライト", "ペンラ", "オタ活", "遠征", "フィルム", "特典", "生写真", "アクリル", "うちわ", "CD", "DVD", "Blu-ray", "ブルーレイ", "円盤", "ミュージカル", "公演", "ぬいぐるみ", "フィギュア", "コレクション", "プラモ", "趣味"],
  "ガチャ": ["ガチャ", "カプセル", "ガチャポン", "カプセルトイ", "ガシャポン"],
  "100均": ["100均", "100円", "百均", "ダイソー", "セリア", "キャンドゥ", "ワッツ"],
  "サンリオ": ["サンリオ", "キティ", "シナモロール", "シナモン", "クロミ", "マイメロ", "ポムポムプリン", "ポチャッコ", "ハンギョドン", "ぐでたま", "けろっぴ", "ポチャコ"],
  "WICKED": ["WICKED", "wicked", "ウィキッド", "ウィックド", "エルファバ", "グリンダ", "オズ"],

  // ── 体験・交友 ──
  "展示/イベント": ["展示", "展覧会", "展覧", "展示会", "イベント", "フェス", "美術館", "博物館", "ギャラリー", "ミュージアム", "個展", "アート"],
  "プレゼント": ["プレゼント", "ギフト", "誕生日", "お祝い", "祝い", "お礼", "手土産", "クリスマス", "母の日", "父の日", "バレンタイン"],
  "旅行": ["旅行", "ホテル", "宿", "飛行機", "航空券", "観光", "レンタカー", "旅館", "民宿", "民泊", "airbnb", "エアビ", "温泉", "パスポート", "土産", "おみやげ", "新幹線", "特急", "グリーン", "指定席"],

  // ── その他系（食事関連） ──
  // カフェを 出社日食事 より先に定義：スタバ等の3文字同スコアマッチで カフェを優先
  "カフェ": ["カフェ", "コーヒー", "スタバ", "スターバックス", "ドトール", "タリーズ", "プロント", "ブルーボトル", "コメダ", "上島珈琲", "cafe", "エクセルシオール", "サンマルク"],
  "出社日食事": ["出社日食事", "会社ランチ", "社食", "オフィスランチ", "会社の昼", "会社の昼食", "職場ランチ", "会社の食堂", "ランチ", "お昼", "出社", "オフィス", "お弁当", "弁当"],
  "外食": ["食事", "外食", "ディナー", "レストラン", "ご飯", "ごはん", "焼肉", "寿司", "デリバリー", "Uber", "出前", "スイーツ", "ケーキ", "デザート", "アイス", "カレー", "ラーメン", "パスタ", "うどん", "そば", "サイゼ", "マック", "マクドナルド", "モス", "ケンタ", "定食", "居酒屋", "バー", "呑み", "飲み会", "パフェ", "どんぶり", "カツ", "天ぷら", "餃子", "ピザ", "焼鳥", "焼き鳥", "ビール", "ワイン", "酒", "サンドイッチ", "サンド", "バーガー", "唐揚げ", "からあげ", "牛丼", "松屋", "すき家", "吉野家", "はなまる", "びっくりドンキー", "スシロー", "くら寿司", "はま寿司", "回転寿司", "コンビニ", "セブン", "ローソン", "ファミマ", "ミニストップ"],
  "その他": []
};

/// カテゴリ推定: 最も長くマッチしたキーワードを優先
function suggestCategory(text, categories) {
  if (!categories.length) return "その他";
  const lower = text.toLowerCase().trim();
  if (!lower) return categories[0];

  let bestCategory = null;
  let bestScore = 0;
  for (const c of categories) {
    const kws = KEYWORDS[c];
    if (!kws) continue;
    for (const kw of kws) {
      const kwLower = kw.toLowerCase();
      if (lower.includes(kwLower)) {
        // より長いキーワードのマッチを優先
        const score = kwLower.length;
        if (score > bestScore) {
          bestScore = score;
          bestCategory = c;
        }
      }
    }
  }
  if (bestCategory) return bestCategory;
  // フォールバック: その他系を優先
  const other = categories.find(c => c === "その他" || c.includes("その他"));
  return other || categories[0];
}

// =====================================================
// 月末サマリー
// =====================================================
function buildMonthSummary(key, expenses, budget) {
  const total = expenses.reduce((a, e) => a + e.amount, 0);
  const byCat = {};
  expenses.forEach(e => {
    byCat[e.category] = (byCat[e.category] || 0) + e.amount;
  });
  const categoryTotals = Object.entries(byCat)
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount);

  // 週集計
  const [y, m] = key.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const weekCount = Math.max(Math.ceil(daysInMonth / 7), 1);
  const perWeekBudget = Math.floor(budget / weekCount);

  const weekSpents = [];
  const weekBudgets = [];
  for (let i = 0; i < weekCount; i++) {
    const startDay = i * 7 + 1;
    const endDay = Math.min((i + 1) * 7, daysInMonth);
    const spent = expenses
      .filter(e => {
        const [ey, em, ed] = e.date.split("-").map(Number);
        return ey === y && em === m && ed >= startDay && ed <= endDay;
      })
      .reduce((a, e) => a + e.amount, 0);
    weekSpents.push(spent);
    weekBudgets.push(perWeekBudget);
  }

  return {
    monthKey: key,
    monthlyBudget: budget,
    totalSpent: total,
    weekSpents,
    weekBudgets,
    categoryTotals,
  };
}

function getSummary(key) {
  // 常に最新の expenses から再計算（編集を反映するため）
  // 予算は「その月固有の目標額」を使用（設定変更で過去月が変わらないように）
  const monthExpenses = expensesForMonth(key);
  if (monthExpenses.length === 0) return null;
  return buildMonthSummary(key, monthExpenses, budgetForMonth(key));
}

// その月の支出を日付の新しい順に
function expensesForMonthSorted(key) {
  return [...expensesForMonth(key)].sort((a, b) => b.date.localeCompare(a.date));
}

// =====================================================
// Google Sign-In / Sheets API
// =====================================================
let tokenClient = null;
let accessToken = null;
let userEmail = "";

function isSignedIn() { return !!accessToken; }

function initGoogle() {
  if (!window.google || !window.google.accounts) return false;
  if (tokenClient) return true;
  try {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: GOOGLE_SCOPES,
      callback: (resp) => {
        if (resp.access_token) {
          accessToken = resp.access_token;
          // 期限約3600秒。簡易のため再ログインで対応。
          fetchUserEmail();
          renderAuthStatus();
          if (signInResolver) {
            signInResolver();
            signInResolver = null;
          }
        } else if (signInRejecter) {
          signInRejecter(new Error("認証に失敗しました"));
          signInRejecter = null;
        }
      },
    });
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

let signInResolver = null;
let signInRejecter = null;

function signIn() {
  return new Promise((resolve, reject) => {
    if (!initGoogle()) {
      reject(new Error("Google Identity Services が読み込めていません"));
      return;
    }
    if (GOOGLE_CLIENT_ID.startsWith("REPLACE_")) {
      reject(new Error("Google Client ID が未設定です。app.js の GOOGLE_CLIENT_ID を設定してください"));
      return;
    }
    signInResolver = resolve;
    signInRejecter = reject;
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

function signOut() {
  if (accessToken) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  userEmail = "";
  renderAuthStatus();
}

async function fetchUserEmail() {
  try {
    const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (r.ok) {
      const j = await r.json();
      userEmail = j.email || "";
      renderAuthStatus();
    }
  } catch (e) { /* ignore */ }
}

function ensureSignedIn() {
  if (isSignedIn()) return Promise.resolve();
  return signIn();
}

function quotedSheetName(name) {
  return "'" + name.replace(/'/g, "''") + "'";
}

function columnLetter(index) {
  let n = index;
  let result = "";
  while (true) {
    const r = n % 26;
    result = String.fromCharCode(65 + r) + result;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return result;
}

async function sheetsFetch(url, options = {}) {
  await ensureSignedIn();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  const resp = await fetch(url, { ...options, headers });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const text = await resp.text();
      msg = text || msg;
    } catch (e) {}
    throw new Error(`APIエラー: ${msg}`);
  }
  return resp.json();
}

async function readValues(spreadsheetId, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
  const j = await sheetsFetch(url, { method: "GET" });
  return j.values || [];
}

async function getSheetId(spreadsheetId, sheetName) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`;
  const j = await sheetsFetch(url, { method: "GET" });
  for (const s of (j.sheets || [])) {
    if (s.properties && s.properties.title === sheetName) {
      return s.properties.sheetId;
    }
  }
  throw new Error(`シート「${sheetName}」が見つかりませんでした`);
}

async function findMonthColumnIndex(spreadsheetId, sheetName, header) {
  const range = `${quotedSheetName(sheetName)}!1:1`;
  const values = await readValues(spreadsheetId, range);
  const row = values[0] || [];
  for (let i = 0; i < row.length; i++) {
    if (String(row[i]).trim() === header) return i;
  }
  return -1;
}

async function fetchCategoryRowsFromSheet(spreadsheetId, sheetName) {
  const range = `${quotedSheetName(sheetName)}!A2:A100`;
  const values = await readValues(spreadsheetId, range);
  const result = [];
  for (let i = 0; i < values.length; i++) {
    const raw = (values[i][0] || "").trim();
    if (raw.includes("合計")) break;
    if (!raw) continue;
    // 絵文字除去（ざっくり: 拡張ピクトグラフィック）
    const clean = raw
      .replace(/\p{Extended_Pictographic}/gu, "")
      .replace(/[️‍]/g, "")
      .trim();
    if (!clean) continue;
    result.push({ name: clean, row: i + 2 });
  }
  return result;
}

async function writeValuesWithNotes(spreadsheetId, sheetId, updates) {
  if (!updates.length) return;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`;
  const requests = updates.map(u => {
    const cellValue = { userEnteredValue: { numberValue: u.value } };
    let fields = "userEnteredValue";
    if (u.note != null) {
      cellValue.note = u.note;
      fields = "userEnteredValue,note";
    }
    return {
      updateCells: {
        range: {
          sheetId,
          startRowIndex: u.rowIndex,
          endRowIndex: u.rowIndex + 1,
          startColumnIndex: u.columnIndex,
          endColumnIndex: u.columnIndex + 1,
        },
        rows: [{ values: [cellValue] }],
        fields,
      },
    };
  });
  await sheetsFetch(url, {
    method: "POST",
    body: JSON.stringify({ requests }),
  });
}

// =====================================================
// UI: 各画面のレンダリング
// =====================================================
const $ = (id) => document.getElementById(id);

function showScreen(id) {
  ["screen-onboarding", "screen-main"].forEach(s => $(s).classList.toggle("hidden", s !== id));
}

function showModal(id) { $(id).classList.remove("hidden"); }
function hideModal(id) { $(id).classList.add("hidden"); }

function showToast(msg, ms = 2500) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), ms);
}

function renderBalance() {
  const r = remaining();
  const t = totalSpent();
  const curBud = effectiveBudget();
  $("balance-amount").textContent = formatYen(r);
  $("balance-amount").classList.toggle("negative", r < 0);
  $("balance-spent").textContent = "使った: " + formatYen(t);
  $("balance-budget").textContent = "目標: " + formatYen(curBud);

  // 今月の目標文言
  const goalEl = $("balance-goal");
  if (goalEl) {
    const goal = goalForMonth(monthKey());
    if (goal) {
      goalEl.textContent = "🎯 " + goal;
      goalEl.classList.remove("hidden");
    } else {
      goalEl.classList.add("hidden");
    }
  }

  const pct = curBud > 0 ? Math.min(Math.max(t / curBud * 100, 0), 100) : 0;
  $("progress-fill").style.width = pct + "%";
  $("progress-fill").classList.toggle("over", r < 0);

  const sav = monthSavings();
  const badge = $("savings-badge");
  if (sav > 0) {
    badge.classList.remove("hidden", "negative");
    badge.classList.add("positive");
    badge.innerHTML = `🌱 +${formatYen(sav)} 節約中`;
  } else {
    // マイナス（ペースオーバー）は表示しない
    badge.classList.add("hidden");
  }

  // モチベーションメッセージ
  const msg = $("motivation-message");
  if (msg && isConfigured()) {
    msg.textContent = pickMessage();
    msg.classList.remove("hidden");
  }

  // 貯金箱ボタンの状態
  const piggyBtn = $("btn-piggy");
  if (piggyBtn) {
    if (state.piggyBank > 0) {
      piggyBtn.classList.add("has-money");
    } else {
      piggyBtn.classList.remove("has-money");
    }
  }
}

// SVG円グラフ用のフォールバックパレット
const CHART_COLORS = [
  "#FF6B9D", "#7DCEA0", "#5DADE2", "#F5B041", "#BB8FCE",
  "#48C9B0", "#EC7063", "#F1948A", "#85C1E2", "#F8C471",
  "#AF7AC5", "#58D68D", "#F4D03F", "#EB984E", "#5499C7",
  "#48D1CC", "#FFA07A", "#98D8C8", "#DDA0DD", "#87CEEB"
];

// カテゴリ→色 ジャンル別に系統色を割り当て
// 自己投資=グリーン系 / 趣味=ピンク系 / 体験・交友=ブルー系 / 食事=オレンジ系 / その他=グレー
const CATEGORY_COLORS = {
  // ── 自己投資（Green系）──
  "ネイル":       "#48C9B0",  // ミントグリーン
  "まつぱ/眉毛":  "#58D68D",  // ミディアムグリーン
  "美容院":       "#4CAF50",  // フォレストグリーン
  "コスメ":       "#82E0AA",  // ライトグリーン
  "歯医者":       "#26A69A",  // ティール

  // ── 趣味（Pink系）──
  "ファッション": "#FF6B9D",  // ホットピンク
  "本":           "#F48FB1",  // ソフトピンク
  "趣味グッズ":   "#EC407A",  // マゼンタピンク
  "ガチャ":       "#F06292",  // ローズ
  "100均":        "#FFB6C1",  // ライトピンク
  "サンリオ":     "#E91E63",  // ピンク
  "WICKED":       "#AD1457",  // ディープピンク

  // ── 体験・交友（Blue系）──
  "展示/イベント": "#5DADE2", // スカイブルー
  "プレゼント":    "#3498DB", // ブルー
  "旅行":          "#29B6F6", // ライトブルー

  // ── 食事（Orange系）──
  "出社日食事":    "#FF9800", // オレンジ
  "外食":          "#F57C00", // ディープオレンジ
  "カフェ":        "#FFB74D", // ライトオレンジ

  // ── その他（Gray）──
  "その他":        "#9E9E9E",

  // ── 旧カテゴリ（過去データ互換）──
  "サブスク":      "#F06292",  // ピンク
  "服":            "#FF6B9D",  // ピンク（ファッション相当）
  "推し活":        "#EC407A",  // ピンク（趣味グッズ相当）
  "FC":            "#FFB6C1",  // ピンク
  "その他購入品":  "#B0BEC5",  // グレー寄り
  "会社ランチ":    "#FF9800",  // オレンジ（出社日食事相当）
  "食事":          "#F57C00",  // オレンジ（外食相当）
  "特急/グリーン": "#5DADE2",  // ブルー
  "奨学金":        "#9E9E9E",  // グレー
  "はるひ散髪":    "#4CAF50"   // グリーン
};

function colorFor(category, fallbackIndex = 0) {
  return CATEGORY_COLORS[category] || CHART_COLORS[fallbackIndex % CHART_COLORS.length];
}

// カテゴリ→絵文字アイコン
const CATEGORY_ICONS = {
  // ── 現在のシート ──
  "ネイル": "💅",
  "まつぱ/眉毛": "👁",
  "美容院": "💇‍♀️",
  "コスメ": "💄",
  "歯医者": "🦷",
  "ファッション": "👚",
  "本": "📚",
  "趣味グッズ": "❤️‍🔥",
  "ガチャ": "😊",
  "100均": "🐶",
  "サンリオ": "🏰",
  "WICKED": "🫧",
  "展示/イベント": "🖼️",
  "プレゼント": "🎁",
  "旅行": "✈️",
  "出社日食事": "🏢",
  "外食": "🍽️",
  "カフェ": "☕️",
  "その他": "🤍",
  // ── 旧カテゴリ（過去データ互換用） ──
  "サブスク": "📺",
  "服": "👗",
  "推し活": "💖",
  "FC": "🎫",
  "その他購入品": "🛍️",
  "会社ランチ": "🍱",
  "食事": "🍴",
  "特急/グリーン": "🚄",
  "奨学金": "🎓",
  "はるひ散髪": "✂️"
};

function iconFor(category) {
  return CATEGORY_ICONS[category] || "🏷️";
}

/// 今月のカテゴリごとの色マップ（CATEGORY_COLORS優先、なければCHART_COLORSフォールバック）
function categoryColorMap() {
  const monthExp = currentMonthExpenses();
  const byCat = {};
  monthExp.forEach(e => {
    byCat[e.category] = (byCat[e.category] || 0) + e.amount;
  });
  const sorted = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const map = {};
  sorted.forEach(([name, _], i) => {
    map[name] = colorFor(name, i);
  });
  return map;
}

function polarToCartesian(cx, cy, radius, angleInDegrees) {
  const rad = (angleInDegrees - 90) * Math.PI / 180;
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
}

function describeArc(cx, cy, radius, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, radius, endAngle);
  const end = polarToCartesian(cx, cy, radius, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? "0" : "1";
  return [
    "M", cx, cy,
    "L", start.x, start.y,
    "A", radius, radius, 0, largeArc, 0, end.x, end.y,
    "Z"
  ].join(" ");
}

function renderCategoryChart() {
  const card = $("chart-card");
  if (!card) return;
  const monthExp = currentMonthExpenses();
  if (monthExp.length === 0) {
    card.classList.add("hidden");
    return;
  }
  const byCat = {};
  monthExp.forEach(e => {
    byCat[e.category] = (byCat[e.category] || 0) + e.amount;
  });
  const sorted = Object.entries(byCat)
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount);
  const total = sorted.reduce((a, x) => a + x.amount, 0);
  if (total === 0) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");

  const cx = 100, cy = 100, radius = 90;
  const slicesHtml = [];
  const iconsHtml = [];
  const legendHtml = [];
  let angle = 0;

  sorted.forEach((cat, i) => {
    const color = colorFor(cat.name, i);
    const percentage = cat.amount / total;
    const arcAngle = percentage * 360;

    if (sorted.length === 1) {
      // 1カテゴリのみの場合はcircle
      slicesHtml.push(`<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${color}"/>`);
    } else {
      slicesHtml.push(`<path d="${describeArc(cx, cy, radius, angle, angle + arcAngle)}" fill="${color}"/>`);
    }

    // 大きめの slice にはアイコンを乗せる
    if (percentage >= 0.06) {
      const midAngle = angle + arcAngle / 2;
      const iconRadius = radius * 0.6;
      const iconPos = polarToCartesian(cx, cy, iconRadius, midAngle);
      iconsHtml.push(`<text x="${iconPos.x}" y="${iconPos.y}" font-size="16" text-anchor="middle" dominant-baseline="central">${iconFor(cat.name)}</text>`);
    }

    const pct = Math.round(percentage * 100);
    legendHtml.push(`
      <div class="legend-item">
        <span class="legend-color" style="background:${color}"></span>
        <span class="legend-icon">${iconFor(cat.name)}</span>
        <span class="legend-name">${escapeHtml(cat.name)}</span>
        <span class="legend-amount">${formatYen(cat.amount)}<span class="legend-pct">(${pct}%)</span></span>
      </div>
    `);
    angle += arcAngle;
  });

  $("chart-svg").innerHTML = `<svg viewBox="0 0 200 200" style="width:100%;height:auto;display:block;">${slicesHtml.join("")}${iconsHtml.join("")}</svg>`;
  $("chart-legend").innerHTML = legendHtml.join("");
  $("chart-total").textContent = `合計 ${formatYen(total)}`;
}

function renderExpenseList() {
  const list = $("expense-list");
  const empty = $("expense-empty");
  const current = currentMonthExpenses();
  if (current.length === 0) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
  } else {
    empty.classList.add("hidden");
    // 当月のみ＋日付の新しい順
    const sorted = expensesForMonthSorted(monthKey());
    const colorMap = categoryColorMap();
    list.innerHTML = sorted.map(e => {
      const color = colorMap[e.category] || "#999999";
      const icon = iconFor(e.category);
      return `
      <div class="expense-row" data-id="${e.id}">
        <div class="expense-avatar" style="background:${color}33;">${icon}</div>
        <div class="expense-info">
          <div class="expense-name">${escapeHtml(e.name)}</div>
          <div class="expense-meta">
            <span class="expense-cat-chip">${escapeHtml(e.category)}</span>
            <span>${formatDateForList(e.date)}</span>
          </div>
        </div>
        <div class="expense-amount">${formatYen(e.amount)}</div>
      </div>
    `;
    }).join("");
    list.querySelectorAll(".expense-row").forEach(el => {
      el.addEventListener("click", () => {
        const id = el.dataset.id;
        const expense = state.expenses.find(x => x.id === id);
        if (expense) openEditModal(expense);
      });
    });
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderAll() {
  if (!isConfigured()) {
    showScreen("screen-onboarding");
    return;
  }
  showScreen("screen-main");
  renderBalance();
  renderCategoryChart();
  renderExpenseList();
}

function renderAuthStatus() {
  const text = $("auth-text");
  if (isSignedIn()) {
    text.textContent = userEmail ? `接続済み: ${userEmail}` : "接続済み";
    $("btn-signin").classList.add("hidden");
    $("btn-signout").classList.remove("hidden");
  } else {
    text.textContent = "未接続";
    $("btn-signin").classList.remove("hidden");
    $("btn-signout").classList.add("hidden");
  }
}

// =====================================================
// 編集モーダル
// =====================================================
let editingId = null;
let userEditedCategory = false;

function openAddModal() {
  editingId = null;
  userEditedCategory = false;
  $("edit-title").textContent = "支出を追加";
  $("edit-name").value = "";
  $("edit-amount").value = "";
  $("edit-date").value = todayISO();
  populateCategorySelect();
  if (state.categoryRows.length > 0) {
    $("edit-category").value = state.categoryRows[0].name;
  }
  $("edit-delete-section").classList.add("hidden");
  $("edit-save").textContent = "保存";
  updateEditPreview();
  showModal("modal-edit");
  setTimeout(() => $("edit-amount").focus(), 50);
}

function openEditModal(e) {
  editingId = e.id;
  userEditedCategory = true;
  $("edit-title").textContent = "支出を編集";
  $("edit-name").value = e.name;
  $("edit-amount").value = String(e.amount);
  $("edit-date").value = e.date;
  populateCategorySelect();
  $("edit-category").value = e.category;
  $("edit-delete-section").classList.remove("hidden");
  $("edit-save").textContent = "更新";
  updateEditPreview();
  showModal("modal-edit");
}

function populateCategorySelect() {
  const sel = $("edit-category");
  sel.innerHTML = state.categoryRows
    .map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`)
    .join("");
  if (state.categoryRows.length === 0) {
    sel.innerHTML = `<option value="">（カテゴリ未設定）</option>`;
  }
}

function updateEditPreview() {
  const amt = parseInt($("edit-amount").value, 10) || 0;
  const orig = editingId
    ? (state.expenses.find(x => x.id === editingId)?.amount || 0)
    : 0;
  const previewRem = remaining() + orig - amt;
  const el = $("edit-preview");
  el.textContent = formatYen(previewRem);
  el.style.color = previewRem < 0 ? "var(--red)" : "";
  $("edit-save").disabled = !($("edit-name").value.trim() && amt > 0);
}

function saveEdit() {
  const name = $("edit-name").value.trim();
  const amount = parseInt($("edit-amount").value, 10) || 0;
  const category = $("edit-category").value || (state.categoryRows[0]?.name || "その他");
  const date = $("edit-date").value || todayISO();
  if (!name || amount <= 0) return;

  if (editingId) {
    const idx = state.expenses.findIndex(e => e.id === editingId);
    if (idx >= 0) {
      state.expenses[idx] = { ...state.expenses[idx], name, amount, category, date };
    }
  } else {
    state.expenses.unshift({
      id: Math.random().toString(36).slice(2) + Date.now().toString(36),
      name, amount, category, date,
    });
  }
  saveState();
  renderAll();
  hideModal("modal-edit");
  // サマリーが開いていればリフレッシュ
  if (currentSummaryKey && !$("modal-summary").classList.contains("hidden")) {
    openSummary(currentSummaryKey);
  }
}

function deleteEdit() {
  if (!editingId) return;
  if (!confirm("この記録を削除しますか？")) return;
  state.expenses = state.expenses.filter(e => e.id !== editingId);
  saveState();
  renderAll();
  hideModal("modal-edit");
  if (currentSummaryKey && !$("modal-summary").classList.contains("hidden")) {
    openSummary(currentSummaryKey);
  }
}

// =====================================================
// 設定モーダル
// =====================================================
function openSettings() {
  // 表示は「今月の目標額」（monthlyBudgets[今月] があればそれ、なければデフォルト）
  const curBud = budgetForMonth(monthKey());
  $("settings-budget").value = curBud > 0 ? String(curBud) : "";
  const goalEl = $("settings-goal");
  if (goalEl) goalEl.value = goalForMonth(monthKey());
  $("settings-rollover").checked = state.rolloverEnabled;
  $("settings-ss-id").value = state.spreadsheetId || "";
  $("settings-sheet-name").value = state.sheetName || "";
  renderAuthStatus();
  renderCategoriesList();
  renderHistoryList();
  showModal("modal-settings");
}

function renderCategoriesList() {
  const section = $("categories-list-section");
  if (state.categoryRows.length === 0) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");
  $("categories-list").innerHTML = state.categoryRows.map((c, i) => `
    <div class="category-row">
      <span>${escapeHtml(c.name)}</span>
      <span class="row-num">行 ${c.row}</span>
      <button class="delete-btn" data-idx="${i}">×</button>
    </div>
  `).join("");
  $("categories-list").querySelectorAll(".delete-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx, 10);
      state.categoryRows.splice(idx, 1);
      saveState();
      renderCategoriesList();
    });
  });
}

function renderHistoryList() {
  const keys = pastMonthsWithData();
  const section = $("history-section");
  if (keys.length === 0) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");
  $("history-list").innerHTML = keys.map(k => {
    const total = expensesForMonth(k).reduce((a, e) => a + e.amount, 0);
    return `
      <div class="history-row" data-key="${k}">
        <span>${formatMonthLabel(k)}</span>
        <span style="display:flex;align-items:center;gap:8px;">
          <span class="muted mono">${formatYen(total)}</span>
          <span class="chev">›</span>
        </span>
      </div>
    `;
  }).join("");
  $("history-list").querySelectorAll(".history-row").forEach(el => {
    el.addEventListener("click", () => {
      openSummary(el.dataset.key);
    });
  });
}

function saveSettings() {
  const v = parseInt($("settings-budget").value, 10);
  if (v > 0) {
    // 目標額の変更は「今月のみ」に適用（過去月は影響を受けない）
    if (!state.monthlyBudgets) state.monthlyBudgets = {};
    state.monthlyBudgets[monthKey()] = v;
    // 新規月のデフォルト値も更新（翌月以降がこの値を継承）
    state.monthlyBudget = v;
  }
  // 今月の目標文言（自由記入）
  const goalEl = $("settings-goal");
  if (goalEl) {
    if (!state.monthlyGoals) state.monthlyGoals = {};
    const goalText = goalEl.value.trim();
    if (goalText) {
      state.monthlyGoals[monthKey()] = goalText;
    } else {
      delete state.monthlyGoals[monthKey()];
    }
  }
  state.rolloverEnabled = $("settings-rollover").checked;
  state.spreadsheetId = $("settings-ss-id").value.trim();
  state.sheetName = $("settings-sheet-name").value.trim();
  saveState();
  renderAll();
}

async function fetchCategoriesAction() {
  if (!state.spreadsheetId || !state.sheetName) {
    showToast("スプレッドシートIDとシート名を保存してください");
    return;
  }
  try {
    await ensureSignedIn();
    const rows = await fetchCategoryRowsFromSheet(state.spreadsheetId, state.sheetName);
    state.categoryRows = rows;
    saveState();
    renderCategoriesList();
    showToast(`${rows.length}件のカテゴリを取り込みました`);
  } catch (e) {
    showToast(e.message);
  }
}

// =====================================================
// 同期
// =====================================================
/// monthKey ("YYYY-MM") を指定するとその月をシートへ書き込む。
/// 省略時は現在月。
async function syncMonth(targetMonthKey = null) {
  if (!canSync()) {
    showToast("シート設定が不足しています");
    return;
  }
  const key = targetMonthKey || monthKey();
  try {
    await ensureSignedIn();

    // 対象月の "yyyy/MM" ヘッダー
    const [y, m] = key.split("-").map(Number);
    const header = `${y}/${pad2(m)}`;

    const sheetId = await getSheetId(state.spreadsheetId, state.sheetName);
    const colIdx = await findMonthColumnIndex(state.spreadsheetId, state.sheetName, header);
    if (colIdx < 0) throw new Error(`シート上で「${header}」の列が見つかりませんでした`);

    const monthExpenses = expensesForMonth(key);
    const updates = [];
    for (const cat of state.categoryRows) {
      if (cat.row === 31) continue;
      const items = monthExpenses
        .filter(e => e.category === cat.name)
        .sort((a, b) => b.date.localeCompare(a.date));
      if (!items.length) continue;
      const total = items.reduce((a, e) => a + e.amount, 0);
      const note = items.map(it => `¥${formatNumber(it.amount)} ${it.name}`).join("\n");
      updates.push({
        rowIndex: cat.row - 1,
        columnIndex: colIdx,
        value: total,
        note,
      });
    }
    if (!updates.length) {
      showToast("書き込むデータがありません");
      return;
    }
    await writeValuesWithNotes(state.spreadsheetId, sheetId, updates);
    showToast(`${updates.length}件のカテゴリを${header}列に書き込みました`);
    // 同期したらメッセージを更新
    rotateMessage();
    renderBalance();
  } catch (e) {
    showToast(e.message);
  }
}

async function syncAction() {
  const btn = $("btn-sync");
  btn.disabled = true;
  try {
    await syncMonth();
  } finally {
    btn.disabled = false;
  }
}

// =====================================================
// 月末サマリー画面
// =====================================================
let currentSummaryKey = null;

function openSummary(key) {
  const s = getSummary(key);
  if (!s) return;
  currentSummaryKey = key;
  const saved = s.monthlyBudget - s.totalSpent;
  let savedClass = "";
  let savedText = "";
  let icon = "✨";
  if (saved > 0) { savedClass = "green"; savedText = `${formatYen(saved)} 節約できました 🌱`; icon = "🌱"; }
  else if (saved < 0) { savedClass = "orange"; savedText = `${formatYen(saved)} オーバーしました`; icon = "🔥"; }
  else { savedText = "ぴったりでした"; }

  const weeksHtml = s.weekSpents.map((sp, i) => {
    const bd = s.weekBudgets[i];
    const rem = bd - sp;
    const r = computeRating(sp, bd);
    return `
      <div class="week-row">
        <div class="week-row-left">
          <div class="week-row-label">
            ${i + 1}週目
            <span class="tag rating-${r}">${ratingLabel(r)}</span>
          </div>
        </div>
        <div class="week-row-right">
          <div class="week-row-budget">${formatYen(sp)} / ${formatYen(bd)}</div>
          <div class="week-row-remaining ${rem >= 0 ? "green" : "red"}" style="font-size:13px;">${rem >= 0 ? "+" : ""}${formatYen(rem)}</div>
        </div>
      </div>
    `;
  }).join("");

  // 日付順の記録一覧（今月の記録のような表示）
  const recordsSorted = expensesForMonthSorted(key);
  const recordsHtml = recordsSorted.map(e => `
    <div class="expense-row summary-record" data-id="${e.id}">
      <div class="expense-info">
        <div class="expense-name">${escapeHtml(e.name)}</div>
        <div class="expense-meta">
          <span class="expense-cat-chip">${escapeHtml(e.category)}</span>
          <span>${formatDateForList(e.date)}</span>
        </div>
      </div>
      <div class="expense-amount">${formatYen(e.amount)}</div>
    </div>
  `).join("");

  const showSyncBtn = canSync();

  $("summary-body").innerHTML = `
    <div class="summary-hero">
      <div class="icon">${icon}</div>
      <h3>${formatMonthLabel(key)} のまとめ</h3>
      <div class="saved ${savedClass}">${savedText}</div>
    </div>
    <div class="form-section">
      <div class="preview-row"><span>目標</span><span class="mono">${formatYen(s.monthlyBudget)}</span></div>
      <div class="preview-row"><span>使った合計</span><span class="mono">${formatYen(s.totalSpent)}</span></div>
      <hr style="border:0;border-top:1px solid var(--separator);margin:8px 0;">
      <div class="preview-row" style="font-weight:600;">
        <span>${saved >= 0 ? "節約できた額" : "オーバー額"}</span>
        <span class="mono ${savedClass}">${saved > 0 ? "+" : ""}${formatYen(saved)}</span>
      </div>
    </div>
    ${showSyncBtn ? `<button class="btn-secondary" id="summary-sync-btn" style="margin-bottom:16px;">この月をシートに反映</button>` : ""}
    ${weeksHtml ? `<div class="form-section"><div class="muted small" style="margin-bottom:8px;">週ごとの結果</div>${weeksHtml}</div>` : ""}
    ${recordsHtml ? `<div class="form-section"><div class="muted small" style="margin-bottom:8px;">記録（日付順）</div>${recordsHtml}</div>` : `<div class="form-section"><div class="muted small">記録がありません</div></div>`}
    <button class="btn-secondary" id="summary-categories-btn">📂 カテゴリ別で確認</button>
  `;

  // ボタンのバインド
  const syncBtn = document.getElementById("summary-sync-btn");
  if (syncBtn) {
    syncBtn.addEventListener("click", async () => {
      syncBtn.disabled = true;
      try {
        await syncMonth(key);
      } finally {
        syncBtn.disabled = false;
      }
    });
  }
  const catsBtn = document.getElementById("summary-categories-btn");
  if (catsBtn) {
    catsBtn.addEventListener("click", () => openCategoriesView(key));
  }
  // 記録行タップで編集
  document.querySelectorAll(".summary-record").forEach(el => {
    el.addEventListener("click", () => {
      const id = el.dataset.id;
      const expense = state.expenses.find(x => x.id === id);
      if (expense) openEditModal(expense);
    });
  });

  showModal("modal-summary");
}

function openCategoriesView(key) {
  const s = getSummary(key);
  if (!s) return;
  const catsHtml = s.categoryTotals.length === 0
    ? `<div class="muted small">記録がありません</div>`
    : s.categoryTotals.map(c => `
        <div class="week-row">
          <div>${escapeHtml(c.name)}</div>
          <div class="muted mono">${formatYen(c.amount)}</div>
        </div>
      `).join("");
  $("categories-body").innerHTML = `
    <div class="summary-hero" style="padding:16px 0;">
      <h3>${formatMonthLabel(key)} カテゴリ別</h3>
      <div class="muted small">合計 ${formatYen(s.totalSpent)}</div>
    </div>
    <div class="form-section">${catsHtml}</div>
  `;
  showModal("modal-categories");
}

// =====================================================
// イベントハンドラ
// =====================================================
function bindEvents() {
  // Onboarding
  $("onboarding-amount").addEventListener("input", () => {
    const v = parseInt($("onboarding-amount").value, 10) || 0;
    $("onboarding-start").disabled = v <= 0;
  });
  $("onboarding-start").addEventListener("click", () => {
    const v = parseInt($("onboarding-amount").value, 10) || 0;
    if (v > 0) {
      state.monthlyBudget = v;
      if (!state.monthlyBudgets) state.monthlyBudgets = {};
      state.monthlyBudgets[monthKey()] = v;
      saveState();
      renderAll();
    }
  });

  // Header
  $("btn-settings").addEventListener("click", openSettings);
  $("btn-sync").addEventListener("click", syncAction);
  $("btn-add").addEventListener("click", openAddModal);
  $("btn-piggy").addEventListener("click", releasePiggyBank);

  // Edit modal
  $("edit-cancel").addEventListener("click", () => hideModal("modal-edit"));
  $("edit-save").addEventListener("click", saveEdit);
  $("edit-delete").addEventListener("click", deleteEdit);
  $("edit-name").addEventListener("input", () => {
    if (!userEditedCategory) {
      const cats = state.categoryRows.map(c => c.name);
      const suggested = suggestCategory($("edit-name").value, cats);
      if (suggested) $("edit-category").value = suggested;
    }
    updateEditPreview();
  });
  $("edit-amount").addEventListener("input", updateEditPreview);
  $("edit-category").addEventListener("change", () => { userEditedCategory = true; });

  // Settings modal
  $("settings-close").addEventListener("click", () => {
    saveSettings();
    hideModal("modal-settings");
  });
  $("btn-signin").addEventListener("click", async () => {
    try { await signIn(); } catch (e) { showToast(e.message); }
  });
  $("btn-signout").addEventListener("click", signOut);
  $("btn-fetch-categories").addEventListener("click", async () => {
    saveSettings();
    await fetchCategoriesAction();
  });

  // Summary modal
  $("summary-close").addEventListener("click", () => hideModal("modal-summary"));
  $("categories-back").addEventListener("click", () => hideModal("modal-categories"));

  // Backup
  $("btn-export").addEventListener("click", exportData);
  $("import-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) importData(file);
    e.target.value = "";
  });
}

// =====================================================
// バックアップ / 復元
// =====================================================
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const date = todayISO();
  a.href = url;
  a.download = `okozukai-backup-${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("バックアップを保存しました");
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const imported = JSON.parse(e.target.result);
      if (!confirm("現在のデータを上書きします。よろしいですか？")) return;
      state = { ...defaultState, ...imported };
      saveState();
      renderAll();
      showToast("データを復元しました");
    } catch (err) {
      showToast("ファイル読み込み失敗: " + err.message);
    }
  };
  reader.readAsText(file);
}

// =====================================================
// 初期化
// =====================================================
function init() {
  bindEvents();
  checkMonthReset();
  depositPastSavings();
  renderAll();
  if (pendingSummaryKey) {
    setTimeout(() => openSummary(pendingSummaryKey), 300);
    pendingSummaryKey = null;
  }
  // Service Worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }
}
init();
