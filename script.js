// =======================================
//  CFL TEST DIGITALIZZATI – SCRIPT CENTRALE
// =======================================

// ✅ Controllo autenticazione
function checkAuth() {
  if (localStorage.getItem("isRegistered") !== "true") {
    window.location.href = "index.html";
  }
}

// ✅ Logout
function logout() {
  localStorage.removeItem("isRegistered");
  localStorage.removeItem("userData");
  localStorage.removeItem("idempotentHistory");
  window.location.href = "login.html";
}
window.logout = logout;

// ===================================
// UTIL
// ===================================
function getTestDate(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString("it-IT");
}

function normalizeEmail(v) {
  return (v || "").trim().toLowerCase();
}
function normalizePhone(v) {
  return (v || "").replace(/\D+/g, "");
}

function simpleHash(str) {
  let h = 0;
  if (!str) return "0";
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return String(Math.abs(h));
}

// UNI-ID
function generateUserId(email) {
  const e = normalizeEmail(email);
  return e ? "user_" + simpleHash(e) : "user_" + Date.now();
}

// URL DEFINITIVO SCRIPT GOOGLE
const GAS_URL =
  "https://script.google.com/macros/s/AKfycbxD4f47b4qNzcyijb1KH9-LXAFlMkexmK_ArJe3Ux9nVysf_XicuYGHY9qgRJY75Y9YjQ/exec";
window.GASURL = GAS_URL;

// ===================================
// IDEMPOTENZA + OUTBOX
// ===================================

const DEFAULT_DEDUP_WINDOW_MS = 30000;
const REGISTER_DEDUP_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

if (!window.__pendingSends) window.__pendingSends = new Map();

function getDedupTtlMs(action) {
  return action === "registrazione"
    ? REGISTER_DEDUP_WINDOW_MS
    : DEFAULT_DEDUP_WINDOW_MS;
}

function loadIdemHistory() {
  try {
    return JSON.parse(localStorage.getItem("idempotentHistory") || "{}");
  } catch {
    return {};
  }
}
function saveIdemHistory(map) {
  try {
    localStorage.setItem("idempotentHistory", JSON.stringify(map));
  } catch {}
}

function buildIdempotencyKey(payload) {
  const action = payload.action || "generic";

  if (action === "registrazione") {
    const e = normalizeEmail(payload.email);
    const t = normalizePhone(payload.telefono);
    return [action, e || t || "anon"].join("|");
  }

  const userId = payload.userId || payload.email || "anon";
  const nomeTest = payload.nomeTest || "";
  const data =
    payload.data_test ||
    payload.loginDate ||
    new Date().toISOString().slice(0, 10);
  const score =
    payload.score != null && payload.total != null
      ? `${payload.score}/${payload.total}`
      : "";

  return [action, userId, nomeTest, data, score].join("|");
}

function gcIdemHistory() {
  const hist = loadIdemHistory();
  const now = Date.now();
  const out = {};
  for (const [k, meta] of Object.entries(hist)) {
    const ttl = getDedupTtlMs(meta?.action || "generic");
    if (meta && now - meta.ts < ttl) out[k] = meta;
  }
  saveIdemHistory(out);
}

// ================================
// INVIO STANDARD (POST JSON) + fallback no-cors
// ================================
async function sendToSheet(payload) {
  const action = payload.action || "generic";
  const idemKey = buildIdempotencyKey(payload);
  const now = Date.now();

  gcIdemHistory();
  const history = loadIdemHistory();
  const ttl = getDedupTtlMs(action);

  if (history[idemKey] && now - history[idemKey].ts < ttl) {
    return { ok: true, deduped: true };
  }

  if (window.__pendingSends.has(idemKey)) {
    return window.__pendingSends.get(idemKey);
  }

  const runner = (async () => {
    const updateHistory = () => {
      const map = loadIdemHistory();
      map[idemKey] = { ts: Date.now(), action };
      saveIdemHistory(map);
    };

    const body = JSON.stringify({ ...payload, idempotencyKey: idemKey });

    try {
      const resp = await fetch(GAS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const json = await resp.json();
      updateHistory();
      return json;
    } catch (e) {}

    try {
      await fetch(GAS_URL, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body,
      });
      updateHistory();
      return { ok: true, opaque: true };
    } catch (e2) {
      return null;
    } finally {
      setTimeout(() => window.__pendingSends.delete(idemKey), 500);
    }
  })();

  window.__pendingSends.set(idemKey, runner);
  return runner;
}

// FAST MODE (no attesa risposta)
function sendToSheetFast(payload) {
  const idemKey = buildIdempotencyKey(payload);
  const body = JSON.stringify({ ...payload, idempotencyKey: idemKey });

  try {
    const blob = new Blob([body], { type: "application/json" });
    navigator.sendBeacon(GAS_URL, blob);
  } catch {}

  try {
    fetch(GAS_URL, {
      method: "POST",
      mode: "no-cors",
      keepalive: true,
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body,
    });
  } catch {}

  enqueueOutbox(payload);
  return { queued: true };
}

