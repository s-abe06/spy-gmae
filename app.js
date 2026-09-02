// ==========================================================
// スパイ7分の1 - Phase 2
// 追加実装: GAME1〜4(漢字伝達・判断一致)、作戦会議、投票、結果表示
// 設計上の簡略化(README参照): 各GAMEは1ラウンドのみ(仕様書の複数ラウンドは今後の拡張)
// ==========================================================

// ---- 定数 ----
const SPY_PROBABILITY = 0.75;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 7;
const ROOM_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const HINT_TURN_SECONDS = 15;      // 漢字ヒント1人あたりの持ち時間
const GUESS_SECONDS = 15;          // 回答者がお題を当てる持ち時間
const JUDGMENT_ANSWER_SECONDS = 20; // 判断一致ゲームの回答時間
const REVEAL_DISPLAY_SECONDS = 3;   // 結果表示の余韻
const DISCUSSION_SECONDS = 60;
const VOTING_SECONDS = 20;
const GAMES_NEEDED_TO_WIN = 3; // 4ゲーム中これ以上成功でプレイヤー側条件1クリア
const JUDGMENT_ALLOWED_MISMATCH = 1; // 最多得票の選択肢との不一致がこの人数以内なら成功

// ---- 状態 ----
let myUid = null;
let currentRoomCode = null;
let isHost = false;
let playersCache = {}; // uid -> {name, ...}

let unsubRoom = null;
let unsubPlayers = null;
let unsubSub = null; // hints/answers/votes など、フェーズごとに切り替わるサブスクリプション

let countdownTimer = null;
let lastHandledPhaseKey = null; // 同じフェーズの処理を二重実行しないためのガード(ホスト用)

// ---- 画面切り替え ----
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

// ---- 起動: 匿名ログイン ----
auth.signInAnonymously().catch((err) => {
  console.error("認証エラー", err);
  document.getElementById("screen-loading").querySelector("p").textContent =
    "接続に失敗しました。ページを再読み込みしてください。";
});

auth.onAuthStateChanged((user) => {
  if (user) {
    myUid = user.uid;
    showScreen("screen-home");
  }
});

