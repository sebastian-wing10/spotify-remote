'use strict';

// 振り返り・Spotify公式ランキング・イントロクイズ
// app.js の関数や状態（api, state, playsBetween など）をそのまま使う

const DAY = 864e5;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 選択肢ボタン群（設定に紐づかない .seg）
function choiceSeg(options, current, onPick) {
  const seg = el('div', 'seg');
  options.forEach(([value, label]) => {
    const b = el('button', value === current ? 'on' : '', label);
    b.addEventListener('click', () => onPick(value));
    seg.append(b);
  });
  return seg;
}

// ===== 振り返り =====
let reportTab = 'week';

async function openReport(tab = reportTab) {
  reportTab = tab;
  $('report-sheet').hidden = false;
  $('report-tabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  const body = $('report-body');
  body.replaceChildren(el('p', 'muted small', '読み込み中…'));
  if (tab === 'top') { renderTop(body); return; }
  await loadHistory();
  renderPeriod(body, tab === 'week' ? 7 : 30);
}

function sumMs(list) {
  return list.reduce((s, it) => s + (it.track.duration_ms || 0), 0);
}

// 連続記録：今日（まだ聞いていなければ昨日）からさかのぼって、毎日聞いている日数
function streaks() {
  const days = new Set(playLog.plays.map(([t]) => startOfDay(t)));
  let d = startOfDay(Date.now());
  if (!days.has(d)) d -= DAY;
  let current = 0;
  while (days.has(d)) { current++; d -= DAY; }
  let longest = 0, run = 0, prev = null;
  [...days].sort((a, b) => a - b).forEach((day) => {
    // 夏時間のある地域でもずれないよう、ほぼ1日差なら連続とみなす
    run = prev != null && Math.abs(day - prev - DAY) < 3 * 3600e3 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = day;
  });
  return { current, longest };
}

function statCard(label, value, sub) {
  const c = el('div', 'stat-card');
  c.append(el('div', 'muted small', label), el('div', 'big', value));
  if (sub) c.append(el('div', 'muted small', sub));
  return c;
}

// 棒グラフ：values は数値、labels は下に出す文字（空なら出さない）
function barChart(values, labels, { highlight = -1, format = String, showValues = false } = {}) {
  const max = Math.max(...values, 1);
  const chart = el('div', 'chart');
  values.forEach((v, i) => {
    const col = el('div', 'bar-col' + (i === highlight ? ' hl' : ''));
    col.title = `${labels[i] || ''} ${format(v)}`;
    if (showValues) col.append(el('div', 'bar-val', v ? format(v) : ''));
    const bar = el('div', 'bar');
    bar.style.height = Math.max(v / max * 100, v ? 3 : 0) + '%';
    col.append(bar, el('div', 'bar-label', labels[i] || ''));
    chart.append(col);
  });
  return chart;
}

function topCounts(plays, keyOf) {
  const m = new Map();
  plays.forEach((it) => {
    const k = keyOf(it);
    if (!k) return;
    const c = m.get(k.id) || { ...k, n: 0 };
    c.n++;
    m.set(k.id, c);
  });
  return [...m.values()].sort((a, b) => b.n - a.n);
}

function renderPeriod(body, days) {
  const todayStart = startOfDay(Date.now());
  const from = todayStart - (days - 1) * DAY;
  const plays = playsBetween(from);
  const prev = playsBetween(from - days * DAY, from);
  const ms = sumMs(plays);
  const prevMs = sumMs(prev);
  const parts = [];

  if (!playLog.plays.length) {
    body.replaceChildren(el('p', 'muted', 'まだ記録がありません。アプリを開いて音楽を聞くと、ここに貯まっていきます。'));
    return;
  }

  // 概要
  const diff = prevMs ? Math.round((ms - prevMs) / prevMs * 100) : null;
  const { current, longest } = streaks();
  const cards = el('div', 'stat-grid');
  cards.append(
    statCard('合計', fmtLong(ms), diff == null ? '' : `前の${days}日より ${diff >= 0 ? '+' : ''}${diff}%`),
    statCard('曲数', `${plays.length}曲`, `1日平均 ${fmtLong(ms / days)}`),
    statCard('連続記録', `${current}日`, `最長 ${longest}日`),
  );
  parts.push(cards);

  // 日ごと
  const perDay = Array.from({ length: days }, (_, i) => {
    const s = from + i * DAY;
    return sumMs(plays.filter((it) => { const t = Date.parse(it.played_at); return t >= s && t < s + DAY; }));
  });
  const dayLabels = perDay.map((_, i) => {
    const d = new Date(from + i * DAY);
    if (days <= 7) return WEEKDAYS[d.getDay()];
    return i % 5 === 0 || i === days - 1 ? String(d.getDate()) : '';
  });
  parts.push(el('h3', '', '日ごとの再生時間'));
  parts.push(barChart(perDay.map((v) => Math.round(v / 60000)), dayLabels, {
    highlight: days - 1,
    format: (m) => m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? m % 60 : ''}` : `${m}分`,
    showValues: days <= 7,
  }));

  // 時間帯
  const perHour = Array(24).fill(0);
  plays.forEach((it) => { perHour[new Date(it.played_at).getHours()]++; });
  const peak = perHour.indexOf(Math.max(...perHour));
  parts.push(el('h3', '', '聞いている時間帯'));
  if (plays.length) parts.push(el('p', 'muted small', `いちばん多いのは ${peak}時台（${perHour[peak]}曲）`));
  parts.push(barChart(perHour, perHour.map((_, h) => (h % 6 === 0 ? `${h}時` : '')), {
    highlight: plays.length ? peak : -1,
    format: (n) => `${n}曲`,
  }));

  // ランキング
  const artists = topCounts(plays, (it) => it.track.artists?.[0] && { id: it.track.artists[0].name, name: it.track.artists[0].name }).slice(0, 5);
  const tracks = topCounts(plays, (it) => ({ id: it.track.id, track: it.track })).slice(0, 5);
  if (artists.length) {
    parts.push(el('h3', '', 'よく聞いたアーティスト'));
    const ol = el('ol', 'rank-list');
    artists.forEach((a, i) => {
      const li = el('li', 'rank-row');
      li.append(el('span', 'rank-no', String(i + 1)), el('span', 'rank-name', a.name), el('span', 'muted small', `${a.n}曲`));
      ol.append(li);
    });
    parts.push(ol);
  }
  if (tracks.length) {
    parts.push(el('h3', '', 'よく聞いた曲'));
    const ol = el('ol', '');
    tracks.forEach((t) => ol.append(trackRow(t.track, { side: `${t.n}回` })));
    parts.push(ol);
  }

  // 記録の状態
  const oldest = playLog.plays[playLog.plays.length - 1][0];
  const kb = Math.round(new Blob([JSON.stringify(playLog)]).size / 1024);
  parts.push(el('p', 'muted small report-note',
    `記録：${playLog.plays.length}曲・約${kb}KB（${new Date(oldest).toLocaleDateString('ja-JP')}から）。` +
    '記録はこの端末だけに保存され、1年たったものから消えます。再生時間は曲の長さで数えています。'));

  body.replaceChildren(...parts);
}

// ===== Spotify 公式ランキング =====
let topRange = 'short_term';
let topType = 'tracks';
const topCache = new Map();

async function renderTop(body) {
  if (!hasScope('user-top-read')) {
    const btn = el('button', 'primary', 'ログインし直して使えるようにする');
    btn.addEventListener('click', () => login(store.get('client_id')));
    body.replaceChildren(el('p', 'muted', 'ランキングを見るには、新しい許可が必要です。'), btn);
    return;
  }
  const controls = [
    choiceSeg([['short_term', '4週間'], ['medium_term', '6か月'], ['long_term', '1年']], topRange, (v) => { topRange = v; renderTop(body); }),
    choiceSeg([['tracks', '曲'], ['artists', 'アーティスト']], topType, (v) => { topType = v; renderTop(body); }),
  ];
  controls[1].classList.add('seg-gap');
  const list = el('ol', '');
  list.append(el('li', 'muted small', '読み込み中…'));
  body.replaceChildren(...controls, list);

  const key = topType + topRange;
  try {
    if (!topCache.has(key)) {
      const data = await api('GET', `/me/top/${topType}?time_range=${topRange}&limit=20`);
      topCache.set(key, data?.items || []);
    }
    const items = topCache.get(key);
    if (!items.length) {
      list.replaceChildren(el('li', 'muted small', 'まだデータがありません'));
      return;
    }
    list.replaceChildren(...items.map((it, i) => {
      const row = trackRow(it, { sub: topType === 'artists' ? '' : undefined, side: `#${i + 1}` });
      return row;
    }));
  } catch (err) {
    const msg = explain(err);
    if (msg) list.replaceChildren(el('li', 'error small', msg));
  }
}

