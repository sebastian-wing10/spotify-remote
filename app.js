'use strict';

// ===== 設定 =====
const SCOPES = [
  'user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing',
  'user-read-recently-played',
  'playlist-read-private', 'playlist-read-collaborative', 'playlist-modify-public', 'playlist-modify-private',
  'user-library-read', 'user-library-modify',
  'user-top-read',
].join(' ');
const POLL_MS = 3000;        // 再生状態の取得間隔
const QUEUE_POLL_MS = 15000; // キューは曲が変わったとき + この間隔で取得
const STATS_POLL_MS = 5 * 60 * 1000;
const API = 'https://api.spotify.com/v1';

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

// ===== 認証（Authorization Code + PKCE） =====
function randomString(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

async function sha256base64url(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function login(clientId = $('client-id').value.trim()) {
  if (!/^[0-9a-f]{32}$/i.test(clientId)) {
    showSetupError('Client ID は32文字の英数字です。');
    return;
  }
  store.set('client_id', clientId);
  const verifier = randomString(64);
  store.set('pkce_verifier', verifier);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: await sha256base64url(verifier),
    redirect_uri: redirectUri(),
  });
  location.href = 'https://accounts.spotify.com/authorize?' + params;
}

async function requestToken(body) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: store.get('client_id'), ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || 'token error');
  store.set('access_token', data.access_token);
  store.set('expires_at', String(Date.now() + (data.expires_in - 60) * 1000));
  if (data.refresh_token) store.set('refresh_token', data.refresh_token);
  if (data.scope) store.set('scope', data.scope);
}

function hasScope(s) {
  return (store.get('scope') || '').split(' ').includes(s);
}

async function handleCallback() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return;
  history.replaceState(null, '', redirectUri());
  if (q.has('error')) throw new Error('ログインがキャンセルされました（' + q.get('error') + '）');
  await requestToken({
    grant_type: 'authorization_code',
    code: q.get('code'),
    redirect_uri: redirectUri(),
    code_verifier: store.get('pkce_verifier'),
  });
  store.del('pkce_verifier');
}

let refreshing = null;
async function accessToken(force = false) {
  if (!force && store.get('access_token') && Date.now() < Number(store.get('expires_at'))) {
    return store.get('access_token');
  }
  if (!store.get('refresh_token')) throw new AuthError();
  // 同時に何本もリフレッシュしないようにまとめる
  refreshing ??= requestToken({ grant_type: 'refresh_token', refresh_token: store.get('refresh_token') })
    .finally(() => { refreshing = null; });
  try {
    await refreshing;
  } catch {
    throw new AuthError();
  }
  return store.get('access_token');
}

class AuthError extends Error {}

async function logout() {
  // 規約上、連携を解除したら Spotify から得たデータ（再生履歴の記録）も消す
  ['access_token', 'refresh_token', 'expires_at', 'scope', 'history', 'history_gap', 'quiz_best', 'quiz_sessions'].forEach(store.del);
  try { await kvDel('history'); } catch {}
  location.reload();
}

// ===== API 呼び出し =====
class ApiError extends Error {
  constructor(status, message, reason) { super(message); this.status = status; this.reason = reason; }
}

async function api(method, path, body, retried = false) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + await accessToken(retried),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !retried) return api(method, path, body, true);
  if (res.status === 429) {
    const wait = Number(res.headers.get('Retry-After') || 2);
    throw new ApiError(429, `リクエストが多すぎます。${wait}秒ほど待ってください。`);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const err = data?.error || {};
    throw new ApiError(res.status, err.message || res.statusText, err.reason);
  }
  return data;
}

// ===== カスタマイズ設定 =====
const SECTION_LABELS = {
  art: 'ジャケット画像',
  info: '曲名・アーティスト',
  seek: '時間バー',
  controls: '再生ボタン',
  volume: '音量',
  stats: '今日聞いた時間',
  queue: '次に再生',
};
const ACCENTS = ['#1ed760', '#3d91f4', '#ff6b9a', '#ffb020', '#a970ff', '#ff5a36'];
const DEFAULT_SETTINGS = {
  order: Object.keys(SECTION_LABELS),
  hidden: [],
  bg: 'dark',
  accent: ACCENTS[0],
  art: 'm',
  artStyle: 'square',
  font: 'm',
  queueCount: 20,
  // スタンバイ（時計）モード
  sb: {
    order: ['clock', 'date', 'now', 'next', 'today'],
    hidden: ['next', 'today'],
    size: 'm',
    weight: 'thin',
    hour12: false,
    seconds: false,
    landscape: 'left',
    bg: 'glow',
    night: 'off',
  },
};
const SB_LABELS = {
  clock: '時計',
  date: '日付',
  now: '再生中の曲',
  next: '次の曲',
  today: '今日聞いた時間',
};

// 項目が増減しても壊れないよう、知らないIDは捨てて足りないIDは末尾に足す
function normalizeOrder(order, labels) {
  const o = order.filter((id) => id in labels);
  Object.keys(labels).forEach((id) => { if (!o.includes(id)) o.push(id); });
  return o;
}

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(store.get('settings') || '{}'); } catch {}
  const s = { ...DEFAULT_SETTINGS, ...saved, sb: { ...DEFAULT_SETTINGS.sb, ...saved.sb } };
  s.order = normalizeOrder(s.order, SECTION_LABELS);
  s.sb.order = normalizeOrder(s.sb.order, SB_LABELS);
  return s;
}

// "sb.size" のような入れ子のキーで読み書きする
function getSetting(key) {
  return key.split('.').reduce((o, k) => o?.[k], settings);
}

function setSetting(key, raw) {
  const keys = key.split('.');
  const last = keys.pop();
  const obj = keys.reduce((o, k) => o[k], settings);
  const def = keys.reduce((o, k) => o[k], DEFAULT_SETTINGS)[last];
  obj[last] = typeof def === 'number' ? Number(raw) : typeof def === 'boolean' ? raw === 'true' : raw;
}

let settings = loadSettings();

function saveSettings() {
  store.set('settings', JSON.stringify(settings));
  applySettings();
}

