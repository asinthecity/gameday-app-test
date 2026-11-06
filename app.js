// GDA-58 spike page. Throw-away test code, not the real app.
// Answers questions W1, W2, W6, W7 and W8 from docs/discovery/05-technical-outline.md.
// Made-up names only. The Sheet address and secret are typed in on the phone and
// live only in IndexedDB; they must never appear in this file or in the results.

"use strict";

const VERSION = self.SPIKE_VERSION;
const DB_NAME = "spike-test";
const DB_VERSION = 1; // Leave at 1 when bumping the spike version: the data must carry over.
const CACHE_PREFIX = "gameday-spike-"; // Same prefix as sw.js.
const LOOP_GAP_MS = 50;
const SEND_TIMEOUT_MS = 30000;
const LOG_LINES_KEPT = 200;
const REPLY_CHARS_SHOWN = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

const startedAt = new Date();

// Everything the page shows. Kept in memory so "Copy results" can build its text
// straight away: iPhones refuse a clipboard write if the tap was waited on first.
const state = {
  readyMs: null,
  online: navigator.onLine,
  swText: "checking",
  controlled: false,
  cacheNames: null,
  updateCheck: "not yet",
  stats: null, // total, highest, missing, missingSample, standalone, first
  lastShownBefore: null, // number saved as shown during the previous open
  lastShown: null, // number shown during this open
  opens: null,
  previousOpen: null,
  persistAnswer: null,
  persisted: "not checked",
  estimate: "not checked",
  durability: "not reported",
  gameInProgress: null, // null = not known yet, which is treated as "in progress"
  game: null,
  waitingCount: null,
  log: [],
};

function byId(id) {
  return document.getElementById(id);
}

function setText(id, text) {
  byId(id).textContent = text;
}

function when(date) {
  return new Date(date).toLocaleString();
}

function errorText(error) {
  if (!error) {
    return "unknown error";
  }
  return (error.name || "Error") + ": " + (error.message || String(error));
}

/* ---------- Display mode ---------- */

function displayMode() {
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  return standalone ? "standalone" : "browser";
}

function modeLabel() {
  return displayMode() === "standalone" ? "Home Screen app" : "Safari tab";
}

function modeDetail() {
  return (
    "matchMedia standalone=" +
    window.matchMedia("(display-mode: standalone)").matches +
    ", navigator.standalone=" +
    window.navigator.standalone
  );
}

/* ---------- Results log (kept in IndexedDB so it survives force-quits) ---------- */

// Removes the Sheet address and secret from anything shown or copied.
function redact(text) {
  let clean = String(text);
  const values = [byId("sheet-url").value.trim(), byId("sheet-secret").value.trim()];
  for (const value of values) {
    if (value) {
      clean = clean.split(value).join("[hidden]");
    }
  }
  return clean.replace(/https:\/\/script\.[a-z.]*\/\S*/gi, "[hidden]");
}

function addLog(text) {
  const line = when(new Date()) + "  " + redact(text);
  state.log.push(line);
  renderLog();
  run(["log"], "readwrite", (tx) => {
    tx.objectStore("log").add({ line });
  }).catch(() => {
    // Keeping the line on screen is enough if the database is the thing failing.
  });
}

function renderLog() {
  setText("log", state.log.slice().reverse().join("\n"));
}

async function loadLog() {
  const saved = await run(["log"], "readonly", (tx, done) => {
    tx.objectStore("log").getAll().onsuccess = (event) => {
      done(event.target.result.map((row) => row.line));
    };
  });
  const newLines = state.log.filter((line) => !saved.includes(line));
  state.log = saved.concat(newLines).slice(-LOG_LINES_KEPT);
  renderLog();
}

/* ---------- IndexedDB helpers ---------- */

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        const entries = db.createObjectStore("entries", { keyPath: "number" });
        entries.createIndex("mode", "mode");
        db.createObjectStore("meta", { keyPath: "key" });
        db.createObjectStore("sends", { keyPath: "gameId" });
        db.createObjectStore("log", { autoIncrement: true });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onclose = () => {
          dbPromise = null; // The next call opens it again.
        };
        resolve(db);
      };
      request.onerror = () => {
        dbPromise = null;
        reject(request.error);
      };
    });
  }
  return dbPromise;
}