// ===== イントロクイズ =====
const QUIZ_SECONDS = 15;
const QUIZ_COUNT = 10;
// Spotify は30秒以上流した曲を再生履歴（ランキングや年間まとめにも使われる）に入れるので、
// その前に止めてクイズの曲が記録されないようにする
const QUIZ_MAX_PLAY_MS = 28000;
let quiz = null;
let quizMode = 'intro';
let quizPlayers = 1;

function openQuiz() {
  $('quiz').hidden = false;
  $('quiz-progress').textContent = '';
  $('quiz-score').textContent = '';
  renderQuizStart();
}

function renderQuizStart(message) {
  const stage = $('quiz-stage');
  const best = Number(store.get('quiz_best') || 0);
  const start = el('button', 'primary', 'スタート');
  start.addEventListener('click', () => startQuiz());
  stage.replaceChildren(
    el('div', 'quiz-logo', '?'),
    el('h2', 'quiz-title', 'イントロクイズ'),
    el('p', 'muted', `あなたがよく聞く曲から${QUIZ_COUNT}問。曲が流れたら、${QUIZ_SECONDS}秒以内に4択から選んでください。早く答えるほど高得点です。`),
    el('div', 'label', '出題のしかた'),
    choiceSeg([['intro', 'イントロから'], ['middle', '曲の途中から']], quizMode, (v) => { quizMode = v; renderQuizStart(); }),
    el('div', 'label', '人数'),
    choiceSeg([[1, 'ひとり'], [2, 'ふたりで交互に']], quizPlayers, (v) => { quizPlayers = v; renderQuizStart(); }),
    el('p', 'muted small', 'いま再生中のデバイスで曲が流れます。iPhone で流すとロック画面などに曲名が出るので、PCやスピーカーで流すのがおすすめです。'),
    best ? el('p', 'quiz-best', `ひとりでのベスト：${best}点`) : el('span'),
    message ? el('p', 'error', message) : el('span'),
    start,
  );
}

