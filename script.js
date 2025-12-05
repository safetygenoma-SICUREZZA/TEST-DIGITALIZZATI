// =======================================
//  CFL TEST DIGITALIZZATI – SCRIPT CENTRALE
// =======================================

// ✅ Controllo autenticazione
function checkAuth() {
  if (localStorage.getItem("isRegistered") !== "true") {
    window.location.href = "index.html";
  }
}

// ✅ Funzione di logout (NEW!)
// Cancella i dati di sessione e torna alla pagina di login
function logout() {
  localStorage.removeItem("isRegistered");
  localStorage.removeItem("userData");
  localStorage.removeItem("idempotentHistory");
  window.location.href = "login.html"; // oppure "index.html" in base alla UX
}
window.logout = logout;

// ✅ Data in formato italiano (offset: -1 ieri, 0 oggi, +1 domani)
function getTestDate(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString("it-IT");
}

// -----------------------
// Utilità normalizzazione
// -----------------------
function normalizeEmail(v) {
  return (v || "").trim().toLowerCase();
}
function normalizePhone(v) {
  return (v || "").replace(/\D+/g, ""); // solo cifre
}
function simpleHash(str) {
  let h = 0, i, chr;
  if (str.length === 0) return "0";
  for (i = 0; i < str.length; i++) {
    chr = str.charCodeAt(i);
    h = (h << 5) - h + chr;
    h |= 0;
  }
  return String(Math.abs(h));
}

// ✅ Genera ID utente univoco (deterministico se c'è email)
function generateUserId(baseEmail) {
  const e = normalizeEmail(baseEmail || "");
  if (e) return "user_" + simpleHash(e);
  return "user_" + Date.now();
}

// ✅ URL del tuo script Google DEFINITIVO
const GAS_URL = "https://script.google.com/macros/s/AKfycbxD4f47b4qNzcyijb1KH9-LXAFlMkexmK_ArJe3Ux9nVysf_XicuYGHY9qgRJY75Y9YjQ/exec";
window.GASURL = GAS_URL;

// <-- PUBBLICA SU window per l'uso anche nei JS inline

// ===============
//  Anti-doppio invio (IDEMPOTENZA CLIENT)
// ===============
const DEFAULT_DEDUP_WINDOW_MS = 30_000; // invii normali (test, login)
const REGISTER_DEDUP_WINDOW_MS = 365 * 24 * 60 * 60 * 1000; // 1 anno per registrazione

if (!window.__pendingSends) window.__pendingSends = new Map();

function getDedupTtlMs(action) {
  return action === "registrazione" ? REGISTER_DEDUP_WINDOW_MS : DEFAULT_DEDUP_WINDOW_MS;
}

function loadIdemHistory() {
  try { return JSON.parse(localStorage.getItem("idempotentHistory") || "{}"); }
  catch { return {}; }
}
function saveIdemHistory(map) {
  try { localStorage.setItem("idempotentHistory", JSON.stringify(map)); } catch {}
}

/**
 * Crea una chiave stabile per l'idempotenza lato client.
 * - Per "registrazione": usa email/telefono (così è forte nel tempo).
 * - Per altri invii: userId + test + data + score.
 */
function buildIdempotencyKey(payload) {
  const action = payload.action || "generic";
  if (action === "registrazione") {
    const email = normalizeEmail(payload.email);
    const tel = normalizePhone(payload.telefono);
    return [action, email || tel || "anon"].join("|");
  }
  const userId = payload.userId || payload.email || "anon";
  const nomeTest = payload.nomeTest || "";
  const data = payload.data_test || payload.loginDate || new Date().toISOString().slice(0, 10);
  const score = (payload.score != null && payload.total != null) ? `${payload.score}/${payload.total}` : "";
  return [action, userId, nomeTest, data, score].join("|");
}

// Pulisce la history da chiavi scadute (best-effort)
function gcIdemHistory() {
  const hist = loadIdemHistory();
  const now = Date.now();
  const out = {};
  for (const [k, meta] of Object.entries(hist)) {
    const ttl = getDedupTtlMs((meta && meta.action) || "generic");
    if (meta && (now - (meta.ts || 0)) < ttl) out[k] = meta;
  }
  saveIdemHistory(out);
}