// Runs work inside one transaction. The promise resolves only after the
// transaction's complete event, so "resolved" means "the database says it is saved".
// work(tx, done): call done(value) to choose what the promise resolves with.
async function run(storeNames, mode, work, canRetry = true) {
  const db = await openDb();
  let tx;
  try {
    // "strict" asks for the data to be flushed to disk before complete fires.
    tx = db.transaction(storeNames, mode, { durability: "strict" });
    if (mode === "readwrite" && tx.durability) {
      state.durability = tx.durability; // Shows whether this device honoured the request.
    }
  } catch (error) {
    // iPhones have been known to drop the database connection in the background.
    if (error.name === "InvalidStateError" && canRetry) {
      dbPromise = null;
      addLog("Database connection was lost; reopened it");
      return run(storeNames, mode, work, false);
    }
    throw error;
  }
  return new Promise((resolve, reject) => {
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
    work(tx, (value) => {
      result = value;
    });
  });
}

function metaSet(key, value) {
  return run(["meta"], "readwrite", (tx) => {
    tx.objectStore("meta").put({ key, value });
  });
}

function metaGet(key) {
  return run(["meta"], "readonly", (tx, done) => {
    tx.objectStore("meta").get(key).onsuccess = (event) => {
      const row = event.target.result;
      done(row ? row.value : undefined);
    };
  });
}

/* ---------- W1/W2: numbered entries ---------- */

// Adds the next numbered entry in one transaction and resolves with its number
// only once the transaction has completed.
function writeEntry() {
  return run(["entries"], "readwrite", (tx, done) => {
    const store = tx.objectStore("entries");
    store.openKeyCursor(null, "prev").onsuccess = (event) => {
      const cursor = event.target.result;
      const number = (cursor ? cursor.key : 0) + 1;
      store.add({ number, timestamp: new Date().toISOString(), mode: displayMode() });
      done(number);
    };
  });
}

function showConfirmed(number) {
  state.lastShown = number;
  setText("shown", String(number));
  byId("write-error").hidden = true;

  if (state.stats) {
    state.stats.total += 1;
    state.stats.highest = Math.max(state.stats.highest, number);
    if (displayMode() === "standalone") {
      state.stats.standalone += 1;
    }
    if (!state.stats.first) {
      state.stats.first = { number, timestamp: new Date().toISOString() };
    }
    renderStats();
  }

  // Saved after the number is on screen, in its own write. A force-quit can lose
  // this write, so it can lag behind what was shown. It is a rough guide only.
  metaSet("lastShown", number).catch(() => {});
}

function showWriteError(error) {
  const message = "Not saved. " + errorText(error);
  setText("write-error", message);
  byId("write-error").hidden = false;
  addLog(message);
}

async function recordAction() {
  try {
    showConfirmed(await writeEntry());
  } catch (error) {
    showWriteError(error);
  }
}

let looping = false;
let loopWrites = 0;

async function loopStep() {
  if (!looping) {
    return;
  }
  try {
    showConfirmed(await writeEntry());
    loopWrites += 1;
  } catch (error) {
    showWriteError(error);
    stopLoop();
    return;
  }
  setTimeout(loopStep, LOOP_GAP_MS);
}

function startLoop() {
  looping = true;
  loopWrites = 0;
  setText("loop-btn", "Stop writing");
  addLog("Writing loop started");
  loopStep();
}

function stopLoop() {
  looping = false;
  setText("loop-btn", "Start writing");
  addLog("Writing loop stopped after " + loopWrites + " writes; last shown " + state.lastShown);
}

// Reads the entries and works out totals and gaps.
function readStats() {
  return run(["entries", "meta"], "readonly", (tx, done) => {
    const result = { meta: {} };
    done(result);
    const entries = tx.objectStore("entries");
    entries.getAllKeys().onsuccess = (event) => {
      result.keys = event.target.result;
    };
    entries.index("mode").count(IDBKeyRange.only("standalone")).onsuccess = (event) => {
      result.standalone = event.target.result;
    };
    entries.openCursor().onsuccess = (event) => {
      const cursor = event.target.result;
      result.first = cursor ? cursor.value : null;
    };
    tx.objectStore("meta").getAll().onsuccess = (event) => {
      for (const row of event.target.result) {
        result.meta[row.key] = row.value;
      }
    };
  });
}