// 出題する曲：端末に貯めた履歴 + Spotify公式の上位曲
async function buildPool() {
  const pool = new Map();
  await loadHistory();
  Object.values(playLog.tracks).forEach((t) => pool.set(t.id, t));
  if (hasScope('user-top-read')) {
    for (const range of ['short_term', 'medium_term']) {
      try {
        const data = await api('GET', `/me/top/tracks?time_range=${range}&limit=50`);
        (data?.items || []).forEach((t) => pool.set(t.id, slimTrack(t)));
      } catch {}
    }
  }
  return [...pool.values()].filter((t) => t.name && t.uri && t.duration_ms > 30000);
}

// saved：続けて遊ぶときは、最初に始めたときの再生状態を引き継ぐ
async function startQuiz(saved) {
  if (!state?.device) {
    renderQuizStart('再生中のデバイスがありません。Spotify アプリで何か再生してから始めてください。');
    return;
  }
  $('quiz-stage').replaceChildren(el('p', 'muted center', '問題を準備しています…'));
  const pool = await buildPool();
  // 選択肢が重複しないよう、曲名ごとに1曲にする
  const byName = new Map();
  pool.forEach((t) => { if (!byName.has(t.name)) byName.set(t.name, t); });
  const unique = [...byName.values()];
  if (unique.length < 4) {
    renderQuizStart('出題できる曲が足りません。もう少し音楽を聞いてから試してください。');
    return;
  }
  const questions = shuffle(unique).slice(0, QUIZ_COUNT).map((answer) => ({
    answer,
    choices: shuffle([answer, ...shuffle(unique.filter((t) => t.id !== answer.id)).slice(0, 3)]),
  }));
  startQuizSession(questions.map((q) => q.answer.id));
  quiz = {
    questions,
    i: 0,
    pauseTimer: null,
    scores: Array(quizPlayers).fill(0),
    correct: Array(quizPlayers).fill(0),
    timer: null,
    startedAt: 0,
    // 終わったら元の再生に戻すため
    saved: saved || {
      contextUri: state.context?.uri,
      itemUri: state.item?.uri,
      pos: currentPosition(),
      wasPlaying: !!state.is_playing,
    },
  };
  askQuestion();
}