function applySettings() {
  const root = document.documentElement;
  root.dataset.bg = settings.bg;
  root.dataset.art = settings.art;
  root.dataset.artStyle = settings.artStyle;
  root.dataset.font = settings.font;
  root.style.setProperty('--accent', settings.accent);
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(root).getPropertyValue('--bg').trim();

  const box = $('sections');
  settings.order.forEach((id) => {
    const sec = box.querySelector(`[data-section="${id}"]`);
    sec.hidden = settings.hidden.includes(id);
    box.append(sec);
  });

  renderQueue(lastQueue);
  renderSettingsSheet();
  updateArtColor();
  applyStandby();
}

// 表示/非表示のチェックと ↑↓ の並び替えリスト（メイン画面とスタンバイで共用）
// cfg は { order, hidden } を持つ設定オブジェクト
function renderOrderList(list, cfg, labels, onShow) {
  list.replaceChildren(...cfg.order.map((id, i) => {
    const li = document.createElement('li');
    li.className = 'sec-item';
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !cfg.hidden.includes(id);
    cb.addEventListener('change', () => {
      cfg.hidden = cb.checked ? cfg.hidden.filter((h) => h !== id) : [...cfg.hidden, id];
      saveSettings();
      if (cb.checked) onShow?.(id);
    });
    label.append(cb, labels[id]);
    const up = document.createElement('button');
    up.textContent = '↑';
    up.setAttribute('aria-label', labels[id] + 'を上へ');
    up.disabled = i === 0;
    up.addEventListener('click', () => moveItem(cfg, i, -1));
    const down = document.createElement('button');
    down.textContent = '↓';
    down.setAttribute('aria-label', labels[id] + 'を下へ');
    down.disabled = i === cfg.order.length - 1;
    down.addEventListener('click', () => moveItem(cfg, i, 1));
    li.append(label, up, down);
    return li;
  }));
}

function renderSettingsSheet() {
  renderOrderList($('section-list'), settings, SECTION_LABELS, (id) => { if (id === 'stats') loadStats(); });
  renderOrderList($('sb-section-list'), settings.sb, SB_LABELS);

  document.querySelectorAll('.seg[data-key]').forEach((seg) => {
    seg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', String(getSetting(seg.dataset.key)) === b.dataset.value);
    });
  });

  const sw = $('swatches');
  const custom = !ACCENTS.includes(settings.accent);
  sw.replaceChildren(...ACCENTS.map((c) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (c === settings.accent ? ' on' : '');
    b.style.background = c;
    b.setAttribute('aria-label', 'アクセントカラー ' + c);
    b.addEventListener('click', () => { settings.accent = c; saveSettings(); });
    return b;
  }));
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.value = settings.accent;
  picker.title = '好きな色を選ぶ';
  if (custom) picker.className = 'on';
  picker.addEventListener('change', () => { settings.accent = picker.value; saveSettings(); });
  sw.append(picker);
}

function moveItem(cfg, i, dir) {
  const order = [...cfg.order];
  [order[i], order[i + dir]] = [order[i + dir], order[i]];
  cfg.order = order;
  saveSettings();
}

// 背景「ジャケット色」「オーロラ」、スタンバイ、まとめカード用にジャケットの色を取る
// --art-color：全体の平均を暗くしたもの / --c1〜3：部分ごとの色を鮮やかにしたもの
const artColorCache = new Map();

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > .5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function vivid([r, g, b]) {
  const [h, s] = rgbToHsl(r, g, b);
  return `hsl(${Math.round(h)} ${Math.round(Math.max(s, .55) * 100)}% 55%)`;
}

function averageColor(px, x0, y0, x1, y1, size) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * size + x) * 4;
      r += px[i]; g += px[i + 1]; b += px[i + 2]; n++;
    }
  }
  return [r / n, g / n, b / n];
}

function updateArtColor() {
  const url = $('art').getAttribute('src');
  if (!url) return;
  const apply = (c) => {
    const st = document.documentElement.style;
    Object.entries(c).forEach(([k, v]) => st.setProperty(k, v));
  };
  if (artColorCache.has(url)) { apply(artColorCache.get(url)); return; }
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const S = 16;
      const cv = document.createElement('canvas');
      cv.width = cv.height = S;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, S, S);
      const px = ctx.getImageData(0, 0, S, S).data;
      const [r, g, b] = averageColor(px, 0, 0, S, S, S);
      const c = {
        // 白い文字が読めるように暗めにする
        '--art-color': `rgb(${Math.round(r * .6)}, ${Math.round(g * .6)}, ${Math.round(b * .6)})`,
        '--c1': vivid(averageColor(px, 0, 0, S / 2, S / 2, S)),
        '--c2': vivid(averageColor(px, S / 2, 0, S, S / 2, S)),
        '--c3': vivid(averageColor(px, 0, S / 2, S, S, S)),
      };
      artColorCache.set(url, c);
      if ($('art').getAttribute('src') === url) apply(c);
    } catch {
      // 画像の読み取りが許可されない場合は色を変えない
    }
  };
  img.src = url;
}

// ===== 状態 =====
let lastQueue = [];
let lastStats = null; // まとめカード用に、最後に集計した今日の再生履歴を覚えておく
let lastStatsAt = 0;
let likedUri = null;  // いいね状態を確認済みの曲
let liked = false;
let state = null;          // GET /me/player の結果
let stateAt = 0;           // state を受け取った時刻（進行中の位置を補間するため）
let lastTrackId = null;
let lastQueueAt = 0;
let seeking = false;
let volumeDragging = false;
let suppressPollUntil = 0; // 操作直後は古い状態で表示が戻らないようにする

// ===== 画面描画 =====
function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function setRangeFill(el) {
  const p = (el.value - el.min) / (el.max - el.min) * 100;
  el.style.setProperty('--p', p + '%');
}

function imageOf(item, size = 'large') {
  const imgs = item?.album?.images || item?.images || item?.show?.images || [];
  if (!imgs.length) return '';
  // images は大きい順に並んでいる
  return size === 'small' ? imgs[imgs.length - 1].url : imgs[0].url;
}

function artistOf(item) {
  if (!item) return '';
  if (item.artists) return item.artists.map((a) => a.name).join(', ');
  return item.show?.name || '';
}