function summariseKeys(keys) {
  const missingSample = [];
  let missing = 0;
  let expected = 1;
  for (const key of keys) {
    for (let gap = expected; gap < key; gap += 1) {
      missing += 1;
      if (missingSample.length < 10) {
        missingSample.push(gap);
      }
    }
    expected = key + 1;
  }
  return {
    total: keys.length,
    highest: keys.length ? keys[keys.length - 1] : 0,
    missing,
    missingSample,
  };
}

function verdict() {
  const stats = state.stats;
  if (!stats) {
    return "Not read yet";
  }
  if (stats.total === 0) {
    return "No records. If you expected some, storage was cleared.";
  }
  if (stats.missing > 0) {
    return "PROBLEM: " + stats.missing + " numbers missing, starting " + stats.missingSample.join(", ");
  }
  if (state.lastShownBefore !== null && stats.highest < state.lastShownBefore) {
    return "PROBLEM: number " + state.lastShownBefore + " was shown but is not stored";
  }
  return "No gaps. Is the last number you saw " + stats.highest + " or lower?";
}

function renderStats() {
  const stats = state.stats;
  if (!stats) {
    return;
  }
  setText("rd-total", String(stats.total));
  setText("rd-highest", String(stats.highest));
  setText("rd-missing", stats.missing === 0 ? "None" : String(stats.missing));
  setText("rd-modes", stats.standalone + " / " + (stats.total - stats.standalone));
  setText("rd-verdict", verdict());
  setText("st-first", stats.first ? new Date(stats.first.timestamp).toLocaleDateString() : "none");
  setText("st-age", ageText());
}

function ageText() {
  const first = state.stats && state.stats.first;
  if (!first) {
    return "none";
  }
  return ((Date.now() - new Date(first.timestamp).getTime()) / DAY_MS).toFixed(1) + " days";
}

async function refreshStats() {
  const result = await readStats();
  const standalone = result.standalone || 0;
  state.stats = {
    ...summariseKeys(result.keys || []),
    standalone,
    first: result.first || null,
  };
  renderStats();
  return result.meta;
}

async function recordOpen(meta) {
  const opens = (meta.opens || 0) + 1;
  state.opens = opens;
  state.previousOpen = meta.lastOpen || null;
  await metaSet("opens", opens);
  await metaSet("lastOpen", startedAt.toISOString());
  setText("rd-opens", String(opens));
  setText("rd-prev-open", previousOpenText());
}

function previousOpenText() {
  if (!state.previousOpen) {
    return "none";
  }
  const days = (startedAt.getTime() - new Date(state.previousOpen).getTime()) / DAY_MS;
  return when(state.previousOpen) + " (" + days.toFixed(1) + " days ago)";
}

/* ---------- Storage questions ---------- */

function persistText() {
  const answer = state.persistAnswer;
  if (!answer) {
    return "not asked yet";
  }
  return answer.result + " (" + when(answer.at) + ", " + answer.mode + ")";
}

function renderStorage() {
  setText("rd-persist", persistText());
  setText("rd-persisted", state.persisted);
  setText("rd-estimate", state.estimate);
}

async function askPersist() {
  let result;
  if (navigator.storage && navigator.storage.persist) {
    try {
      result = String(await navigator.storage.persist());
    } catch (error) {
      result = "error, " + errorText(error);
    }
  } else {
    result = "not available on this device";
  }
  state.persistAnswer = { result, at: new Date().toISOString(), mode: displayMode() };
  await metaSet("persistAnswer", state.persistAnswer).catch(showWriteError);
  addLog("persist() answered: " + result + " (mode " + displayMode() + ")");
  await readPersisted();
  renderStorage();
}

async function readPersisted() {
  if (navigator.storage && navigator.storage.persisted) {
    try {
      state.persisted = String(await navigator.storage.persisted());
    } catch (error) {
      state.persisted = "error, " + errorText(error);
    }
  } else {
    state.persisted = "not available on this device";
  }
  renderStorage();
}

function megabytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

async function readEstimate() {
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      state.estimate = megabytes(estimate.usage) + " of " + megabytes(estimate.quota);
    } catch (error) {
      state.estimate = "error, " + errorText(error);
    }
  } else {
    state.estimate = "not available on this device";
  }
  renderStorage();
}