// ---- ユーティリティ ----
function generateRoomCode() {
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function roomRef() {
  return db.collection("rooms").doc(currentRoomCode);
}

// hints/answers/votes/secretsは各GAME・各プレイ間で使い回すため、
// 次のフェーズに進む前にホストがまとめて削除しておく
async function clearCollection(colRef) {
  const snap = await colRef.get();
  if (snap.empty) return;
  const batch = db.batch();
  snap.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

function playerName(uid) {
  return playersCache[uid]?.name || "???";
}

function showHomeError(msg) {
  document.getElementById("home-error").textContent = msg;
}

function clearCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

// endsAtMillis: 数値(Date.now()基準)。1秒ごとにdisplayElへ残り秒数を表示し、0になったらonExpireを1回だけ呼ぶ
function startCountdown(endsAtMillis, displayEl, onExpire) {
  clearCountdown();
  let expired = false;
  function tick() {
    const remain = Math.max(0, Math.ceil((endsAtMillis - Date.now()) / 1000));
    if (displayEl) displayEl.textContent = remain;
    if (remain <= 0 && !expired) {
      expired = true;
      clearCountdown();
      onExpire && onExpire();
    }
  }
  tick();
  countdownTimer = setInterval(tick, 250);
}

// ==========================================================
// ホーム / ルーム作成・参加
// ==========================================================

document.getElementById("btn-create-room").addEventListener("click", async () => {
  const nickname = document.getElementById("input-nickname").value.trim();
  if (!nickname) return showHomeError("ニックネームを入力してください");
  showHomeError("");

  const code = generateRoomCode();
  try {
    await db.collection("rooms").doc(code).set({
      hostUid: myUid,
      status: "LOBBY",
      spyProbability: SPY_PROBABILITY,
      currentGameIndex: -1,
      gameResults: [null, null, null, null],
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await db.collection("rooms").doc(code).collection("players").doc(myUid).set({
      name: nickname,
      joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
      connected: true,
    });
    enterRoom(code);
  } catch (err) {
    console.error(err);
    showHomeError("ルーム作成に失敗しました");
  }
});

document.getElementById("btn-join-room").addEventListener("click", async () => {
  const nickname = document.getElementById("input-nickname").value.trim();
  const code = document.getElementById("input-room-code").value.trim().toUpperCase();
  if (!nickname) return showHomeError("ニックネームを入力してください");
  if (!code) return showHomeError("ルームIDを入力してください");
  showHomeError("");

  try {
    const ref = db.collection("rooms").doc(code);
    const snap = await ref.get();
    if (!snap.exists) return showHomeError("そのルームIDは見つかりません");
    if (snap.data().status !== "LOBBY") return showHomeError("このルームはすでに開始しています");

    const playersSnap = await ref.collection("players").get();
    if (playersSnap.size >= MAX_PLAYERS) return showHomeError("このルームは満員です(7人まで)");

    await ref.collection("players").doc(myUid).set({
      name: nickname,
      joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
      connected: true,
    });
    enterRoom(code);
  } catch (err) {
    console.error(err);
    showHomeError("参加に失敗しました");
  }
});

// ==========================================================
// ルーム全体の同期(ロビー〜結果まで、この1つのリスナーで進行を見る)
// ==========================================================

function enterRoom(code) {
  currentRoomCode = code;
  lastHandledPhaseKey = null;
  document.getElementById("lobby-room-code").textContent = code;
  showScreen("screen-lobby");

  unsubPlayers = roomRef().collection("players").onSnapshot((snap) => {
    playersCache = {};
    snap.forEach((doc) => (playersCache[doc.id] = doc.data()));
    if (currentRoomStatus === "LOBBY") renderLobby(snap);
  });

  unsubRoom = roomRef().onSnapshot((snap) => {
    if (!snap.exists) return;
    const data = snap.data();
    currentRoomStatus = data.status;
    isHost = data.hostUid === myUid;
    routeStatus(data);
  });
}

let currentRoomStatus = null;

function routeStatus(data) {
  switch (data.status) {
    case "LOBBY":
      showScreen("screen-lobby");
      db.collection("rooms").doc(currentRoomCode).collection("players").get()
        .then((snap) => renderLobby(snap));
      break;
    case "ROLE_REVEAL":
      showRoleReveal(data);
      break;
    case "GAME_1":
    case "GAME_2":
    case "GAME_3":
    case "GAME_4":
      renderGameScreen(data);
      break;
    case "DISCUSSION":
      renderDiscussion(data);
      break;
    case "VOTING":
      renderVoting(data);
      break;
    case "RESULT":
      renderResult(data);
      break;
  }
}

// ==========================================================
// ロビー
// ==========================================================

function renderLobby(playersSnap) {
  const listEl = document.getElementById("lobby-player-list");
  const countEl = document.getElementById("lobby-player-count");
  const startBtn = document.getElementById("btn-start-game");
  const statusText = document.getElementById("lobby-status-text");

  listEl.innerHTML = "";
  let count = 0;
  playersSnap.forEach((doc) => {
    count++;
    const li = document.createElement("li");
    li.textContent = doc.data().name;
    if (isHost && doc.id === myUid) li.classList.add("is-host");
    listEl.appendChild(li);
  });

  countEl.textContent = count;

  if (isHost) {
    const ok = count >= MIN_PLAYERS && count <= MAX_PLAYERS;
    startBtn.style.display = "block";
    startBtn.disabled = !ok;
    statusText.textContent = ok ? "ゲームを開始できます" : `あと${Math.max(0, MIN_PLAYERS - count)}人必要です`;
  } else {
    startBtn.style.display = "none";
    statusText.textContent = "ホストの開始を待っています...";
  }
}

document.getElementById("btn-start-game").addEventListener("click", async () => {
  if (!currentRoomCode) return;
  const ref = roomRef();
  try {
    const playersSnap = await ref.collection("players").get();
    const uids = playersSnap.docs.map((d) => d.id);

    const isPeaceVillage = Math.random() > SPY_PROBABILITY;
    const spyUid = isPeaceVillage ? null : uids[Math.floor(Math.random() * uids.length)];

    const batch = db.batch();
    uids.forEach((uid) => {
      const role = uid === spyUid ? "spy" : "player";
      batch.set(ref.collection("secrets").doc(uid), { role, isPeaceVillage, spyUid: spyUid || null });
    });
    batch.update(ref, { status: "ROLE_REVEAL" });
    await batch.commit();
  } catch (err) {
    console.error(err);
    alert("ゲーム開始に失敗しました");
  }
});

document.getElementById("btn-leave-lobby").addEventListener("click", leaveRoom);

function leaveRoom() {
  if (unsubRoom) unsubRoom();
  if (unsubPlayers) unsubPlayers();
  if (unsubSub) unsubSub();
  clearCountdown();
  currentRoomCode = null;
  document.getElementById("input-room-code").value = "";
  showHomeError("");
  showScreen("screen-home");
}

// ==========================================================
// 役職公開
// ==========================================================

async function showRoleReveal(data) {
  try {
    const secretSnap = await roomRef().collection("secrets").doc(myUid).get();
    if (!secretSnap.exists) return;
    const { role } = secretSnap.data();

    const icon = document.getElementById("role-icon");
    const title = document.getElementById("role-title");
    const desc = document.getElementById("role-desc");

    if (role === "spy") {
      icon.textContent = "🕵️";
      title.textContent = "あなたはスパイです";
      desc.textContent = "仲間にバレないようにゲームを失敗させよう。あなた以外のプレイヤーには、あなたの正体は分かりません。";
    } else {
      icon.textContent = "🙂";
      title.textContent = "あなたはプレイヤーです";
      desc.textContent = "仲間と協力してゲームを成功させよう。";
    }

    const startBtn = document.getElementById("btn-start-first-game");
    const waitText = document.getElementById("role-wait-text");
    startBtn.style.display = isHost ? "block" : "none";
    waitText.style.display = isHost ? "none" : "block";

    showScreen("screen-role");
  } catch (err) {
    console.error(err);
  }
}

document.getElementById("btn-start-first-game").addEventListener("click", async () => {
  await clearCollection(roomRef().collection("hints"));
  await clearCollection(roomRef().collection("answers"));
  const gameData = await generateGameData(0);
  await roomRef().update({
    currentGameIndex: 0,
    gameResults: [null, null, null, null],
    status: "GAME_1",
    gameData,
  });
});

// ==========================================================
// ミニゲーム共通
// ==========================================================

async function generateGameData(index) {
  const type = GAME_SEQUENCE[index];
  const playersSnap = await roomRef().collection("players").get();
  const uids = playersSnap.docs.map((d) => d.id);

  if (type === "kanji") {
    const topic = KANJI_TOPICS[Math.floor(Math.random() * KANJI_TOPICS.length)];
    const guesserUid = uids[Math.floor(Math.random() * uids.length)];
    const hintOrder = shuffle(uids.filter((u) => u !== guesserUid));
    return {
      type: "kanji",
      phase: "HINT",
      topic: topic.answer,
      choices: shuffle(topic.choices),
      guesserUid,
      hintOrder,
      currentHinterIndex: 0,
      phaseEndsAt: Date.now() + HINT_TURN_SECONDS * 1000,
    };
  } else {
    const q = JUDGMENT_QUESTIONS[Math.floor(Math.random() * JUDGMENT_QUESTIONS.length)];
    return {
      type: "judgment",
      phase: "ANSWER",
      question: q.question,
      choices: shuffle(q.choices),
      phaseEndsAt: Date.now() + JUDGMENT_ANSWER_SECONDS * 1000,
    };
  }
}

function renderGameScreen(data) {
  showScreen("screen-game");
  document.getElementById("game-label").textContent = `GAME ${data.currentGameIndex + 1}`;

  const kanjiArea = document.getElementById("kanji-area");
  const judgmentArea = document.getElementById("judgment-area");
  const revealArea = document.getElementById("game-reveal-area");
  const timerEl = document.getElementById("game-timer");

  const gd = data.gameData;
  if (!gd) return;

  if (gd.phase === "REVEAL") {
    kanjiArea.classList.remove("active");
    judgmentArea.classList.remove("active");
    revealArea.style.display = "block";
    timerEl.textContent = "";
    renderGameReveal(gd);
    if (unsubSub) { unsubSub(); unsubSub = null; }
    if (isHost) hostAdvanceAfterReveal(data);
    return;
  }

  revealArea.style.display = "none";

  if (gd.type === "kanji") {
    kanjiArea.classList.add("active");
    judgmentArea.classList.remove("active");
    renderKanji(gd);
  } else {
    judgmentArea.classList.add("active");
    kanjiArea.classList.remove("active");
    renderJudgment(gd);
  }

  startCountdown(gd.phaseEndsAt, timerEl, () => {
    if (isHost) hostHandlePhaseTimeout(data);
  });
}

// ---- 漢字伝達ゲーム ----

function renderKanji(gd) {
  const amGuesser = gd.guesserUid === myUid;
  const banner = document.getElementById("kanji-role-banner");
  const topicEl = document.getElementById("kanji-topic");
  const inputArea = document.getElementById("kanji-hint-input-area");
  const guessArea = document.getElementById("kanji-guess-area");
  const hintListEl = document.getElementById("kanji-hint-list");

  if (gd.phase === "HINT") {
    guessArea.style.display = "none";
    const myTurn = gd.hintOrder[gd.currentHinterIndex] === myUid;

    if (amGuesser) {
      banner.textContent = "あなたは回答者です。ヒントが集まるのを待ちましょう(お題は見えません)";
      topicEl.style.display = "none";
      inputArea.style.display = "none";
    } else {
      banner.textContent = myTurn ? "あなたの番です！漢字1字でヒントを出してください" : "他の人の番です";
      topicEl.style.display = "block";
      topicEl.textContent = `お題: ${gd.topic}`;
      inputArea.style.display = myTurn ? "block" : "none";
    }

    if (unsubSub) unsubSub();
    unsubSub = roomRef().collection("hints").onSnapshot((snap) => {
      const hints = {};
      snap.forEach((d) => (hints[d.id] = d.data().char));
      hintListEl.innerHTML = "";
      gd.hintOrder.forEach((uid) => {
        const li = document.createElement("li");
        li.textContent = hints[uid] || "";
        hintListEl.appendChild(li);
      });
    });
  } else if (gd.phase === "GUESS") {
    inputArea.style.display = "none";
    topicEl.style.display = "none";
    banner.textContent = amGuesser ? "ヒントからお題を当ててください！" : "回答者が考え中です...";
    guessArea.style.display = amGuesser ? "block" : "block";

    const choicesEl = document.getElementById("kanji-guess-choices");
    choicesEl.innerHTML = "";
    gd.choices.forEach((choice) => {
      const btn = document.createElement("button");
      btn.className = "choice-btn";
      btn.textContent = choice;
      btn.disabled = !amGuesser;
      btn.addEventListener("click", async () => {
        if (!amGuesser) return;
        choicesEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
        btn.classList.add("selected");
        await roomRef().collection("answers").doc(myUid).set({ choice });
      });
      choicesEl.appendChild(btn);
    });

    if (unsubSub) unsubSub();
  }
}

document.getElementById("btn-submit-hint").addEventListener("click", async () => {
  const input = document.getElementById("input-kanji-char");
  const char = input.value.trim();
  if (!char) return;
  if (!/^[\u4e00-\u9fff]$/.test(char)) {
    alert("漢字1字を入力してください");
    return;
  }
  await roomRef().collection("hints").doc(myUid).set({ char });
  input.value = "";
  document.getElementById("kanji-hint-input-area").style.display = "none";
});

// ホスト専用: ヒント提出を監視して、全員出そろったら回答フェーズへ進める
function watchKanjiHintsAsHost(data) {
  const gd = data.gameData;
  const ref = roomRef();
  const unsub = ref.collection("hints").onSnapshot(async (snap) => {
    const submittedUids = new Set(snap.docs.map((d) => d.id));
    let idx = gd.currentHinterIndex;
    while (idx < gd.hintOrder.length && submittedUids.has(gd.hintOrder[idx])) idx++;

    if (idx !== gd.currentHinterIndex) {
      if (idx >= gd.hintOrder.length) {
        // 全員出し終わった → 回答フェーズへ
        unsub();
        await ref.update({
          "gameData.phase": "GUESS",
          "gameData.currentHinterIndex": idx,
          "gameData.phaseEndsAt": Date.now() + GUESS_SECONDS * 1000,
        });
      } else {
        await ref.update({
          "gameData.currentHinterIndex": idx,
          "gameData.phaseEndsAt": Date.now() + HINT_TURN_SECONDS * 1000,
        });
      }
    }
  });
  return unsub;
}

function watchKanjiGuessAsHost(data) {
  const gd = data.gameData;
  const ref = roomRef();
  const unsub = ref.collection("answers").doc(gd.guesserUid).onSnapshot(async (snap) => {
    if (!snap.exists) return;
    unsub();
    const choice = snap.data().choice;
    const success = choice === gd.topic;
    await finishCurrentGame(data, success, { chosenAnswer: choice, correctAnswer: gd.topic });
  });
  return unsub;
}

// ---- 判断・一致ゲーム ----

function renderJudgment(gd) {
  const qEl = document.getElementById("judgment-question");
  const choicesEl = document.getElementById("judgment-choices");
  const waitEl = document.getElementById("judgment-wait-text");
  qEl.textContent = gd.question;
  choicesEl.innerHTML = "";
  waitEl.style.display = "none";

  gd.choices.forEach((choice) => {
    const btn = document.createElement("button");
    btn.className = "choice-btn";
    btn.textContent = choice;
    btn.addEventListener("click", async () => {
      choicesEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
      btn.classList.add("selected");
      waitEl.style.display = "block";
      await roomRef().collection("answers").doc(myUid).set({ choice });
    });
    choicesEl.appendChild(btn);
  });

  if (unsubSub) unsubSub();
}

function watchJudgmentAsHost(data) {
  const ref = roomRef();
  const unsub = ref.collection("answers").onSnapshot(async (snap) => {
    const totalPlayers = Object.keys(playersCache).length;
    if (snap.size < totalPlayers) return;
    unsub();

    const counts = {};
    snap.forEach((d) => {
      const c = d.data().choice;
      counts[c] = (counts[c] || 0) + 1;
    });
    const maxCount = Math.max(...Object.values(counts));
    const success = maxCount >= totalPlayers - JUDGMENT_ALLOWED_MISMATCH;

    await finishCurrentGame(data, success, { counts, totalPlayers });
  });
  return unsub;
}

// ---- ゲーム進行の共通処理(ホストのみ) ----

async function finishCurrentGame(data, success, detail) {
  const ref = roomRef();
  const gameResults = [...data.gameResults];
  gameResults[data.currentGameIndex] = success;
  await ref.update({
    gameResults,
    "gameData.phase": "REVEAL",
    "gameData.result": { success, ...detail },
  });
}

function renderGameReveal(gd) {
  const icon = document.getElementById("game-reveal-icon");
  const title = document.getElementById("game-reveal-title");
  const detail = document.getElementById("game-reveal-detail");
  const r = gd.result || {};

  icon.textContent = r.success ? "✅" : "❌";
  title.textContent = r.success ? "成功！" : "失敗...";

  if (gd.type === "kanji") {
    detail.textContent = `正解: ${r.correctAnswer} / 回答者の答え: ${r.chosenAnswer}`;
  } else {
    const parts = Object.entries(r.counts || {}).map(([k, v]) => `${k}: ${v}人`);
    detail.textContent = parts.join(" / ");
  }
}

// フェーズのタイムアウト(誰かが操作しなかった場合)をホストが処理
async function hostHandlePhaseTimeout(data) {
  const gd = data.gameData;
  const ref = roomRef();

  if (gd.type === "kanji" && gd.phase === "HINT") {
    const uid = gd.hintOrder[gd.currentHinterIndex];
    const hintSnap = await ref.collection("hints").doc(uid).get();
    if (!hintSnap.exists) {
      await ref.collection("hints").doc(uid).set({ char: "？" }); // 未回答は「？」で埋める
    }
  } else if (gd.type === "kanji" && gd.phase === "GUESS") {
    const ansSnap = await ref.collection("answers").doc(gd.guesserUid).get();
    if (!ansSnap.exists) {
      await finishCurrentGame(data, false, { chosenAnswer: "(未回答)", correctAnswer: gd.topic });
    }
  } else if (gd.type === "judgment" && gd.phase === "ANSWER") {
    const snap = await ref.collection("answers").get();
    const counts = {};
    snap.forEach((d) => {
      const c = d.data().choice;
      counts[c] = (counts[c] || 0) + 1;
    });
    const totalPlayers = Object.keys(playersCache).length;
    const maxCount = Object.values(counts).length ? Math.max(...Object.values(counts)) : 0;
    const success = maxCount >= totalPlayers - JUDGMENT_ALLOWED_MISMATCH;
    await finishCurrentGame(data, success, { counts, totalPlayers });
  }
}

// フェーズが変わるたびにホスト側の監視を張り直す
function ensureHostWatchers(data) {
  const key = `${data.status}:${data.gameData?.phase}:${data.currentGameIndex}`;
  if (!isHost || lastHandledPhaseKey === key) return;
  lastHandledPhaseKey = key;

  if (unsubSub) { unsubSub(); unsubSub = null; }

  const gd = data.gameData;
  if (data.status.startsWith("GAME_") && gd) {
    if (gd.type === "kanji" && gd.phase === "HINT") unsubSub = watchKanjiHintsAsHost(data);
    if (gd.type === "kanji" && gd.phase === "GUESS") unsubSub = watchKanjiGuessAsHost(data);
    if (gd.type === "judgment" && gd.phase === "ANSWER") unsubSub = watchJudgmentAsHost(data);
  }
  if (data.status === "VOTING") unsubSub = watchVotingAsHost(data);
}

// REVEAL表示のあと、次のGAMEまたはDISCUSSIONへ(ホストのみ・1回だけ)
let revealAdvanceTimer = null;
function hostAdvanceAfterReveal(data) {
  const key = `reveal:${data.currentGameIndex}`;
  if (lastHandledPhaseKey === key) return;
  lastHandledPhaseKey = key;

  if (revealAdvanceTimer) clearTimeout(revealAdvanceTimer);
  revealAdvanceTimer = setTimeout(async () => {
    const ref = roomRef();
    if (data.currentGameIndex < 3) {
      const nextIndex = data.currentGameIndex + 1;
      await clearCollection(ref.collection("hints"));
      await clearCollection(ref.collection("answers"));
      const gameData = await generateGameData(nextIndex);
      await ref.update({
        currentGameIndex: nextIndex,
        status: `GAME_${nextIndex + 1}`,
        gameData,
      });
    } else {
      await ref.update({
        status: "DISCUSSION",
        discussionEndsAt: Date.now() + DISCUSSION_SECONDS * 1000,
      });
    }
  }, REVEAL_DISPLAY_SECONDS * 1000);
}

// このrouteStatus拡張: GAME中もホスト監視をセットする
const originalRouteStatus = routeStatus;
routeStatus = function (data) {
  originalRouteStatus(data);
  ensureHostWatchers(data);
};

// ==========================================================
// 作戦会議
// ==========================================================

function renderDiscussion(data) {
  showScreen("screen-discussion");
  renderMiniSummary(document.getElementById("discussion-game-summary"), data.gameResults);

  const timerEl = document.getElementById("discussion-timer");
  startCountdown(data.discussionEndsAt, timerEl, () => {
    if (isHost) {
      const key = "discussion-end";
      if (lastHandledPhaseKey === key) return;
      lastHandledPhaseKey = key;
      roomRef().update({ status: "VOTING", votingEndsAt: Date.now() + VOTING_SECONDS * 1000 });
    }
  });
}

function renderMiniSummary(container, gameResults) {
  container.innerHTML = "";
  (gameResults || []).forEach((r) => {
    const dot = document.createElement("div");
    dot.className = "game-dot" + (r === true ? " success" : r === false ? " fail" : "");
    dot.textContent = r === true ? "○" : r === false ? "×" : "-";
    container.appendChild(dot);
  });
}

// ==========================================================
// 投票
// ==========================================================

function renderVoting(data) {
  showScreen("screen-voting");
  const container = document.getElementById("voting-choices");
  const waitEl = document.getElementById("voting-wait-text");
  container.innerHTML = "";
  waitEl.style.display = "none";

  const targets = Object.keys(playersCache).filter((uid) => uid !== myUid);

  function makeBtn(label, targetValue) {
    const btn = document.createElement("button");
    btn.className = "vote-btn";
    btn.textContent = label;
    btn.addEventListener("click", async () => {
      container.querySelectorAll("button").forEach((b) => b.disabled = true);
      btn.classList.add("selected");
      waitEl.style.display = "block";
      await roomRef().collection("votes").doc(myUid).set({ target: targetValue });
    });
    return btn;
  }

  targets.forEach((uid) => container.appendChild(makeBtn(playerName(uid), uid)));
  container.appendChild(makeBtn("🚫 スパイはいない", "NONE"));

  startCountdown(data.votingEndsAt, document.getElementById("voting-timer"), () => {
    if (isHost) finalizeVotingAsHost(data);
  });
}

function watchVotingAsHost(data) {
  const ref = roomRef();
  const totalPlayers = Object.keys(playersCache).length;
  const unsub = ref.collection("votes").onSnapshot((snap) => {
    if (snap.size >= totalPlayers) finalizeVotingAsHost(data);
  });
  return unsub;
}

async function finalizeVotingAsHost(data) {
  const key = "voting-finalize";
  if (lastHandledPhaseKey === key) return;
  lastHandledPhaseKey = key;
  if (unsubSub) { unsubSub(); unsubSub = null; }

  const ref = roomRef();
  const votesSnap = await ref.collection("votes").get();
  const voteCounts = {};
  votesSnap.forEach((d) => {
    const t = d.data().target;
    voteCounts[t] = (voteCounts[t] || 0) + 1;
  });

  let mostVoted = "NONE";
  let maxVotes = -1;
  Object.entries(voteCounts).forEach(([target, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      mostVoted = target;
    }
  });

  // ホストは secrets を全員分読める(ルールで許可)
  const secretsSnap = await ref.collection("secrets").get();
  let spyUid = null;
  let isPeaceVillage = true;
  secretsSnap.forEach((d) => {
    if (d.data().role === "spy") spyUid = d.id;
    isPeaceVillage = d.data().isPeaceVillage;
  });

  const gameSuccessCount = (data.gameResults || []).filter((r) => r === true).length;
  const condition1 = gameSuccessCount >= GAMES_NEEDED_TO_WIN;
  const correctTarget = isPeaceVillage ? "NONE" : spyUid;
  const condition2 = mostVoted === correctTarget;
  const playerWin = condition1 && condition2;

  await ref.update({
    status: "RESULT",
    resultData: {
      voteCounts,
      mostVoted,
      spyUid: spyUid || null,
      isPeaceVillage,
      condition1,
      condition2,
      playerWin,
      gameSuccessCount,
    },
  });
}

// ==========================================================
// 結果
// ==========================================================

function renderResult(data) {
  showScreen("screen-result");
  const rd = data.resultData;
  if (!rd) return;

  const stepVotes = document.getElementById("result-step-votes");
  const stepRole = document.getElementById("result-step-role");
  const stepFinal = document.getElementById("result-step-final");
  stepVotes.style.display = "block";
  stepRole.style.display = "none";
  stepFinal.style.display = "none";

  const listEl = document.getElementById("result-vote-list");
  listEl.innerHTML = "";
  Object.keys(playersCache).forEach((uid) => {
    const li = document.createElement("li");
    const count = rd.voteCounts[uid] || 0;
    li.innerHTML = `${playerName(uid)}<span class="vote-count">${count}票</span>`;
    listEl.appendChild(li);
  });
  const noneLi = document.createElement("li");
  noneLi.innerHTML = `スパイはいない<span class="vote-count">${rd.voteCounts["NONE"] || 0}票</span>`;
  listEl.appendChild(noneLi);

  const key = `result:${currentRoomCode}:${data.status}`;
  if (lastHandledPhaseKey === key) return; // アニメーションの多重起動を防ぐ
  lastHandledPhaseKey = key;

  setTimeout(() => {
    stepVotes.style.display = "none";
    stepRole.style.display = "block";
    const icon = document.getElementById("result-role-icon");
    const title = document.getElementById("result-role-title");
    if (rd.isPeaceVillage) {
      icon.textContent = "🕊";
      title.textContent = "今回、スパイはいませんでした！(平和村)";
    } else {
      icon.textContent = "🕵️";
      title.textContent = `スパイは「${playerName(rd.spyUid)}」でした！`;
    }
  }, 2500);

  setTimeout(() => {
    stepRole.style.display = "none";
    stepFinal.style.display = "block";
    document.getElementById("result-final-title").textContent = rd.playerWin ? "🎉 プレイヤー側の勝利！" : "😈 スパイ側(?)の勝利...";
    document.getElementById("result-final-detail").textContent =
      `ミニゲーム成功: ${rd.gameSuccessCount}/4 (${rd.condition1 ? "条件クリア" : "条件未達"}) / `
      + `投票: ${rd.condition2 ? "正解" : "不正解"}`;
    renderMiniSummary(document.getElementById("result-game-summary"), data.gameResults);

    document.getElementById("btn-play-again").style.display = isHost ? "block" : "none";
  }, 5000);
}

document.getElementById("btn-play-again").addEventListener("click", async () => {
  const ref = roomRef();
  await clearCollection(ref.collection("secrets"));
  await clearCollection(ref.collection("hints"));
  await clearCollection(ref.collection("answers"));
  await clearCollection(ref.collection("votes"));
  await ref.update({
    status: "LOBBY",
    currentGameIndex: -1,
    gameResults: [null, null, null, null],
    gameData: firebase.firestore.FieldValue.delete(),
    resultData: firebase.firestore.FieldValue.delete(),
  });
});

document.getElementById("btn-leave-result").addEventListener("click", leaveRoom);
