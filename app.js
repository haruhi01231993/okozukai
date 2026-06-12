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
  monthlyBudget: 0,
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

// 旧データ構造（history に過去月の expenses を分けて保存）から
// 新構造（全 expenses を1つの配列に）へマイグレーション。
function migrateState(s) {
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
function effectiveBudget(forKey = null) {
  const key = forKey || monthKey();
  return state.monthlyBudget + (state.monthlyBoosts[key] || 0);
}

function totalSpent() {
  return currentMonthExpenses().reduce((a, e) => a + e.amount, 0);
}
function remaining() {
  return effectiveBudget() - totalSpent();
}
function isConfigured() {
  return state.monthlyBudget > 0;
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
    (over) => `💡 残りの週で少し抑えれば取り戻せる`,
    (over) => `🍵 来週はスローダウンしてみよう`,
    (over) => `📊 後半戦、ここから挽回！`,
    (over) => `🌷 オーバーした分は次の節約で取り返せる`,
    (over) => `🎯 ${formatYen(Math.abs(over))}多め。残り週で工夫してみよう`,
    (over) => `🔄 ペース調整中。気にせず続けよう`,
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
    const monthExp = expensesForMonth(key);
    const spent = monthExp.reduce((a, e) => a + e.amount, 0);
    // 実効予算（基本 + ブースト）に対する節約分を積算
    const monthBud = state.monthlyBudget + (state.monthlyBoosts[key] || 0);
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
  if (!confirm("貯金箱を開けますか？\n中身は明かしませんが、今月のおこづかいに上乗せされます。")) return;
  const cur = monthKey();
  state.monthlyBoosts[cur] = (state.monthlyBoosts[cur] || 0) + state.piggyBank;
  state.piggyBank = 0;
  saveState();
  renderAll();
  showToast("🎉 おこづかいがブーストされた！");
}

function ratingLabel(r) {
  return ({excellent: "★★★", good: "★★", warning: "★", over: "超過"})[r];
}

// =====================================================
// カテゴリ自動分類
// =====================================================
const KEYWORDS = {
  "ジム": ["ジム", "gym", "フィットネス", "ヨガ", "ピラティス"],
  "ネイル": ["ネイル", "nail", "マニキュア", "ジェル"],
  "まつぱ": ["まつぱ", "まつパ", "まつ毛", "マツエク", "まつげ", "アイラッシュ"],
  "眉毛": ["眉", "アイブロウ", "まゆ"],
  "美容院": ["美容院", "美容室", "カット", "カラー", "パーマ", "縮毛", "ヘア"],
  "コスメ": ["コスメ", "化粧品", "ファンデ", "リップ", "口紅", "アイシャドウ", "メイク", "下地", "マスカラ", "チーク"],
  "サブスク": ["サブスク", "Netflix", "Spotify", "Apple Music", "YouTube Premium", "Amazon Prime", "Disney"],
  "服": ["服", "シャツ", "パンツ", "ワンピ", "コート", "スカート", "ジャケット", "Tシャツ", "ニット", "デニム", "セーター"],
  "サンリオ": ["サンリオ", "キティ", "シナモロール", "クロミ", "マイメロ", "ポムポムプリン", "ポチャッコ"],
  "本": ["本", "書籍", "雑誌", "漫画", "コミック", "kindle"],
  "ガチャ": ["ガチャ", "カプセル"],
  "推し活": ["推し", "ライブ", "コンサート", "グッズ", "チェキ", "アクスタ", "缶バッジ", "舞台"],
  "FC": ["FC", "ファンクラブ", "会員費", "年会費"],
  "プレゼント": ["プレゼント", "ギフト", "誕生日", "お祝い", "祝い"],
  "旅行": ["旅行", "ホテル", "宿", "飛行機", "新幹線", "観光"],
  "食事": ["食事", "ランチ", "ディナー", "カフェ", "コーヒー", "コンビニ", "レストラン", "外食", "スタバ", "ご飯", "焼肉", "寿司"],
  "特急/グリーン": ["特急", "グリーン", "新幹線"],
  "奨学金": ["奨学金"],
  "はるひ散髪": ["はるひ"],
};

function suggestCategory(text, categories) {
  if (!categories.length) return "その他";
  const lower = text.toLowerCase();
  for (const c of categories) {
    const kws = KEYWORDS[c];
    if (!kws) continue;
    for (const kw of kws) {
      if (lower.includes(kw.toLowerCase())) return c;
    }
  }
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
  const monthExpenses = expensesForMonth(key);
  if (monthExpenses.length === 0) return null;
  return buildMonthSummary(key, monthExpenses, state.monthlyBudget);
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
  $("balance-amount").textContent = formatYen(r);
  $("balance-amount").classList.toggle("negative", r < 0);
  $("balance-spent").textContent = "使った: " + formatYen(t);
  $("balance-budget").textContent = "目標: " + formatYen(state.monthlyBudget);

  const pct = state.monthlyBudget > 0 ? Math.min(Math.max(t / state.monthlyBudget * 100, 0), 100) : 0;
  $("progress-fill").style.width = pct + "%";
  $("progress-fill").classList.toggle("over", r < 0);

  const sav = monthSavings();
  const badge = $("savings-badge");
  if (sav > 0) {
    badge.classList.remove("hidden", "negative");
    badge.classList.add("positive");
    badge.innerHTML = `🌱 +${formatYen(sav)} 節約中`;
  } else if (sav < 0) {
    badge.classList.remove("hidden", "positive");
    badge.classList.add("negative");
    badge.innerHTML = `⚠️ ${formatYen(sav)} ペースオーバー`;
  } else {
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

function renderWeekly() {
  const weeks = weekBreakdowns();
  const card = $("weekly-card");
  if (weeks.length === 0) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  const rows = weeks.map(w => {
    const tagHtml = [];
    if (w.state === "current") tagHtml.push(`<span class="tag current">今週</span>`);
    if (w.rating) tagHtml.push(`<span class="tag rating-${w.rating}">${ratingLabel(w.rating)}</span>`);
    let remColor = "";
    if (w.remaining < 0) remColor = "red";
    else if (w.state === "completed" && w.remaining > 0) remColor = "green";
    return `
      <div class="week-row">
        <div class="week-row-left">
          <div class="week-row-label ${w.state === "current" ? "current" : ""}">
            ${w.weekIndex}週目
            ${tagHtml.join("")}
          </div>
          <div class="week-row-dates">${w.month}/${w.startDay} – ${w.month}/${w.endDay}</div>
        </div>
        <div class="week-row-right">
          <div class="week-row-remaining ${remColor}">${formatYen(w.remaining)}</div>
          <div class="week-row-budget">/ ${formatYen(w.budget)}</div>
        </div>
      </div>
    `;
  }).join("");
  $("weekly-rows").innerHTML = rows;
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
    list.innerHTML = sorted.map(e => `
      <div class="expense-row" data-id="${e.id}">
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
  renderWeekly();
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
  $("settings-budget").value = state.monthlyBudget > 0 ? String(state.monthlyBudget) : "";
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
  if (v > 0) state.monthlyBudget = v;
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