/* ---------- Game in progress ---------- */

function renderGameToggle() {
  const button = byId("game-btn");
  const on = state.gameInProgress === true;
  button.textContent = "Game in progress: " + (state.gameInProgress === null ? "..." : on ? "ON" : "OFF");
  button.setAttribute("aria-pressed", String(on));
}

async function toggleGame() {
  const next = !(await metaGet("gameInProgress"));
  await metaSet("gameInProgress", next);
  state.gameInProgress = next;
  renderGameToggle();
  renderUpdateBanner();
  addLog("Game in progress turned " + (next ? "ON" : "OFF"));
}

/* ---------- W7/W8: service worker and updates ---------- */

let registration = null;
let updateRequested = false;
let reloading = false;
const watchedWorkers = new WeakSet();

function renderWorker() {
  state.controlled = "serviceWorker" in navigator && !!navigator.serviceWorker.controller;
  if (registration) {
    const parts = [];
    if (registration.active) {
      parts.push(registration.active.state);
    }
    if (registration.installing) {
      parts.push("installing new");
    }
    if (registration.waiting) {
      parts.push("new one waiting");
    }
    state.swText = parts.join(", ") || "registered";
  }
  setText("st-sw", state.swText);
  setText("rd-controlled", state.controlled ? "Yes" : "No");
  setText("rd-update-check", state.updateCheck);
  renderUpdateBanner();
}

function renderUpdateBanner() {
  // Needs an active worker too: the very first install passes through "waiting" for a moment.
  const waiting = registration && registration.active && registration.waiting;
  byId("update-banner").hidden = !waiting;
  if (!waiting) {
    return;
  }
  // Only an answer of exactly "off" allows the button. Not knowing counts as on.
  const canUpdate = state.gameInProgress === false;
  setText("update-text", canUpdate ? "New version ready" : "Update waiting until the game is over");
  byId("update-btn").hidden = !canUpdate;
}

function watchWorker(worker) {
  if (!worker || watchedWorkers.has(worker)) {
    return;
  }
  watchedWorkers.add(worker);
  worker.addEventListener("statechange", () => {
    renderWorker();
    if (worker.state === "installed" && registration && registration.active) {
      addLog("New version downloaded and waiting");
    }
    if (worker.state === "redundant") {
      readCaches();
    }
  });
}

async function checkForUpdate() {
  if (!registration) {
    return;
  }
  const time = new Date().toLocaleTimeString();
  try {
    await registration.update();
    state.updateCheck = time + ", finished";
  } catch (error) {
    state.updateCheck = time + ", failed: " + errorText(error);
  }
  renderWorker();
}

async function setupWorker() {
  if (!("serviceWorker" in navigator)) {
    state.swText = "not supported";
    setText("st-sw", state.swText);
    addLog("Service workers are not available here");
    return;
  }

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    renderWorker();
    readCaches();
    // The very first install also fires this event, so only reload after a tap on Update.
    if (updateRequested && !reloading) {
      reloading = true;
      window.location.reload();
    }
  });

  try {
    // "none" makes update checks skip the browser's file cache, for sw.js and version.js.
    registration = await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
  } catch (error) {
    addLog("Worker registration failed: " + errorText(error));
    registration = (await navigator.serviceWorker.getRegistration().catch(() => null)) || null;
    if (!registration) {
      state.swText = "failed";
      setText("st-sw", state.swText);
      return;
    }
  }

  registration.addEventListener("updatefound", () => {
    addLog(registration.active ? "Update check found a new version" : "First install of the worker");
    watchWorker(registration.installing);
    renderWorker();
  });
  watchWorker(registration.installing);
  watchWorker(registration.waiting);
  watchWorker(registration.active);
  renderWorker();
  checkForUpdate();
}

async function applyUpdate() {
  // Ask the database rather than trusting the screen, in case the game was just started.
  const gameInProgress = await metaGet("gameInProgress");
  state.gameInProgress = gameInProgress === true;
  renderGameToggle();
  if (state.gameInProgress || !registration || !registration.waiting) {
    renderUpdateBanner();
    return;
  }
  updateRequested = true;
  byId("update-btn").disabled = true;
  addLog("Update tapped on " + VERSION);
  registration.waiting.postMessage("skipWaiting");
  setTimeout(() => {
    if (!reloading) {
      addLog("Update tapped but nothing happened after 5 seconds");
      byId("update-btn").disabled = false;
    }
  }, 5000);
}