// =======================
//  Funzione unica di comunicazione con Google Sheets
//  (con idempotenza, lock e fallback no-cors)
// =======================
async function sendToSheet(payload) {
  const action = payload.action || "generic";
  const idemKey = buildIdempotencyKey(payload);
  const now = Date.now();
  const dedupTtl = getDedupTtlMs(action);

  gcIdemHistory();
  const history = loadIdemHistory();

  // 1) Dedup persistente
  const histMeta = history[idemKey];
  if (histMeta && (now - (histMeta.ts || 0)) < dedupTtl) {
    console.warn("⛔ Invio deduplicato (persistente):", idemKey);
    return { ok: true, deduped: true, cached: true };
  }

  // 2) Lock in-process
  if (window.__pendingSends.has(idemKey)) {
    console.warn("⏳ Invio già in corso, riuso la stessa richiesta:", idemKey);
    return window.__pendingSends.get(idemKey);
  }

  const runner = (async () => {
    const setHistoryMeta = () => {
      const map = loadIdemHistory();
      map[idemKey] = { ts: Date.now(), action };
      saveIdemHistory(map);
    };

    const body = JSON.stringify({ ...payload, idempotencyKey: idemKey });

    try {
      console.log("📤 Invio dati a Google Sheets...", payload);
      const resp = await fetch(GAS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": idemKey,
        },
        body,
      });
      const json = await resp.json();
      console.log("✅ Risposta JSON:", json);
      setHistoryMeta();
      return json;
    } catch (err) {
      console.warn("⚠️ CORS o rete bloccata, passo al fallback no-cors:", err);
    }

    try {
      await fetch(GAS_URL, {
        method: "POST",
        mode: "no-cors",
        headers: {
          "Content-Type": "text/plain;charset=utf-8",
          "X-Idempotency-Key": idemKey,
        },
        body,
      });
      console.log("✅ Inviato in modalità no-cors (risposta opaca)");
      setHistoryMeta();
      return { ok: true, opaque: true, idempotencyKey: idemKey };
    } catch (e2) {
      console.error("❌ Invio fallito anche in no-cors:", e2);
      return null;
    } finally {
      setTimeout(() => window.__pendingSends.delete(idemKey), 500);
    }
  })();

  window.__pendingSends.set(idemKey, runner);
  return runner;
}

// ========= SPEED MODE & OUTBOX =========

// downscale firma per invio veloce (~10-40KB)
function canvasToQuickJPEG(canvas, maxW=700, maxH=250, quality=0.7){
  try{
    const w = canvas.width, h = canvas.height;
    const r = Math.min(maxW / w, maxH / h, 1);
    const tw = Math.max(1, Math.round(w * r));
    const th = Math.max(1, Math.round(h * r));
    const tmp = document.createElement('canvas');
    tmp.width = tw; tmp.height = th;
    const tctx = tmp.getContext('2d');
    tctx.drawImage(canvas, 0, 0, tw, th);
    return tmp.toDataURL('image/jpeg', quality);
  }catch{ return canvas.toDataURL('image/png'); }
}
window.canvasToQuickJPEG = canvasToQuickJPEG; // esporta per uso nelle pagine test

// Outbox locale per retry non-bloccante
function loadOutbox(){ try{return JSON.parse(localStorage.getItem('outbox')||'[]');}catch{return[];} }
function saveOutbox(items){ try{localStorage.setItem('outbox', JSON.stringify(items));}catch{} }
function enqueueOutbox(item){
  const box = loadOutbox();
  box.push(item);
  saveOutbox(box);
}

// flush in background all’avvio di ogni pagina
async function flushOutbox(){
  const box = loadOutbox();
  if(!box.length) return;
  const rest = [];
  for(const it of box){
    try{
      await sendToSheet(it); // usa il canale “garantito”
    }catch(e){
      rest.push(it); // ritenta più tardi
    }
  }
  saveOutbox(rest);
}
// esegui il flush appena carica lo script
setTimeout(flushOutbox, 300);