function quizHeader() {
  $('quiz-progress').textContent = `${Math.min(quiz.i + 1, quiz.questions.length)} / ${quiz.questions.length}`;
  $('quiz-score').textContent = quiz.scores.length > 1
    ? quiz.scores.map((s, p) => `P${p + 1}: ${s}`).join('　')
    : `${quiz.scores[0]}点`;
}

async function askQuestion() {
  const q = quiz.questions[quiz.i];
  quizHeader();
  const player = quiz.i % quiz.scores.length;
  const stage = $('quiz-stage');
  stage.replaceChildren(el('p', 'muted center', '曲を準備しています…'));

  const dur = q.answer.duration_ms;
  const pos = quizMode === 'intro' ? 0 : Math.round(dur * (0.3 + Math.random() * 0.3));
  clearTimeout(quiz.pauseTimer);
  try {
    await api('PUT', '/me/player/play', { uris: [q.answer.uri], position_ms: pos });
    quiz.pauseTimer = setTimeout(() => api('PUT', '/me/player/pause').catch(() => {}), QUIZ_MAX_PLAY_MS);
  } catch (err) {
    const msg = explain(err);
    endQuiz();
    renderQuizStart(msg || '曲を再生できませんでした');
    return;
  }

  const timerBar = el('div', 'quiz-timer');
  const fill = el('div', 'quiz-timer-fill');
  timerBar.append(fill);
  const choices = el('div', 'quiz-choices');
  q.choices.forEach((c) => {
    const b = el('button', 'quiz-choice');
    b.append(el('span', 'qc-name', c.name), el('span', 'qc-artist', artistOf(c)));
    b.addEventListener('click', () => answer(c, b));
    choices.append(b);
  });
  const parts = [el('div', 'quiz-disc spinning', '?')];
  if (quiz.scores.length > 1) parts.push(el('p', 'quiz-turn', `プレイヤー${player + 1} の番`));
  parts.push(timerBar, choices);
  stage.replaceChildren(...parts);

  quiz.startedAt = Date.now();
  requestAnimationFrame(() => {
    fill.style.transition = `width ${QUIZ_SECONDS}s linear`;
    fill.style.width = '0%';
  });
  quiz.timer = setTimeout(() => answer(null, null), QUIZ_SECONDS * 1000);
}

function answer(choice, button) {
  if (!quiz || quiz.answered === quiz.i) return;
  quiz.answered = quiz.i;
  clearTimeout(quiz.timer);
  const q = quiz.questions[quiz.i];
  const player = quiz.i % quiz.scores.length;
  const ok = choice?.id === q.answer.id;
  const left = Math.max(0, QUIZ_SECONDS - (Date.now() - quiz.startedAt) / 1000);
  const points = ok ? 100 + Math.ceil(left) * 10 : 0;
  quiz.scores[player] += points;
  if (ok) quiz.correct[player]++;

  // ボタンに正解・不正解の色を付ける
  $('quiz-stage').querySelectorAll('.quiz-choice').forEach((b, i) => {
    b.disabled = true;
    if (q.choices[i].id === q.answer.id) b.classList.add('right');
  });
  if (button && !ok) button.classList.add('wrong');
  quizHeader();

  const reveal = el('div', 'quiz-reveal');
  const img = el('img', 'quiz-art');
  const src = imageOf(q.answer);
  if (src) img.src = src;
  img.alt = '';
  reveal.append(
    el('div', 'quiz-verdict ' + (ok ? 'ok' : 'ng'), ok ? `正解！ +${points}` : choice ? '残念…' : '時間切れ'),
    img,
    el('div', 'qc-name', q.answer.name),
    el('div', 'qc-artist', artistOf(q.answer)),
  );
  const last = quiz.i === quiz.questions.length - 1;
  const next = el('button', 'primary', last ? '結果を見る' : '次の曲へ');
  next.addEventListener('click', () => {
    quiz.i++;
    if (last) showResult();
    else askQuestion();
  });
  // 円盤の位置に答えを出す
  $('quiz-stage').querySelector('.quiz-disc').replaceWith(reveal);
  $('quiz-stage').append(next);
}