async function readCaches() {
  if (!("caches" in window)) {
    state.cacheNames = "not available";
  } else {
    try {
      const names = await caches.keys();
      const ours = names.filter((name) => name.startsWith(CACHE_PREFIX));
      state.cacheNames = ours.map((name) => name.slice(CACHE_PREFIX.length)).join(", ") || "none";
    } catch (error) {
      state.cacheNames = "error, " + errorText(error);
    }
  }
  setText("rd-caches", state.cacheNames);
}

/* ---------- Made-up game ---------- */

function makeGame() {
  const now = new Date();
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  return {
    gameId: "SPIKE-" + date + "-" + hex,
    createdAt: now.toISOString(),
    note: "Made-up test data",
    opponent: "Test Rovers",
    ourScore: 2,
    theirScore: 1,
    players: [
      { name: "Alfie", minutes: 25, goals: 1 },
      { name: "Bea", minutes: 20, goals: 1 },
      { name: "Cody", minutes: 15, goals: 0 },
    ],
  };
}

async function newGame() {
  state.game = makeGame();
  setText("game-id", state.game.gameId);
  await metaSet("currentGame", state.game).catch(showWriteError);
  addLog("New game ID " + state.game.gameId);
}

function gameAsCsv(game) {
  const rows = [["gameId", "createdAt", "opponent", "ourScore", "theirScore", "player", "minutes", "goals"]];
  for (const player of game.players) {
    rows.push([game.gameId, game.createdAt, game.opponent, game.ourScore, game.theirScore,
      player.name, player.minutes, player.goals]);
  }
  return rows.map((row) => row.join(",")).join("\r\n") + "\r\n";
}

/* ---------- W6(iii): file export ---------- */

let exportUrls = [];

function showExportResult(lines) {
  byId("export-result").hidden = false;
  setText("export-result", lines.join("\n"));
  addLog("Export: " + lines.join(" | "));
}

function showDownloadLinks(files) {
  exportUrls.forEach((url) => URL.revokeObjectURL(url));
  exportUrls = [];
  const box = byId("export-links");
  box.textContent = "";
  for (const file of files) {
    const url = URL.createObjectURL(file);
    exportUrls.push(url);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.textContent = "Download " + file.name;
    link.addEventListener("click", () => addLog("Download link tapped: " + file.name));
    box.appendChild(link);
  }
  box.hidden = false;
}

// Nothing is waited on before navigator.share, because iPhones only allow
// the share sheet straight after a tap.
async function exportGame() {
  const game = state.game || makeGame();
  const name = "spike-game-" + game.gameId;
  const files = [
    new File([JSON.stringify(game, null, 2)], name + ".json", { type: "application/json" }),
    new File([gameAsCsv(game)], name + ".csv", { type: "text/csv" }),
  ];
  const lines = [];

  if (!navigator.share) {
    lines.push("navigator.share is not available");
  } else if (!navigator.canShare) {
    lines.push("navigator.canShare is not available");
  } else {
    const shareable = files.filter((file) => navigator.canShare({ files: [file] }));
    lines.push("canShare: " + (shareable.map((file) => file.name.split(".").pop()).join(" and ") || "neither file"));
    if (shareable.length > 0) {
      try {
        await navigator.share({ files: shareable, title: "Test game" });
        lines.push("Share sheet finished without error. Check the file really arrived.");
        if (shareable.length === files.length) {
          showExportResult(lines);
          return;
        }
      } catch (error) {
        lines.push("Share failed: " + errorText(error));
      }
    }
  }

  lines.push("Showing download links instead");
  showDownloadLinks(files);
  showExportResult(lines);
}

/* ---------- W6(i): Sheet send ---------- */

let sheetBusy = false;

function setSheetBusy(busy) {
  sheetBusy = busy;
  for (const id of ["send-btn", "send-again-btn", "retry-btn", "check-btn", "new-game-btn"]) {
    byId(id).disabled = busy;
  }
}

function showSheetResult(lines) {
  byId("sheet-result").hidden = false;
  setText("sheet-result", redact(lines.join("\n")));
  addLog("Sheet: " + lines.join(" | "));
}

