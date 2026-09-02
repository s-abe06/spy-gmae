// ==========================================================
// Firebaseコンソール > プロジェクトの設定 > 全般 > マイアプリ の
// 「Firebase SDK snippet」→「構成」に表示される値を
// 下の { ... } の中に貼り替えてください。
// ==========================================================
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();