function currentPosition() {
  if (!state) return 0;
  const dur = state.item?.duration_ms || 0;
  const pos = state.progress_ms + (state.is_playing ? Date.now() - stateAt : 0);
  return Math.min(pos, dur);
}

function render() {
  const item = state?.item;
  const device = state?.device;

  $('device-name').textContent = device ? device.name : 'デバイスなし';
  $('device-dot').classList.toggle('on', !!state?.is_playing);

  $('title').textContent = item?.name || (state ? '（広告または不明な項目）' : '再生していません');
  $('artist').textContent = artistOf(item) || (state ? '' : 'Spotify アプリで何か再生するか、右上からデバイスを選んでください');
  const art = imageOf(item);
  if (art && $('art').getAttribute('src') !== art) {
    $('art').src = art;
    updateArtColor();
  }
  if (!art) $('art').removeAttribute('src');
  document.documentElement.classList.toggle('is-playing', !!state?.is_playing);
  if ((item?.uri || null) !== likedUri) checkLiked(item);

  // SVG要素には hidden プロパティが無いので属性で切り替える
  $('icon-play').toggleAttribute('hidden', !!state?.is_playing);
  $('icon-pause').toggleAttribute('hidden', !state?.is_playing);
  $('shuffle-btn').classList.toggle('on', !!state?.shuffle_state);
  const rep = state?.repeat_state || 'off';
  $('repeat-btn').classList.toggle('on', rep !== 'off');
  $('repeat-one').hidden = rep !== 'track';

  const controlsOn = !!device;
  ['play-btn', 'prev-btn', 'next-btn', 'shuffle-btn', 'repeat-btn', 'seek'].forEach((id) => {
    $(id).disabled = !controlsOn;
  });

  const volOk = !!device?.supports_volume && device.volume_percent != null;
  $('volume').disabled = !volOk;
  $('vol-note').hidden = !device || volOk;
  if (volOk && !volumeDragging) {
    $('volume').value = device.volume_percent;
    $('vol-val').textContent = device.volume_percent;
  }
  if (!volOk) $('vol-val').textContent = '–';
  setRangeFill($('volume'));

  renderProgress();
}

function renderProgress() {
  const dur = state?.item?.duration_ms || 0;
  $('dur').textContent = fmt(dur);
  if (seeking) return;
  const pos = currentPosition();
  $('pos').textContent = fmt(pos);
  $('seek').value = dur ? Math.round(pos / dur * 1000) : 0;
  setRangeFill($('seek'));
}

function trackRow(item, { side = '', sub, onClick, active = false } = {}) {
  const li = document.createElement('li');
  const el = document.createElement(onClick ? 'button' : 'div');
  el.className = 'row' + (active ? ' active' : '');
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  const src = imageOf(item, 'small');
  if (src) img.src = src;
  const txt = document.createElement('div');
  txt.className = 'txt';
  const t = document.createElement('div');
  t.className = 't';
  t.textContent = item.name;
  const a = document.createElement('div');
  a.className = 'a';
  a.textContent = sub ?? artistOf(item);
  txt.append(t, a);
  el.append(img, txt);
  if (side) {
    const s = document.createElement('div');
    s.className = 'side';
    s.textContent = side;
    el.append(s);
  }
  if (onClick) el.addEventListener('click', onClick);
  li.append(el);
  return li;
}