async function saveSheetSettings() {
  const url = byId("sheet-url").value.trim();
  const secret = byId("sheet-secret").value.trim();
  await metaSet("sheetUrl", url);
  await metaSet("sheetSecret", secret);
  return { url, secret };
}

// Only ever send the secret to Google. localhost is allowed for desktop testing.
function sheetUrlProblem(url) {
  if (!url) {
    return "Paste the Apps Script web address first";
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    return "That web address does not look right";
  }
  const isGoogle = parsed.protocol === "https:" && parsed.hostname === "script.google.com";
  const isLocal = parsed.protocol === "http:" && parsed.hostname === "localhost";
  return isGoogle || isLocal ? null : "The web address must start https://script.google.com/";
}

// Makes one web request and describes exactly what came back.
async function requestAndRead(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  const outcome = { readable: false, status: null, type: null, redirected: null, body: "", json: null, error: null };
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    outcome.status = response.status;
    outcome.type = response.type;
    outcome.redirected = response.redirected;
    outcome.body = await response.text();
    outcome.readable = true;
    try {
      outcome.json = JSON.parse(outcome.body);
    } catch (error) {
      outcome.json = null;
    }
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    clearTimeout(timer);
  }
  return outcome;
}

function describeOutcome(outcome) {
  const lines = ["Reply readable: " + (outcome.readable ? "yes" : "no")];
  if (outcome.status !== null) {
    lines.push("Status: " + outcome.status + ", type: " + outcome.type + ", redirected: " + outcome.redirected);
  }
  if (outcome.readable) {
    lines.push("Body: " + outcome.body.slice(0, REPLY_CHARS_SHOWN));
  }
  if (outcome.error) {
    lines.push("Error: " + outcome.error);
  }
  return lines;
}

function readSend(gameId) {
  return run(["sends"], "readonly", (tx, done) => {
    tx.objectStore("sends").get(gameId).onsuccess = (event) => done(event.target.result);
  });
}

function saveSend(row) {
  return run(["sends"], "readwrite", (tx) => {
    tx.objectStore("sends").put(row);
  });
}

async function readUnsent() {
  const rows = await run(["sends"], "readonly", (tx, done) => {
    tx.objectStore("sends").getAll().onsuccess = (event) => done(event.target.result);
  });
  return rows.filter((row) => row.state === "unsent");
}

async function refreshWaiting() {
  const unsent = await readUnsent();
  state.waitingCount = unsent.length;
  setText("rd-waiting", String(unsent.length));
}

// Sends one game. Before the request it is marked unsent, so a failure or a
// force-quit part way through leaves it waiting. A game becomes "sent" only
// after a readable reply that says ok. Returns true if confirmed.
async function sendGame(game, label) {
  const row = (await readSend(game.gameId)) || { gameId: game.gameId, game, state: "unsent", attempts: 0 };
  row.attempts += 1;
  row.lastTry = new Date().toISOString();
  await saveSend(row);

  const { url, secret } = await saveSheetSettings();
  const problem = sheetUrlProblem(url) || (secret ? null : "Paste the secret first");
  if (problem) {
    showSheetResult([label + " " + game.gameId, "Not sent: " + problem]);
    return false;
  }

  const outcome = await requestAndRead(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ secret, gameId: game.gameId, record: game }),
    redirect: "follow",
    cache: "no-store",
  });

  const confirmed = outcome.readable && outcome.status === 200 && !!outcome.json && outcome.json.ok === true;
  const lines = [label + " " + game.gameId].concat(describeOutcome(outcome));
  if (confirmed) {
    row.state = "sent";
    row.sentAt = new Date().toISOString();
    await saveSend(row);
    lines.push(outcome.json.duplicate ? "Confirmed: already in the Sheet, nothing added" : "Confirmed: one row added");
  } else if (row.state === "sent") {
    lines.push("Not confirmed this time, but this game was confirmed earlier");
  } else {
    lines.push("Not confirmed: waiting to send. It may still have arrived; use Check.");
  }
  showSheetResult(lines);
  return confirmed;
}