function showResult() {
  clearTimeout(quiz.pauseTimer);
  api('PUT', '/me/player/pause').catch(() => {});
  const n = quiz.questions.length;
  const stage = $('quiz-stage');
  const parts = [el('div', 'quiz-logo', '♪')];
  if (quiz.scores.length === 1) {
    const score = quiz.scores[0];
    const best = Number(store.get('quiz_best') || 0);
    const isBest = score > best;
    if (isBest) store.set('quiz_best', String(score));
    const rate = quiz.correct[0] / n;
    const comment = rate === 1 ? 'パーフェクト！完全に聞き込んでいます'
      : rate >= .7 ? 'さすが、よく聞いています'
      : rate >= .4 ? 'なかなか！' : 'まだまだこれから';
    parts.push(
      el('h2', 'quiz-title', `${score}点`),
      el('p', '', `${n}問中 ${quiz.correct[0]}問正解　${comment}`),
      isBest ? el('p', 'quiz-best', 'ベスト更新！') : el('p', 'muted small', `ベスト：${best}点`),
    );
  } else {
    const [a, b] = quiz.scores;
    parts.push(
      el('h2', 'quiz-title', a === b ? '引き分け！' : `プレイヤー${a > b ? 1 : 2} の勝ち！`),
      el('p', '', `P1：${a}点（${quiz.correct[0]}問正解）`),
      el('p', '', `P2：${b}点（${quiz.correct[1]}問正解）`),
    );
  }
  const again = el('button', 'primary', 'もう一度');
  again.addEventListener('click', () => startQuiz(endQuiz({ keepOpen: true })));
  const done = el('button', 'secondary', '終わる（元の曲に戻る）');
  done.addEventListener('click', () => closeQuiz());
  parts.push(again, done);
  stage.replaceChildren(...parts);
}

// 元の再生に戻す。アルバムやプレイリストの途中だったらその位置から
async function restorePlayback(saved) {
  if (!saved?.itemUri) return;
  try {
    const body = saved.contextUri
      ? { context_uri: saved.contextUri, offset: { uri: saved.itemUri }, position_ms: saved.pos }
      : { uris: [saved.itemUri], position_ms: saved.pos };
    try {
      await api('PUT', '/me/player/play', body);
    } catch {
      // アーティストのページなど offset が使えない再生元では、曲だけ戻す
      await api('PUT', '/me/player/play', { uris: [saved.itemUri], position_ms: saved.pos });
    }
    if (!saved.wasPlaying) setTimeout(() => api('PUT', '/me/player/pause').catch(() => {}), 800);
  } catch {}
  setTimeout(pollState, 1000);
}

function endQuiz({ keepOpen = false } = {}) {
  if (!quiz) return null;
  clearTimeout(quiz.timer);
  clearTimeout(quiz.pauseTimer);
  endQuizSession();
  const saved = quiz.saved;
  quiz = null;
  if (!keepOpen) restorePlayback(saved);
  return saved;
}

function closeQuiz() {
  endQuiz();
  $('quiz').hidden = true;
}

// ===== ボタンの割り当て =====
$('report-btn').addEventListener('click', () => openReport());
$('report-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) openReport(b.dataset.tab);
});
$('quiz-btn').addEventListener('click', openQuiz);
$('quiz-close').addEventListener('click', closeQuiz);