function clock(t) {
  return new Date(t).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

// 再生中なら、各曲が流れ始める時刻を出す（一時停止中は曲の長さ）
function renderQueue(items) {
  lastQueue = items;
  const playing = !!state?.is_playing && !!state.item;
  let t = playing ? Date.now() + (state.item.duration_ms - currentPosition()) : 0;
  const shown = items.slice(0, settings.queueCount);
  $('queue-list').replaceChildren(...shown.map((it, i) => {
    const row = trackRow(it, {
      side: playing ? clock(t) : fmt(it.duration_ms || 0),
      onClick: () => openTrackSheet(it, i),
    });
    t += it.duration_ms || 0;
    return row;
  }));
  $('queue-empty').hidden = items.length > 0;
  $('queue-end').textContent = playing && shown.length ? `· ${clock(t)} まで` : '';
}

function fmtLong(ms) {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60}分` : `${m}分`;
}

function renderStats({ ms, count, top, capped }) {
  $('stat-time').textContent = fmtLong(ms);
  $('stat-count').textContent = count;
  $('stat-top').hidden = !top;
  if (top) $('stat-top').textContent = `よく聞いたアーティスト：${top.name}（${top.n}曲）`;
  $('stat-note').hidden = !capped;
  $('stat-note').textContent = 'アプリを開いていない間に50曲以上聞いたため、その間の一部が数えられていない可能性があります。';
}

// ===== 通知 =====
let toastTimer;
function toast(msg) {
  $('toast').textContent = msg;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3000);
}

function notice(msg) {
  $('notice').textContent = msg || '';
  $('notice').hidden = !msg;
}

function explain(err) {
  if (err instanceof AuthError) { logout(); return ''; }
  if (err.status === 404) return '再生中のデバイスが見つかりません。Spotify アプリを開いてから、右上でデバイスを選んでください。';
  if (err.status === 403) {
    if (err.reason === 'PREMIUM_REQUIRED') return 'この操作には Spotify Premium が必要です。';
    if (err.reason === 'VOLUME_CONTROL_DISALLOW') return 'このデバイスはアプリからの音量変更に対応していません。';
    return '今はこの操作ができません（' + (err.reason || err.message) + '）。';
  }
  return err.message || '通信エラー';
}

// ===== 取得 =====
async function pollState() {
  if (document.hidden || Date.now() < suppressPollUntil) return;
  try {
    const s = await api('GET', '/me/player?additional_types=episode');
    state = s;
    stateAt = Date.now();
    notice('');
    render();
    const id = s?.item?.id || null;
    const changed = id !== lastTrackId;
    if (changed || Date.now() - lastQueueAt > QUEUE_POLL_MS) {
      lastTrackId = id;
      loadQueue();
    }
    if (changed || Date.now() - lastStatsAt > STATS_POLL_MS) loadStats();
  } catch (err) {
    const msg = explain(err);
    if (msg) notice(msg);
  }
}

async function loadQueue() {
  lastQueueAt = Date.now();
  if (!state) { renderQueue([]); return; }
  try {
    const q = await api('GET', '/me/player/queue');
    renderQueue((q?.queue || []).slice(0, 20));
  } catch {
    // キューの取得失敗は致命的ではないので黙って次の機会に回す
  }
}

// 今日聞いた時間：今日0時以降に聞き終えた曲の長さの合計
// （recently-played は「30秒以上聞いた曲」を直近50曲までしか返さないので、端末に貯めた記録から数える）
async function loadStats() {
  if (settings.hidden.includes('stats')) return;
  lastStatsAt = Date.now();
  const allowed = hasScope('user-read-recently-played');
  $('relogin-btn').hidden = allowed;
  if (!allowed) {
    $('stat-note').hidden = false;
    $('stat-note').textContent = 'この機能を使うには、再生履歴を読む許可が必要です。';
    return;
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  try {
    // after を付けると「古い方から50曲」になることがあるので、付けずに最新50曲を取る
    const data = await api('GET', '/me/player/recently-played?limit=50');
    const { gap } = await mergeHistory(data?.items || [], today);
    const items = playsBetween(today.getTime());
    let ms = items.reduce((sum, it) => sum + (it.track?.duration_ms || 0), 0);
    // 再生中の曲はまだ履歴に入っていないので、聞いた分だけ足す
    if (state?.item?.type === 'track') ms += currentPosition();
    const counts = new Map();
    items.forEach((it) => (it.track?.artists || []).slice(0, 1).forEach((a) => {
      counts.set(a.name, (counts.get(a.name) || 0) + 1);
    }));
    let top = null;
    counts.forEach((n, name) => { if (!top || n > top.n) top = { name, n }; });
    lastStats = { ms, items, top: top && top.n > 1 ? top : null, capped: gap };
    renderStats({ ...lastStats, count: items.length });
  } catch {
    // 統計は補助的な情報なので失敗しても表示は前回のまま
  }
}

// ===== 再生履歴の記録 =====
// Spotify は直近50曲しか返さないので、受け取った履歴を端末に貯めていく。
// アプリを開いていない間に50曲以上聞くと、その間の一部は取りこぼす（gap）。
// 1年分で数MBになるので、上限の小さい localStorage ではなく IndexedDB に置く。
// 形式：{ plays: [[再生時刻ms, 曲ID], ...]（新しい順）, tracks: { 曲ID: 曲情報 } }
const HISTORY_DAYS = 365; // 規約上、無期限には持たない

let dbPromise = null;
function idb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('spotify-remote', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function kv(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}
const kvGet = (key) => kv('readonly', (s) => s.get(key));
const kvSet = (key, value) => kv('readwrite', (s) => s.put(value, key));
const kvDel = (key) => kv('readwrite', (s) => s.delete(key));

let playLog = null;

async function loadHistory() {
  if (playLog) return playLog;
  try { playLog = await kvGet('history'); } catch {}
  if (!playLog) {
    playLog = { plays: [], tracks: {} };
    // 以前の localStorage 形式（7日分）から引き継ぐ
    try {
      JSON.parse(store.get('history') || '[]').forEach((it) => addPlay(Date.parse(it.played_at), it.track));
      playLog.plays.sort((a, b) => b[0] - a[0]);
      await saveHistory();
    } catch {}
    store.del('history');
  }
  return playLog;
}

async function saveHistory() {
  try { await kvSet('history', playLog); } catch {}
}

function slimTrack(t) {
  const imgs = t.album?.images || [];
  // 画像は1つだけ残す（300px があればそれ、なければ最大のもの）
  const img = imgs[1] || imgs[0];
  return {
    id: t.id,
    uri: t.uri || 'spotify:track:' + t.id,
    name: t.name,
    artists: (t.artists || []).map((a) => ({ name: a.name })),
    duration_ms: t.duration_ms,
    album: { images: img ? [{ url: img.url }] : [] },
  };
}

function addPlay(t, track) {
  if (!track?.id || !t) return;
  playLog.plays.push([t, track.id]);
  playLog.tracks[track.id] = slimTrack(track);
}

// from〜to（ms）に再生した曲を { played_at, track } の形で返す（新しい順）
function playsBetween(from, to = Infinity) {
  if (!playLog) return [];
  return playLog.plays
    .filter(([t]) => t >= from && t < to)
    .map(([t, id]) => ({ played_at: new Date(t).toISOString(), track: playLog.tracks[id] }))
    .filter((it) => it.track);
}

// イントロクイズで流した曲は記録しない。クイズをしていた時間帯と出題した曲を覚えておき、
// その時間帯にその曲が履歴に来たら除く（28秒で止めているので通常は来ないが念のため）
const QUIZ_SESSION_KEY = 'quiz_sessions';

function quizSessions() {
  try { return JSON.parse(store.get(QUIZ_SESSION_KEY) || '[]'); } catch { return []; }
}

function startQuizSession(ids) {
  // 2日より前のものは履歴の取り込みに関係しないので捨てる
  const keep = quizSessions().filter((s) => s.from > Date.now() - 2 * 864e5);
  keep.push({ from: Date.now(), to: null, ids });
  store.set(QUIZ_SESSION_KEY, JSON.stringify(keep));
}

function endQuizSession() {
  const list = quizSessions();
  const last = list[list.length - 1];
  if (last && !last.to) last.to = Date.now();
  store.set(QUIZ_SESSION_KEY, JSON.stringify(list));
}

function isQuizPlay(t, id) {
  return quizSessions().some((s) => {
    // 途中でアプリを閉じて終わりが記録されていないときは30分続いたとみなす
    const to = s.to || s.from + 30 * 60e3;
    return t >= s.from && t <= to + 2 * 60e3 && s.ids.includes(id);
  });
}

async function mergeHistory(fetched, today) {
  const h = await loadHistory();
  const known = new Set(h.plays.map(([t]) => t));
  const overlap = fetched.some((it) => known.has(Date.parse(it.played_at)));
  let added = false;
  fetched.forEach((it) => {
    const t = Date.parse(it.played_at);
    if (it.track?.id && !known.has(t) && !isQuizPlay(t, it.track.id)) { addPlay(t, it.track); added = true; }
  });
  if (added) {
    const keepFrom = Date.now() - HISTORY_DAYS * 864e5;
    h.plays = h.plays.filter(([t]) => t >= keepFrom).sort((a, b) => b[0] - a[0]);
    // 古い再生を消して使われなくなった曲情報も消す
    const used = new Set(h.plays.map(([, id]) => id));
    Object.keys(h.tracks).forEach((id) => { if (!used.has(id)) delete h.tracks[id]; });
    await saveHistory();
  }

  // 50曲ぎっしり返ってきて、前回の記録とつながらず、しかも一番古い曲が今日なら、
  // その前に今日聞いた曲を取りこぼしている可能性がある。今日のうちは覚えておく
  const oldest = fetched.length ? Date.parse(fetched[fetched.length - 1].played_at) : 0;
  const dayKey = today.toDateString();
  if (fetched.length >= 50 && !overlap && oldest >= today.getTime()) store.set('history_gap', dayKey);
  return { gap: store.get('history_gap') === dayKey };
}

// ===== 操作 =====
async function command(method, path, body, optimistic) {
  if (optimistic) {
    optimistic();
    render();
  }
  suppressPollUntil = Date.now() + 800;
  try {
    await api(method, path, body);
  } catch (err) {
    const msg = explain(err);
    if (msg) toast(msg);
  }
  // 反映に少し時間がかかるので少し待ってから取り直す
  setTimeout(() => { suppressPollUntil = 0; pollState(); }, 600);
}

function togglePlay() {
  if (state?.is_playing) {
    command('PUT', '/me/player/pause', null, () => {
      state.progress_ms = currentPosition();
      stateAt = Date.now();
      state.is_playing = false;
    });
  } else {
    command('PUT', '/me/player/play', null, () => {
      stateAt = Date.now();
      state.is_playing = true;
    });
  }
}

function skip(dir) {
  command('POST', dir > 0 ? '/me/player/next' : '/me/player/previous').then(() => {
    setTimeout(loadQueue, 900);
  });
}

function toggleShuffle() {
  const next = !state?.shuffle_state;
  command('PUT', '/me/player/shuffle?state=' + next, null, () => { state.shuffle_state = next; })
    .then(() => setTimeout(loadQueue, 900));
}

function cycleRepeat() {
  const order = ['off', 'context', 'track'];
  const next = order[(order.indexOf(state?.repeat_state || 'off') + 1) % order.length];
  command('PUT', '/me/player/repeat?state=' + next, null, () => { state.repeat_state = next; });
}

function onSeekInput() {
  seeking = true;
  const dur = state?.item?.duration_ms || 0;
  $('pos').textContent = fmt($('seek').value / 1000 * dur);
  setRangeFill($('seek'));
}

function onSeekChange() {
  const dur = state?.item?.duration_ms || 0;
  const pos = Math.round($('seek').value / 1000 * dur);
  seeking = false;
  command('PUT', '/me/player/seek?position_ms=' + pos, null, () => {
    state.progress_ms = pos;
    stateAt = Date.now();
  });
}

let volTimer;
function onVolumeInput() {
  volumeDragging = true;
  const v = Number($('volume').value);
  $('vol-val').textContent = v;
  setRangeFill($('volume'));
  // ドラッグ中は送りすぎないよう間引く
  clearTimeout(volTimer);
  volTimer = setTimeout(() => sendVolume(v), 250);
}

function onVolumeChange() {
  clearTimeout(volTimer);
  sendVolume(Number($('volume').value));
  volumeDragging = false;
}

function sendVolume(v) {
  command('PUT', '/me/player/volume?volume_percent=' + v, null, () => {
    if (state?.device) state.device.volume_percent = v;
  });
}

// ===== デバイス =====
async function openDevices() {
  $('device-sheet').hidden = false;
  const list = $('device-list');
  list.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted small', textContent: '読み込み中…' }));
  try {
    const { devices } = await api('GET', '/me/player/devices');
    if (!devices.length) {
      list.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted small', textContent: 'デバイスが見つかりません' }));
      return;
    }
    list.replaceChildren(...devices.map((d) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.className = 'row' + (d.is_active ? ' active' : '');
      b.innerHTML = '<div class="txt"><div class="t"></div><div class="a"></div></div>';
      b.querySelector('.t').textContent = d.name;
      b.querySelector('.a').textContent = d.type + (d.is_active ? '・再生中' : '');
      b.addEventListener('click', async () => {
        $('device-sheet').hidden = true;
        await command('PUT', '/me/player', { device_ids: [d.id], play: true });
      });
      li.append(b);
      return li;
    }));
  } catch (err) {
    const msg = explain(err);
    if (msg) list.replaceChildren(Object.assign(document.createElement('li'), { className: 'error small', textContent: msg }));
  }
}

// ===== 次に再生の曲メニュー =====
// キューの並べ替え・削除は API が無いので、できるのは「そこまで飛ばす」こと
let sheetTrack = null;
let sheetIndex = 0;

function openTrackSheet(item, index) {
  sheetTrack = item;
  sheetIndex = index;
  $('track-sheet-head').replaceChildren(trackRow(item));
  $('skip-to-btn').textContent = index === 0 ? 'この曲を再生（次へ）' : `この曲までスキップ（${index + 1}曲先へ）`;
  $('track-sheet').hidden = false;
}

async function skipTo(index) {
  $('track-sheet').hidden = true;
  suppressPollUntil = Date.now() + 60000;
  toast(index === 0 ? '次の曲へ' : `${index + 1}曲先までスキップ中…`);
  try {
    // まとめて送ると順番が崩れることがあるので1回ずつ待つ
    for (let i = 0; i <= index; i++) {
      await api('POST', '/me/player/next');
      if (i < index) await new Promise((r) => setTimeout(r, 300));
    }
  } catch (err) {
    const msg = explain(err);
    if (msg) toast(msg);
  }
  suppressPollUntil = 0;
  setTimeout(() => { pollState(); loadQueue(); }, 600);
}

// ===== プレイリストに追加 =====
const PLAYLIST_SCOPE = 'playlist-modify-private';
let myPlaylists = null; // 開くたびに取り直さないよう、一度取ったら覚えておく

async function openPlaylistSheet(item) {
  if (!item?.uri) { toast('曲が再生されていません'); return; }
  $('track-sheet').hidden = true;
  $('playlist-sheet').hidden = false;
  $('playlist-target').textContent = `「${item.name}」を追加するプレイリストを選んでください`;
  const list = $('playlist-list');
  const allowed = hasScope(PLAYLIST_SCOPE);
  $('playlist-relogin').hidden = allowed;
  if (!allowed) {
    list.replaceChildren(Object.assign(document.createElement('li'), {
      className: 'muted small',
      textContent: 'プレイリストを編集する許可がまだありません。',
    }));
    return;
  }
  if (!myPlaylists) {
    list.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted small', textContent: '読み込み中…' }));
    try {
      const [me, data] = await Promise.all([api('GET', '/me'), api('GET', '/me/playlists?limit=50')]);
      // 追加できるのは自分のプレイリストと共同編集のものだけ
      myPlaylists = (data?.items || []).filter((p) => p && (p.owner?.id === me.id || p.collaborative));
    } catch (err) {
      const msg = explain(err);
      if (msg) list.replaceChildren(Object.assign(document.createElement('li'), { className: 'error small', textContent: msg }));
      return;
    }
  }
  if (!myPlaylists.length) {
    list.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted small', textContent: '自分のプレイリストがありません' }));
    return;
  }
  list.replaceChildren(...myPlaylists.map((p) => {
    const total = p.items?.total ?? p.tracks?.total;
    return trackRow(p, {
      sub: total != null ? `${total}曲` : '',
      onClick: () => addToPlaylist(p, item),
    });
  }));
}

async function addToPlaylist(playlist, item) {
  $('playlist-sheet').hidden = true;
  try {
    await api('POST', `/playlists/${playlist.id}/items`, { uris: [item.uri] });
    toast(`「${playlist.name}」に追加しました`);
    myPlaylists = null; // 曲数が変わったので次回は取り直す
  } catch (err) {
    const msg = explain(err);
    if (msg) toast(msg);
  }
}

// ===== いいね（お気に入りの曲） =====
const HEART_OUTLINE = $('like-path').getAttribute('d');
const HEART_FILLED = 'M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.1 0 3.6 1.1 5.3 3 1.7-1.9 3.2-3 5.3-3 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21Z';

function renderLike() {
  $('like-path').setAttribute('d', liked ? HEART_FILLED : HEART_OUTLINE);
  $('like-btn').classList.toggle('like-on', liked);
  $('like-btn').setAttribute('aria-pressed', String(liked));
}

async function checkLiked(item) {
  likedUri = item?.uri || null;
  liked = false;
  renderLike();
  if (!likedUri || !hasScope('user-library-read')) return;
  try {
    const data = await api('GET', '/me/library/contains?uris=' + encodeURIComponent(likedUri));
    if (likedUri !== item.uri) return; // 確認中に曲が変わった
    liked = Array.isArray(data) && data[0] === true;
    renderLike();
  } catch {
    // 状態が分からなくても操作はできるので黙っておく
  }
}

async function setLiked(on) {
  const uri = state?.item?.uri;
  if (!uri) return;
  if (!hasScope('user-library-modify')) {
    toast('いいねを使うには、ログインし直してください');
    $('scope-bar').hidden = false;
    return;
  }
  liked = on;
  renderLike();
  try {
    await api(on ? 'PUT' : 'DELETE', '/me/library?uris=' + encodeURIComponent(uri));
    toast(on ? 'お気に入りに追加しました' : 'お気に入りから外しました');
  } catch (err) {
    liked = !on;
    renderLike();
    const msg = explain(err);
    if (msg) toast(msg);
  }
}

function burstHeart() {
  const b = $('burst');
  b.classList.remove('pop');
  void b.offsetWidth; // アニメーションを最初からやり直すため
  b.classList.add('pop');
}

// ===== ジャケットのスワイプ・ダブルタップ =====
// 左へスワイプ＝次の曲、右へ＝前の曲、ダブルタップ＝いいね
function bindArtGestures() {
  const wrap = $('disc-wrap');
  let sx = 0, sy = 0, dx = 0, dragging = false, horizontal = null, lastTap = 0;

  wrap.addEventListener('pointerdown', (e) => {
    sx = e.clientX; sy = e.clientY; dx = 0;
    dragging = true; horizontal = null;
    wrap.style.transition = 'none';
    // 指が枠の外に出ても最後まで追えるようにする
    try { wrap.setPointerCapture(e.pointerId); } catch {}
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const mx = e.clientX - sx, my = e.clientY - sy;
    if (horizontal === null && Math.hypot(mx, my) > 8) horizontal = Math.abs(mx) > Math.abs(my);
    if (!horizontal) return;
    dx = mx;
    wrap.style.transform = `translateX(${dx}px) rotate(${dx / 25}deg)`;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (horizontal && Math.abs(dx) > 70 && state?.device) {
      flyAway(dx < 0 ? 1 : -1);
      skip(dx < 0 ? 1 : -1);
      return;
    }
    wrap.style.transition = 'transform .25s ease-out';
    wrap.style.transform = '';
    if (!horizontal) {
      const now = Date.now();
      if (now - lastTap < 320) {
        lastTap = 0;
        burstHeart();
        if (!liked) setLiked(true);
      } else {
        lastTap = now;
      }
    }
  };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);
}

// 次へなら左へ飛んで右から戻ってくる（前へはその逆）
function flyAway(dir) {
  const wrap = $('disc-wrap');
  wrap.style.transition = 'transform .22s ease-in, opacity .22s';
  wrap.style.transform = `translateX(${-dir * 130}%) rotate(${-dir * 12}deg)`;
  wrap.style.opacity = '0';
  setTimeout(() => {
    wrap.style.transition = 'none';
    wrap.style.transform = `translateX(${dir * 60}%)`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      wrap.style.transition = 'transform .3s ease-out, opacity .3s';
      wrap.style.transform = '';
      wrap.style.opacity = '';
    }));
  }, 240);
}

// ===== スタンバイ（時計）モード =====
// 充電中に机に置いておく用。画面が消えないように Wake Lock を取る
let standbyTimer = null;
let wakeLock = null;

async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
}

const landscapeMq = matchMedia('(orientation: landscape)');

// 設定に合わせて見た目と配置を決める。横向きで左右に分けるときは
// 時計と日付を片側、それ以外をもう片側に置き、それぞれの中は設定の並び順
function applyStandby() {
  const sb = settings.sb;
  const el = $('standby');
  el.dataset.size = sb.size;
  el.dataset.weight = sb.weight;
  el.dataset.bg = sb.bg;

  const split = landscapeMq.matches && sb.landscape !== 'stack';
  el.classList.toggle('split', split);
  const a = $('sb-col-a'), b = $('sb-col-b');
  const clockCol = split && sb.landscape === 'right' ? b : a;
  const otherCol = clockCol === a ? b : a;
  sb.order.forEach((id) => {
    const block = el.querySelector(`[data-sb="${id}"]`);
    if (sb.hidden.includes(id)) $('sb-blocks').append(block);
    else if (!split) a.append(block);
    else (id === 'clock' || id === 'date' ? clockCol : otherCol).append(block);
  });
  renderStandby();
}

function isNight(now) {
  const n = settings.sb.night;
  return n === 'on' || (n === 'auto' && (now.getHours() >= 22 || now.getHours() < 6));
}

function renderStandby() {
  const sb = settings.sb;
  const now = new Date();
  $('standby').classList.toggle('night', isNight(now));

  const h = now.getHours();
  const hh = sb.hour12 ? String(h % 12 || 12) : String(h).padStart(2, '0');
  $('sb-time').textContent = `${hh}:${String(now.getMinutes()).padStart(2, '0')}`;
  $('sb-ampm').textContent = sb.hour12 ? (h < 12 ? '午前' : '午後') : '';
  $('sb-sec').textContent = sb.seconds ? String(now.getSeconds()).padStart(2, '0') : '';
  $('sb-date').textContent = now.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });

  const item = state?.item;
  $('sb-title').textContent = item?.name || '再生していません';
  $('sb-artist').textContent = artistOf(item);
  const art = imageOf(item, 'large');
  if (art && $('sb-art').getAttribute('src') !== art) {
    $('sb-art').src = art;
    $('sb-bg').src = art;
  }
  $('sb-art').hidden = !art;
  const dur = item?.duration_ms || 0;
  $('sb-fill').style.width = dur ? (currentPosition() / dur * 100) + '%' : '0';

  const next = lastQueue[0];
  $('sb-next').textContent = next ? `${next.name} — ${artistOf(next)}` : 'キューは空です';
  $('sb-today').textContent = lastStats ? `${fmtLong(lastStats.ms)} · ${lastStats.items.length}曲` : '–';
}

function openStandby() {
  $('settings-sheet').hidden = true;
  $('standby').hidden = false;
  applyStandby();
  standbyTimer = setInterval(renderStandby, 1000);
  keepAwake();
}

function closeStandby() {
  $('standby').hidden = true;
  clearInterval(standbyTimer);
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// ===== 今日のまとめカード =====
// 1080×1350 の画像を canvas で描いて、iPhone の共有シートで保存・共有できるようにする
function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // 読み取り許可のない画像は使わない（canvas が保存できなくなるため）
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
    setTimeout(() => resolve(null), 5000);
  });
}

function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
  return t + '…';
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

let cardBlob = null;

async function makeCard() {
  if (!lastStats) { toast('今日の再生履歴を読み込み中です'); loadStats(); return; }
  toast('カードを作っています…');
  const { ms, items, top } = lastStats;
  const W = 1080, H = 1350, P = 80;
  const FONT = '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic UI", sans-serif';
  const css = getComputedStyle(document.documentElement);
  const c1 = css.getPropertyValue('--c1').trim() || settings.accent;
  const c2 = css.getPropertyValue('--c2').trim() || '#3d91f4';

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  // 背景：黒地にジャケット色の光
  ctx.fillStyle = '#0b0b0e';
  ctx.fillRect(0, 0, W, H);
  [[c1, 150, 200, 700], [c2, 980, 1150, 750]].forEach(([c, x, y, r]) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, c);
    g.addColorStop(1, 'transparent');
    ctx.globalAlpha = .55;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  });
  ctx.globalAlpha = 1;

  ctx.fillStyle = '#fff';
  ctx.font = `700 34px ${FONT}`;
  ctx.fillText("TODAY'S SOUNDTRACK", P, 130);
  ctx.globalAlpha = .7;
  ctx.font = `400 32px ${FONT}`;
  ctx.fillText(new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }), P, 180);
  ctx.globalAlpha = 1;

  ctx.font = `800 150px ${FONT}`;
  ctx.fillText(fmtLong(ms), P, 360);
  ctx.font = `500 40px ${FONT}`;
  ctx.globalAlpha = .85;
  ctx.fillText(fitText(ctx, `${items.length}曲${top ? `　よく聞いた：${top.name}` : ''}`, W - P * 2), P, 430);
  ctx.globalAlpha = 1;

  // ジャケットのタイル（同じアルバムは1回だけ）
  const urls = [...new Set(items.map((it) => imageOf(it.track)).filter(Boolean))].slice(0, 8);
  const imgs = (await Promise.all(urls.map(loadImage))).filter(Boolean);
  const tile = (W - P * 2 - 3 * 24) / 4;
  imgs.forEach((img, i) => {
    const x = P + (i % 4) * (tile + 24);
    const y = 480 + Math.floor(i / 4) * (tile + 24);
    ctx.save();
    roundRect(ctx, x, y, tile, tile, 18);
    ctx.clip();
    ctx.drawImage(img, x, y, tile, tile);
    ctx.restore();
  });

  // よく聞いた曲ベスト3（同数なら新しい順）
  const counts = new Map();
  items.forEach((it) => {
    const k = it.track?.id;
    if (!k) return;
    const c = counts.get(k) || { track: it.track, n: 0 };
    c.n++;
    counts.set(k, c);
  });
  const best = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 3);
  const rows = Math.ceil(imgs.length / 4);
  let y = 480 + rows * (tile + 24) + 56;
  ctx.font = `700 34px ${FONT}`;
  ctx.fillText('よく聞いた曲', P, y);
  y += 10;
  best.forEach((b, i) => {
    y += 62;
    ctx.font = `800 40px ${FONT}`;
    ctx.fillStyle = c1;
    ctx.fillText(String(i + 1), P, y);
    ctx.fillStyle = '#fff';
    ctx.font = `600 38px ${FONT}`;
    const name = `${b.track.name} — ${artistOf(b.track)}`;
    ctx.fillText(fitText(ctx, name, W - P * 2 - 150), P + 56, y);
    ctx.globalAlpha = .6;
    ctx.font = `400 32px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText(`${b.n}回`, W - P, y);
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
  });

  ctx.globalAlpha = .4;
  ctx.font = `500 28px ${FONT}`;
  ctx.fillText('Spotify Remote', P, H - 56);
  ctx.globalAlpha = 1;

  cardBlob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  if (!cardBlob) { toast('画像を作れませんでした'); return; }
  const url = URL.createObjectURL(cardBlob);
  $('card-img').src = url;
  $('card-download').href = url;
  const file = new File([cardBlob], 'today.png', { type: 'image/png' });
  $('card-share').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
  $('card-sheet').hidden = false;
  $('toast').hidden = true;
}