function loadOutbox() {
  try {
    return JSON.parse(localStorage.getItem("outbox") || "[]");
  } catch {
    return [];
  }
}
function saveOutbox(x) {
  try {
    localStorage.setItem("outbox", JSON.stringify(x));
  } catch {}
}
function enqueueOutbox(item) {
  const box = loadOutbox();
  box.push(item);
  saveOutbox(box);
}

// flush iniziale
setTimeout(flushOutbox, 300);

async function flushOutbox() {
  const box = loadOutbox();
  if (!box.length) return;

  const rest = [];
  for (const it of box) {
    try {
      await sendToSheet(it);
    } catch {
      rest.push(it);
    }
  }
  saveOutbox(rest);
}

// ===================================
// API PRINCIPALI (FAST)
// ===================================

function sendUserRegistration(userData) {
  return sendToSheetFast({ action: "registrazione", ...userData });
}

function sendTestDataToSheet(data) {
  return sendToSheetFast({ action: "esito_test", ...data });
}

function sendLoginEvent(data) {
  return sendToSheetFast({
    action: "login",
    ...data,
    loginDate: new Date().toISOString(),
  });
}

// ===================================
// 🔥 NUOVA FUNZIONE LOGIN CHECK (POST VERAMENTE FUNZIONANTE)
// ===================================
async function sendLoginCheck(email, telefono) {
  const payload = {
    action: "login_check",
    email: normalizeEmail(email),
    telefono: normalizePhone(telefono),
  };

  try {
    const resp = await fetch(GAS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    return await resp.json();
  } catch (err) {
    console.error("Errore LOGIN_CHECK:", err);
    return { ok: false, found: false, error: "fetch_failed" };
  }
}

window.sendLoginCheck = sendLoginCheck;

// ===================================
// REGISTRAZIONE (index.html)
// ===================================
async function registerUser() {
  const btn = document.getElementById("registerBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Invio in corso...";
  }

  if (sessionStorage.getItem("register_lock") === "1") return;
  sessionStorage.setItem("register_lock", "1");

  const rawEmail = document.getElementById("email").value;
  const rawPhone = document.getElementById("telefono").value;

  const normEmail = normalizeEmail(rawEmail);
  const normPhone = normalizePhone(rawPhone);

  const existing = JSON.parse(localStorage.getItem("userData") || "{}");

  const stableUserId =
    (existing &&
      normalizeEmail(existing.email) === normEmail &&
      existing.userId) ||
    generateUserId(normEmail);

  const userData = {
    userId: stableUserId,
    cognome: document.getElementById("cognome").value.trim(),
    nome: document.getElementById("nome").value.trim(),
    email: normEmail,
    telefono: normPhone,
    registrationDate: new Date().toISOString(),
  };

  localStorage.setItem("userData", JSON.stringify(userData));
  localStorage.setItem("isRegistered", "true");

  sendUserRegistration(userData);

  if (btn) {
    btn.disabled = false;
    btn.textContent = "Registrati";
  }
  sessionStorage.removeItem("register_lock");

  window.location.href = "test-selection.html";
}

window.sendUserRegistration = sendUserRegistration;
window.sendTestDataToSheet = sendTestDataToSheet;
window.sendLoginEvent = sendLoginEvent;
window.registerUser = registerUser;
window.logout = logout;

// ===================================
// FULL SCORE FIX
// ===================================
(function () {
  const KEY = "fullScoreFix";

  function save(o) {
    localStorage.setItem(KEY, JSON.stringify(o));
  }
  function load() {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || {};
    } catch {
      return {};
    }
  }

  function atomicTotal(questions) {
    let tot = 0;
    for (const q of questions || []) {
      if (Array.isArray(q.images)) {
        tot += q.images.length;
        continue;
      }
      if (Array.isArray(q.subQuestions)) {
        tot += q.subQuestions.length;
        continue;
      }
      tot += 1;
    }
    return tot;
  }

  window.ScoreFix = {
    init(testId, fullTotal) {
      const s = load();
      s[testId] = s[testId] || {};
      s[testId].fullTotal = Number(fullTotal) || 0;
      s[testId].retryWrong = 0;
      save(s);
    },
    setRetryWrong(testId, wrongCount) {
      const s = load();
      s[testId] = s[testId] || {};
      s[testId].retryWrong = Number(wrongCount) || 0;
      save(s);
    },
    build(testId, correctThisRun) {
      const sAll = load();
      const s = sAll[testId] || {};
      const full = Number(s.fullTotal) || Number(correctThisRun) || 0;
      const wrong = Number(s.retryWrong) || 0;

      const correct =
        wrong > 0
          ? full - wrong + Number(correctThisRun)
          : Number(correctThisRun);

      const percentage = full > 0 ? Math.round((correct / full) * 100) : 0;

      return { correct, total: full, percentage };
    },
    atomicTotal,
  };
})();