// invio rapidissimo: non blocca la UI, sopravvive al redirect/close
function tryBeacon(url, bodyStr){
  try{
    const blob = new Blob([bodyStr], {type: "application/json"});
    return navigator.sendBeacon ? navigator.sendBeacon(url, blob) : false;
  }catch{ return false; }
}

/**
 * Invio FAST: non attende risposta (percezione immediata).
 * - Prova sendBeacon (no-CORS, background, survive redirect)
 * - Se non possibile, usa fetch keepalive no-cors
 * - In ogni caso mette in Outbox per retry affidabile
 */
function sendToSheetFast(payload){
  const idemKey = buildIdempotencyKey(payload);
  const bodyStr = JSON.stringify({ ...payload, idempotencyKey: idemKey });

  // 1) tenta Beacon
  const ok = tryBeacon(GAS_URL, bodyStr);

  // 2) best-effort con fetch keepalive
  if(!ok){
    try{
      fetch(GAS_URL, {
        method: "POST",
        keepalive: true,
        mode: "no-cors",
        headers: {"Content-Type":"text/plain;charset=utf-8"},
        body: bodyStr
      });
    }catch{}
  }

  // 3) garantisci consegna in differita
  enqueueOutbox(payload);
  // ritorna subito, senza await
  return {queued:true};
}

// ========== API centralizzate (ora in modalità FAST) ==========

// ✅ Invio registrazione (FAST)
function sendUserRegistration(userData) {
  const payload = { action: "registrazione", ...userData };
  return sendToSheetFast(payload);
}

// ✅ Invio risultati test (FAST)
function sendTestDataToSheet(testResultData) {
  const payload = { action: "esito_test", ...testResultData };
  return sendToSheetFast(payload);
}

// ✅ Invio evento login (FAST)
function sendLoginEvent(userData) {
  const payload = { action: "login", ...userData, loginDate: new Date().toISOString() };
  return sendToSheetFast(payload);
}

// ----------------------
// REGISTRAZIONE (index.html)
// ----------------------
async function registerUser() {
  const btn = document.getElementById("registerBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Invio in corso..."; }

  if (sessionStorage.getItem("register_lock") === "1") {
    console.warn("⛔ Registro già in corso (session lock).");
    if (btn) { btn.disabled = true; }
    return;
  }
  sessionStorage.setItem("register_lock", "1");

  const existing = JSON.parse(localStorage.getItem("userData") || "{}");
  const rawEmail = document.getElementById("email").value;
  const rawPhone = document.getElementById("telefono").value;
  const normEmail = normalizeEmail(rawEmail);
  const normPhone = normalizePhone(rawPhone);

  const stableUserId =
    (existing && normalizeEmail(existing.email) === normEmail && existing.userId) ||
    generateUserId(normEmail);

  const userData = {
    userId: stableUserId,
    cognome: document.getElementById("cognome").value.trim(),
    nome: document.getElementById("nome").value.trim(),
    email: normEmail,
    telefono: normPhone,
    registrationDate: new Date().toISOString(),
  };

  // 🔒 chiave idempotenza per registrazione
  const idemKey = buildIdempotencyKey({ action: "registrazione", ...userData });
  const history = loadIdemHistory();
  const now = Date.now();
  if (history[idemKey] && (now - history[idemKey].ts) < REGISTER_DEDUP_WINDOW_MS) {
    console.warn("⛔ Registrazione già presente in questo browser, salto invio.");
    // 👉 comunque aggiorno i dati locali e prosieguo
    localStorage.setItem("userData", JSON.stringify(userData));
    localStorage.setItem("isRegistered", "true");

    // 🧹 FIX: azzera progressi del precedente utente
    localStorage.removeItem("testProgress");
    localStorage.removeItem("allTestsCompleted");
    localStorage.removeItem("test1_retry");
    localStorage.removeItem("test2_retry");
    localStorage.removeItem("test3_retry");

    if (btn) { btn.disabled = false; btn.textContent = "Registrati"; }
    sessionStorage.removeItem("register_lock");
    window.location.href = "test-selection.html";
    return;
  }

  // salvo subito i dati utente
  localStorage.setItem("userData", JSON.stringify(userData));
  localStorage.setItem("isRegistered", "true");

  // 🧹 FIX: azzera progressi del precedente utente
  localStorage.removeItem("testProgress");
  localStorage.removeItem("allTestsCompleted");
  localStorage.removeItem("test1_retry");
  localStorage.removeItem("test2_retry");
  localStorage.removeItem("test3_retry");

  // ✅ invio FAST non bloccante
  sendUserRegistration(userData);

  if (btn) { btn.disabled = false; btn.textContent = "Registrati"; }
  sessionStorage.removeItem("register_lock");

  window.location.href = "test-selection.html";
}