async function shareCard() {
  if (!cardBlob) return;
  const file = new File([cardBlob], 'today.png', { type: 'image/png' });
  try {
    await navigator.share({ files: [file] });
  } catch {
    // キャンセルされた場合は何もしない
  }
}

// ===== 検索してキューに追加 =====
async function search(e) {
  e.preventDefault();
  const q = $('search-input').value.trim();
  if (!q) return;
  $('search-input').blur();
  const list = $('search-list');
  try {
    const data = await api('GET', '/search?type=track&limit=10&q=' + encodeURIComponent(q));
    const items = data?.tracks?.items || [];
    list.replaceChildren(...items.map((it) => trackRow(it, {
      side: '＋',
      onClick: async () => {
        try {
          await api('POST', '/me/player/queue?uri=' + encodeURIComponent(it.uri));
          toast('キューに追加：' + it.name);
          setTimeout(loadQueue, 500);
        } catch (err) {
          const msg = explain(err);
          if (msg) toast(msg);
        }
      },
    })));
    if (!items.length) list.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted small', textContent: '見つかりませんでした' }));
  } catch (err) {
    const msg = explain(err);
    if (msg) toast(msg);
  }
}

// ===== 起動 =====
function showSetupError(msg) {
  $('setup-error').textContent = msg;
  $('setup-error').hidden = !msg;
}

