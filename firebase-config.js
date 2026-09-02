// ==========================================================
// Firebaseコンソール > プロジェクトの設定 > 全般 > マイアプリ の
// 「Firebase SDK snippet」→「構成」に表示される値を
// 下の { ... } の中に貼り替えてください。
// ==========================================================
const firebaseConfig = {
  apiKey: "AIzaSyD0N-PqqO47criDFqBsW-agxjEQIVcqV_c",
  authDomain: "spy-c7074.firebaseapp.com",
  databaseURL: "https://spy-c7074-default-rtdb.firebaseio.com",
  projectId: "spy-c7074",
  storageBucket: "spy-c7074.firebasestorage.app",
  messagingSenderId: "330886035877",
  appId: "1:330886035877:web:90dca3c966776823d8104c",
  measurementId: "G-EPYP41519Z"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();