// Runs a Sheet action, one at a time, and always updates the waiting count.
async function sheetAction(action) {
  if (sheetBusy) {
    return;
  }
  setSheetBusy(true);
  try {
    await action();
  } catch (error) {
    showSheetResult(["Something went wrong: " + errorText(error)]);
  } finally {
    await refreshWaiting().catch(() => {});
    setSheetBusy(false);
  }
}

async function retryUnsent() {
  const unsent = await readUnsent();
  if (unsent.length === 0) {
    showSheetResult(["Nothing waiting to send"]);
    return;
  }
  for (const row of unsent) {
    await sendGame(row.game, "Retry");
  }
}

// Asks only "is this game ID in the Sheet?". No secret is sent, because it would
// have to go in the web address. This never marks a game as sent.
async function checkGame() {
  const { url } = await saveSheetSettings();
  const problem = sheetUrlProblem(url);
  if (problem) {
    showSheetResult(["Check not done: " + problem]);
    return;
  }
  const address = new URL(url);
  address.searchParams.set("gameId", state.game.gameId);
  const outcome = await requestAndRead(address.href, { method: "GET", redirect: "follow", cache: "no-store" });
  const lines = ["Check " + state.game.gameId].concat(describeOutcome(outcome));
  if (outcome.json && typeof outcome.json.found === "boolean") {
    lines.push("In the Sheet: " + (outcome.json.found ? "yes" : "no"));
  } else {
    lines.push("Check gave no clear answer");
  }
  showSheetResult(lines);
}

/* ---------- Copy results ---------- */

// Plain text of everything on the page, apart from the Sheet address and secret.
function resultsText() {
  const stats = state.stats;
  const lines = [
    "GDA-58 spike results",
    "Copied: " + when(new Date()),
    "Version: " + VERSION,
    "Mode: " + modeLabel() + " (" + modeDetail() + ")",
    "Network: " + (state.online ? "online" : "offline"),
    "Worker: " + state.swText,
    "Controlled by worker: " + (state.controlled ? "yes" : "no"),
    "Stored versions: " + state.cacheNames,
    "Last update check: " + state.updateCheck,
    "Update banner: " + (byId("update-banner").hidden ? "not shown" : byId("update-text").textContent),
    "Ready in: " + (state.readyMs === null ? "not ready" : state.readyMs + " ms"),
    "This open started: " + when(startedAt),
    "Open number: " + state.opens,
    "Previous open: " + previousOpenText(),
    "First record: " + (stats && stats.first ? when(stats.first.timestamp) : "none"),
    "Record age: " + ageText(),
    "Total entries: " + (stats ? stats.total : "not read"),
    "Highest number: " + (stats ? stats.highest : "not read"),
    "Missing numbers: " + (stats ? stats.missing : "not read"),
    "Saved from Home Screen / tab: " + (stats ? stats.standalone + " / " + (stats.total - stats.standalone) : "not read"),
    "Last shown before closing: " + (state.lastShownBefore === null ? "none" : state.lastShownBefore),
    "Last shown this open: " + (state.lastShown === null ? "none" : state.lastShown),
    "Check: " + verdict(),
    "Write durability: " + state.durability,
    "persist() answer: " + persistText(),
    "persisted() now: " + state.persisted,
    "Estimate: " + state.estimate,
    "Game in progress: " + state.gameInProgress,
    "Game ID: " + (state.game ? state.game.gameId : "none"),
    "Waiting to send: " + state.waitingCount,
    "Sheet address saved: " + (byId("sheet-url").value.trim() ? "yes" : "no"),
    "Secret saved: " + (byId("sheet-secret").value.trim() ? "yes" : "no"),
    "Device: " + navigator.userAgent,
    "",
    "Results log, oldest first:",
  ].concat(state.log);
  return redact(lines.join("\n"));
}

function showCopyNote(text) {
  const note = byId("copy-note");
  note.hidden = false;
  note.textContent = text;
}

function showCopyFallback(text) {
  byId("copy-fallback").hidden = false;
  const box = byId("copy-text");
  box.value = text;
  byId("copy-fallback").scrollIntoView();
  box.focus();
  box.select();
}

async function copyResults() {
  const text = resultsText();
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      throw new Error("Clipboard is not available");
    }
    await navigator.clipboard.writeText(text);
    byId("copy-fallback").hidden = true;
    showCopyNote("Copied. Paste it into your message.");
  } catch (error) {
    showCopyNote("Copy failed. Use the box under Results.");
    showCopyFallback(text);
  }
}