function showSetup() {
  $('setup').hidden = false;
  $('player').hidden = true;
  $('client-id').value = store.get('client_id') || '';
  $('redirect-uri').textContent = redirectUri();
}

function showPlayer() {
  $('setup').hidden = true;
  $('player').hidden = false;
  // 機能追加で必要な許可が増えたときは、ログインし直しを促す
  $('scope-bar').hidden = SCOPES.split(' ').every(hasScope);
  render();
  pollState();
  setInterval(pollState, POLL_MS);
  setInterval(renderProgress, 500);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    pollState();
    // 画面を戻したとき Wake Lock は外れているので取り直す
    if (!$('standby').hidden) keepAwake();
  });
}

function bind() {
  $('login-btn').addEventListener('click', () => login());
  $('relogin-btn').addEventListener('click', () => login(store.get('client_id')));
  $('settings-btn').addEventListener('click', () => { $('settings-sheet').hidden = false; });
  $('customize-link').addEventListener('click', () => { $('settings-sheet').hidden = false; });
  $('add-playlist-btn').addEventListener('click', () => openPlaylistSheet(state?.item));
  $('track-playlist-btn').addEventListener('click', () => openPlaylistSheet(sheetTrack));
  $('skip-to-btn').addEventListener('click', () => skipTo(sheetIndex));
  $('playlist-relogin').addEventListener('click', () => login(store.get('client_id')));
  $('scope-relogin').addEventListener('click', () => login(store.get('client_id')));
  $('like-btn').addEventListener('click', () => setLiked(!liked));
  $('standby-btn').addEventListener('click', openStandby);
  $('sb-preview').addEventListener('click', openStandby);
  landscapeMq.addEventListener('change', applyStandby);
  $('standby').addEventListener('click', closeStandby);
  $('card-btn').addEventListener('click', makeCard);
  $('card-share').addEventListener('click', shareCard);
  bindArtGestures();
  document.querySelectorAll('.seg[data-key]').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      setSetting(seg.dataset.key, b.dataset.value);
      saveSettings();
    });
  });
  $('reset-settings').addEventListener('click', () => {
    store.del('settings');
    settings = loadSettings();
    saveSettings();
  });
  $('logout-btn').addEventListener('click', logout);
  $('play-btn').addEventListener('click', togglePlay);
  $('prev-btn').addEventListener('click', () => skip(-1));
  $('next-btn').addEventListener('click', () => skip(1));
  $('shuffle-btn').addEventListener('click', toggleShuffle);
  $('repeat-btn').addEventListener('click', cycleRepeat);
  $('seek').addEventListener('input', onSeekInput);
  $('seek').addEventListener('change', onSeekChange);
  $('volume').addEventListener('input', onVolumeInput);
  $('volume').addEventListener('change', onVolumeChange);
  $('device-btn').addEventListener('click', openDevices);
  $('search-btn').addEventListener('click', () => {
    $('search-sheet').hidden = false;
    $('search-input').focus();
  });
  $('search-form').addEventListener('submit', search);
  document.querySelectorAll('.sheet').forEach((sheet) => {
    sheet.addEventListener('click', (e) => {
      if (e.target === sheet || e.target.classList.contains('close-sheet')) sheet.hidden = true;
    });
  });
}

(async function main() {
  bind();
  applySettings();
  try {
    await handleCallback();
  } catch (err) {
    showSetup();
    showSetupError(err.message);
    return;
  }
  if (store.get('refresh_token')) showPlayer();
  else showSetup();
})();
