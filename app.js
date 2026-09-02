// ==========================================================
// スパイ7分の1 - Phase 1
// 実装範囲: ルーム作成/参加、ロビーの同期、役職の秘密決定と公開
// 未実装: ミニゲーム(伝達・判断一致)、作戦会議、投票、勝敗判定
// ==========================================================

// ---- 定数(仕様書どおり、あとで簡単に変更できるようにここにまとめる) ----
const SPY_PROBABILITY = 0.75; // スパイあり確率(残りは平和村)
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 7;
const ROOM_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 紛らわしい 0/O 1/I/L を除外

// ---- 状態 ----
let myUid = null;
let currentRoomCode = null;
let unsubRoom = null;
let unsubPlayers = null;
let isHost = false;

// ---- 画面切り替え ----
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

// ---- 起動: 匿名ログイン(ユーザーには見えない裏側の処理) ----
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

// ---- ルームコード生成 ----
function generateRoomCode() {
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

// ---- エラー表示 ----
function showHomeError(msg) {
  document.getElementById("home-error").textContent = msg;
}

// ---- ルーム作成 ----
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
      currentGameIndex: 0,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await db.collection("rooms").doc(code).collection("players").doc(myUid).set({
      name: nickname,
      joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
      connected: true,
    });
    enterLobby(code);
  } catch (err) {
    console.error(err);
    showHomeError("ルーム作成に失敗しました");
  }
});

// ---- ルーム参加 ----
document.getElementById("btn-join-room").addEventListener("click", async () => {
  const nickname = document.getElementById("input-nickname").value.trim();
  const code = document.getElementById("input-room-code").value.trim().toUpperCase();
  if (!nickname) return showHomeError("ニックネームを入力してください");
  if (!code) return showHomeError("ルームIDを入力してください");
  showHomeError("");

  try {
    const roomRef = db.collection("rooms").doc(code);
    const roomSnap = await roomRef.get();
    if (!roomSnap.exists) return showHomeError("そのルームIDは見つかりません");
    if (roomSnap.data().status !== "LOBBY") return showHomeError("このルームはすでに開始しています");

    const playersSnap = await roomRef.collection("players").get();
    if (playersSnap.size >= MAX_PLAYERS) return showHomeError("このルームは満員です(7人まで)");

    await roomRef.collection("players").doc(myUid).set({
      name: nickname,
      joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
      connected: true,
    });
    enterLobby(code);
  } catch (err) {
    console.error(err);
    showHomeError("参加に失敗しました");
  }
});

// ---- ロビーに入る & 同期開始 ----
function enterLobby(code) {
  currentRoomCode = code;
  document.getElementById("lobby-room-code").textContent = code;
  showScreen("screen-lobby");

  const roomRef = db.collection("rooms").doc(code);

  unsubRoom = roomRef.onSnapshot((snap) => {
    if (!snap.exists) return;
    const data = snap.data();
    isHost = data.hostUid === myUid;

    if (data.status === "ROLE_REVEAL") {
      showRoleReveal(code);
    }
  });

  unsubPlayers = roomRef.collection("players").onSnapshot((snap) => {
    renderPlayerList(snap, code);
  });
}

// ---- プレイヤー一覧描画 ----
function renderPlayerList(snap, code) {
  const listEl = document.getElementById("lobby-player-list");
  const countEl = document.getElementById("lobby-player-count");
  const startBtn = document.getElementById("btn-start-game");
  const statusText = document.getElementById("lobby-status-text");

  listEl.innerHTML = "";
  let hostUidCache = null;

  db.collection("rooms").doc(code).get().then((roomSnap) => {
    hostUidCache = roomSnap.data()?.hostUid;

    snap.forEach((doc) => {
      const li = document.createElement("li");
      li.textContent = doc.data().name;
      if (doc.id === hostUidCache) li.classList.add("is-host");
      listEl.appendChild(li);
    });

    const count = snap.size;
    countEl.textContent = count;

    const amHost = hostUidCache === myUid;
    if (amHost) {
      const ok = count >= MIN_PLAYERS && count <= MAX_PLAYERS;
      startBtn.style.display = "block";
      startBtn.disabled = !ok;
      statusText.textContent = ok
        ? "ゲームを開始できます"
        : `あと${Math.max(0, MIN_PLAYERS - count)}人必要です`;
    } else {
      startBtn.style.display = "none";
      statusText.textContent = "ホストの開始を待っています...";
    }
  });
}

// ---- ゲーム開始(役職の秘密決定) ----
document.getElementById("btn-start-game").addEventListener("click", async () => {
  if (!currentRoomCode) return;
  const roomRef = db.collection("rooms").doc(currentRoomCode);

  try {
    const playersSnap = await roomRef.collection("players").get();
    const uids = playersSnap.docs.map((d) => d.id);

    const isPeaceVillage = Math.random() > SPY_PROBABILITY;
    const spyUid = isPeaceVillage ? null : uids[Math.floor(Math.random() * uids.length)];

    // 各プレイヤーの役職を非公開コレクション(secrets)に書き込む
    // → Firestoreのセキュリティルールで「本人のuidと一致する場合だけ読める」ように制限する
    const batch = db.batch();
    uids.forEach((uid) => {
      const role = uid === spyUid ? "spy" : "player";
      const secretRef = roomRef.collection("secrets").doc(uid);
      batch.set(secretRef, { role, isPeaceVillage });
    });
    batch.update(roomRef, { status: "ROLE_REVEAL" });
    await batch.commit();
  } catch (err) {
    console.error(err);
    alert("ゲーム開始に失敗しました");
  }
});

// ---- 役職公開 ----
async function showRoleReveal(code) {
  try {
    const secretSnap = await db
      .collection("rooms")
      .doc(code)
      .collection("secrets")
      .doc(myUid)
      .get();

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

    showScreen("screen-role");
  } catch (err) {
    console.error(err);
  }
}

// ---- ルームを出る(簡易) ----
document.getElementById("btn-leave-lobby").addEventListener("click", () => {
  if (unsubRoom) unsubRoom();
  if (unsubPlayers) unsubPlayers();
  currentRoomCode = null;
  document.getElementById("input-room-code").value = "";
  showHomeError("");
  showScreen("screen-home");
});