/* ---------- Start up ---------- */

function renderNetwork() {
  state.online = navigator.onLine;
  setText("st-online", state.online ? "Online" : "Offline");
}

function connectButtons() {
  byId("copy-btn").addEventListener("click", copyResults);
  byId("record-btn").addEventListener("click", recordAction);
  byId("loop-btn").addEventListener("click", () => (looping ? stopLoop() : startLoop()));
  byId("persist-btn").addEventListener("click", askPersist);
  byId("persisted-btn").addEventListener("click", readPersisted);
  byId("estimate-btn").addEventListener("click", readEstimate);
  byId("game-btn").addEventListener("click", () => toggleGame().catch(showWriteError));
  byId("update-btn").addEventListener("click", () => applyUpdate().catch(showWriteError));
  byId("export-btn").addEventListener("click", () =>
    exportGame().catch((error) => showExportResult(["Export failed: " + errorText(error)]))
  );
  byId("send-btn").addEventListener("click", () => sheetAction(() => sendGame(state.game, "Send")));
  byId("send-again-btn").addEventListener("click", () => sheetAction(() => sendGame(state.game, "Send again")));
  byId("new-game-btn").addEventListener("click", () => sheetAction(newGame));
  byId("retry-btn").addEventListener("click", () => sheetAction(retryUnsent));
  byId("check-btn").addEventListener("click", () => sheetAction(checkGame));
  byId("sheet-url").addEventListener("change", () => saveSheetSettings().catch(showWriteError));
  byId("sheet-secret").addEventListener("change", () => saveSheetSettings().catch(showWriteError));

  window.addEventListener("online", renderNetwork);
  window.addEventListener("offline", renderNetwork);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      renderNetwork();
      checkForUpdate();
      readCaches();
      readPersisted();
      refreshStats().catch(showWriteError);
    }
  });

  // There are no developer tools on the phone, so page errors go in the results.
  window.addEventListener("error", (event) => addLog("Page error: " + event.message));
  window.addEventListener("unhandledrejection", (event) => addLog("Page error: " + errorText(event.reason)));
}

async function loadSavedData() {
  await loadLog();
  const meta = await refreshStats();

  // Fill the boxes before anything can be logged, so redact() knows what to hide.
  byId("sheet-url").value = meta.sheetUrl || "";
  byId("sheet-secret").value = meta.sheetSecret || "";

  state.lastShownBefore = meta.lastShown === undefined ? null : meta.lastShown;
  state.persistAnswer = meta.persistAnswer || null;
  state.gameInProgress = meta.gameInProgress === true;
  state.game = meta.currentGame || null;

  setText("rd-last-shown", state.lastShownBefore === null ? "none" : String(state.lastShownBefore));
  if (state.stats.highest > 0) {
    setText("shown", String(state.stats.highest));
  }
  renderStats();
  renderGameToggle();
  renderUpdateBanner();
  renderStorage();

  state.readyMs = Math.round(performance.now());
  setText("st-ready", state.readyMs + " ms");

  if (!state.game) {
    await newGame();
  }
  setText("game-id", state.game.gameId);

  await refreshWaiting();
  await recordOpen(meta);
  await Promise.all([readPersisted(), readEstimate()]);
  addLog(
    "Opened " + VERSION + " #" + state.opens + " in " + state.readyMs + " ms, mode " + displayMode() +
      ", network " + (state.online ? "online" : "offline") +
      ", entries " + state.stats.total + ", highest " + state.stats.highest +
      ", missing " + state.stats.missing + ", last shown before " + state.lastShownBefore +
      ", persisted " + state.persisted
  );
}

function start() {
  setText("version", VERSION);
  setText("st-mode", modeLabel());
  setText("rd-started", when(startedAt));
  renderNetwork();
  connectButtons();
  renderStorage();

  // The worker starts separately so a stuck database cannot stop offline support.
  setupWorker().catch((error) => addLog("Worker problem: " + errorText(error)));
  readCaches();

  loadSavedData().catch((error) => {
    setText("rd-verdict", "Could not open storage. " + errorText(error));
    addLog("Could not open storage: " + errorText(error));
  });
}

start();