// -----------------------
// Esporta funzioni nel window (già usate dalle pagine test)
// -----------------------
window.sendUserRegistration = sendUserRegistration;
window.sendTestDataToSheet = sendTestDataToSheet;
window.sendLoginEvent = sendLoginEvent;
window.registerUser = registerUser;
window.logout = logout; // <--- Esporta la funzione di logout

// =====================================================================
// ===== FULL SCORE FIX (UNIVERSALE) —> mostra/invia sempre il totale ====
// =====================================================================
// Uso tipico nei test:
//   // Init a inizio test
//   ScoreFix.init("test2", questions.length);             // test2/test3 (MCQ classico)
//   ScoreFix.init("test1", ScoreFix.atomicTotal(allQuestions)); // test1 (con sottodomande/immagini)
//
//   // Se entri in retry (mostri solo le sbagliate):
//   ScoreFix.setRetryWrong("test2", wrongIdx.length); // o "test3"
//   // Per test1 calcola quante unità atomiche stai riproponendo e passale
//
//   // Al submit (hai 'correct' di QUESTA run):
//   const full = ScoreFix.build("test2", correct);
//   // UI: `${full.correct}/${full.total}`, `${full.percentage}%`
//   // Payload Sheet: score=full.correct, total=full.total, percentuale=full.percentage
(function () {
  const KEY = "fullScoreFix";

  function save(obj) {
    localStorage.setItem(KEY, JSON.stringify(obj));
  }
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
  }

  // Conta il "totale atomico" di un test:
  // - MCQ semplice = 1
  // - Blocchi con sottodomande = n sottodomande
  // - Image-matching = n immagini
  function atomicTotal(questions) {
    let tot = 0;
    for (const q of questions || []) {
      if (q && Array.isArray(q.images)) { tot += q.images.length; continue; }
      if (q && Array.isArray(q.subQuestions)) { tot += q.subQuestions.length; continue; }
      tot += 1;
    }
    return tot;
  }

  window.ScoreFix = {
    /** testId: "test1" | "test2" | "test3"
     *  fullTotal: numero totale domande "atomiche" (per MCQ = questions.length; altrimenti atomicTotal)
     */
    init(testId, fullTotal) {
      const s = load();
      s[testId] = s[testId] || {};
      s[testId].fullTotal = Number(fullTotal) || 0;
      s[testId].retryWrong = 0;   // reset quando riparti
      save(s);
    },
    /** Chiama SOLO se sei in retry: quante domande (atomiche) stai riproponendo */
    setRetryWrong(testId, wrongCount) {
      const s = load();
      s[testId] = s[testId] || {};
      s[testId].retryWrong = Number(wrongCount) || 0;
      save(s);
    },
    /** correctThisRun = quante risposte sono risultate corrette in QUESTA esecuzione */
    build(testId, correctThisRun) {
      const sAll = load();
      const s = sAll[testId] || {};
      const full = Number(s.fullTotal) || Number(correctThisRun) || 0;
      const wrongAtStart = Number(s.retryWrong) || 0;
      const correct = wrongAtStart > 0
        ? (full - wrongAtStart) + Number(correctThisRun || 0)
        : Number(correctThisRun || 0);
      const percentage = full > 0 ? Math.round((correct / full) * 100) : 0;
      return { correct, total: full, percentage };
    },
    atomicTotal
  };
})();








