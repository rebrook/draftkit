const express = require("express");
const http    = require("http");
const WebSocket = require("ws");
const fs      = require("fs");
const path    = require("path");
const os      = require("os");

// Resolve the first non-internal IPv4 address for startup logging
function getLocalIP() {
  var interfaces = os.networkInterfaces();
  for (var name of Object.keys(interfaces)) {
    for (var iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "localhost";
}

const PORT       = 3000;
const DATA_DIR   = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");

// ── In-memory log buffer ──────────────────────────────────────────────────────
const LOG_MAX = 500;
var logBuffer = [];
var serverStartTime = Date.now();

function log(level, message) {
  var entry = {
    ts:      new Date().toISOString(),
    level:   level,   // "INFO" | "WARN" | "ERROR"
    message: message,
  };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
  // Still write to stdout for Task Scheduler / process-level visibility
  var prefix = "[" + entry.ts + "] [" + level + "] ";
  if (level === "ERROR") console.error(prefix + message);
  else console.log(prefix + message);
}

// ── Ensure data directory exists ─────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
  log("INFO", "Created data directory: " + DATA_DIR);
}

// ── Per-board state helpers ───────────────────────────────────────────────────
function stateFile(boardId) {
  var safe = boardId.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(DATA_DIR, safe + ".json");
}

function loadState(boardId) {
  try {
    var file = stateFile(boardId);
    if (fs.existsSync(file)) {
      var saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved && typeof saved.locked === "boolean") {
        log("INFO", "Loaded state for board: " + boardId);
        return {
          state:                saved.state || {},
          locked:               saved.locked,
          draftHistory:         saved.draftHistory || [],
          notes:                saved.notes || {},
          playerNotes:          saved.playerNotes || {},
          commissionerPassword: saved.commissionerPassword || "commissioner",
          commissionerConfig:   saved.commissionerConfig || null,
          archived:             saved.archived || false,
          archiveUnlockCode:    saved.archiveUnlockCode || null,
        };
      }
      log("INFO", "Loaded legacy state for board: " + boardId);
      return { state: saved, locked: false, draftHistory: [], notes: {}, playerNotes: {}, commissionerPassword: "commissioner", commissionerConfig: null, archived: false, archiveUnlockCode: null };
    }
    log("INFO", "No saved state found for board: " + boardId + " — starting fresh");
  } catch (e) {
    log("ERROR", "Could not read state for board " + boardId + ": " + e.message);
  }
  return { state: {}, locked: false, draftHistory: [], notes: {}, playerNotes: {}, commissionerPassword: "commissioner", commissionerConfig: null, archived: false, archiveUnlockCode: null };
}

function saveState(boardId, state, locked, draftHistory, notes, playerNotes, commissionerPassword, commissionerConfig, archived, archiveUnlockCode) {
  try {
    fs.writeFileSync(stateFile(boardId), JSON.stringify({
      state:                state,
      locked:               locked,
      draftHistory:         draftHistory || [],
      notes:                notes || {},
      playerNotes:          playerNotes || {},
      commissionerPassword: commissionerPassword || "commissioner",
      commissionerConfig:   commissionerConfig || null,
      archived:             archived || false,
      archiveUnlockCode:    archiveUnlockCode || null,
    }, null, 2));
    log("INFO", "Saved state for board: " + boardId + " (" + Object.keys(state).length + " players drafted, locked: " + locked + ", archived: " + (archived || false) + ")");
  } catch (e) {
    log("ERROR", "Could not save state for board " + boardId + ": " + e.message);
  }
}

// ── In-memory state per board ─────────────────────────────────────────────────
var boardStates = {};

function getBoardState(boardId) {
  if (!boardStates[boardId]) {
    boardStates[boardId] = loadState(boardId);
  }
  return boardStates[boardId];
}

// ── Express app ───────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(express.json());

// Serve all board subdirectories under /draft
app.use("/draft", express.static(PUBLIC_DIR));

// Redirect bare root to /draft
app.get("/", (req, res) => res.redirect("/draft"));

// REST endpoint — return current state for a board
app.get("/draft/:boardId/api/state", (req, res) => {
  log("INFO", "State requested for board: " + req.params.boardId + " from " + req.ip);
  var bs = getBoardState(req.params.boardId);
  res.json({ state: bs.state, locked: bs.locked, draftHistory: bs.draftHistory });
});

// REST endpoint — return changelog
app.get("/changelog", (req, res) => {
  try {
    var data = JSON.parse(fs.readFileSync(path.join(__dirname, "changelog.json"), "utf8"));
    res.json(data);
  } catch(e) {
    log("ERROR", "Could not read changelog.json: " + e.message);
    res.status(404).json({ error: "changelog.json not found" });
  }
});

// REST endpoint — return log buffer as JSON
app.get("/api/logs", (req, res) => {
  res.json({
    uptime:   Math.floor((Date.now() - serverStartTime) / 1000),
    count:    logBuffer.length,
    max:      LOG_MAX,
    entries:  logBuffer.slice().reverse(), // newest first
  });
});

// Log viewer page
app.get("/logs", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>🥎 Draft Board — Server Logs</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; color: #111827; }
    header { background: linear-gradient(135deg, #1e1b4b 0%, #4338ca 100%); padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
    header h1 { font-size: 18px; font-weight: 800; color: #fff; }
    header .meta { font-size: 12px; color: rgba(255,255,255,0.7); margin-top: 2px; }
    .toolbar { background: #fff; border-bottom: 1px solid #e5e7eb; padding: 10px 24px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    button { padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; border: 1px solid #d1d5db; background: #fff; color: #374151; }
    button:hover { background: #f3f4f6; }
    button.primary { background: #4338ca; color: #fff; border-color: #4338ca; }
    button.primary:hover { background: #3730a3; }
    button.danger { background: #fee2e2; color: #dc2626; border-color: #fca5a5; }
    .status { font-size: 12px; color: #6b7280; margin-left: auto; }
    .status .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #16a34a; margin-right: 5px; animation: pulse 2s infinite; }
    .status .dot.paused { background: #f59e0b; animation: none; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
    .stats { display: flex; gap: 12px; padding: 12px 24px; background: #fff; border-bottom: 1px solid #e5e7eb; flex-wrap: wrap; }
    .stat { background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px 16px; text-align: center; min-width: 100px; }
    .stat .val { font-size: 20px; font-weight: 800; color: #111827; }
    .stat .lbl { font-size: 10px; font-weight: 600; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 2px; }
    .filters { padding: 10px 24px; background: #fff; border-bottom: 1px solid #e5e7eb; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .filters label { font-size: 12px; font-weight: 600; color: #6b7280; }
    .filters select, .filters input { padding: 5px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 12px; background: #fff; }
    .filters input { width: 220px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { background: #f3f4f6; padding: 8px 12px; text-align: left; font-size: 11px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.06em; position: sticky; top: 0; z-index: 1; border-bottom: 1px solid #e5e7eb; }
    td { padding: 7px 12px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
    tr:hover td { background: #f9fafb; }
    .ts { color: #9ca3af; white-space: nowrap; font-family: monospace; font-size: 11px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 10px; font-weight: 800; white-space: nowrap; }
    .badge.INFO  { background: #dbeafe; color: #1e40af; }
    .badge.WARN  { background: #fef3c7; color: #92400e; }
    .badge.ERROR { background: #fee2e2; color: #dc2626; }
    .msg { color: #111827; line-height: 1.5; word-break: break-word; }
    .msg.ERROR { color: #dc2626; font-weight: 600; }
    .empty { text-align: center; padding: 48px; color: #9ca3af; font-size: 14px; }
    .wrap { padding: 0 24px 24px; overflow-x: auto; }
    .toast { position: fixed; bottom: 20px; right: 20px; background: #111827; color: #fff; padding: 10px 18px; border-radius: 8px; font-size: 13px; font-weight: 600; opacity: 0; transition: opacity 0.3s; pointer-events: none; z-index: 999; }
    .toast.show { opacity: 1; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>🥎 Draft Board — Server Logs</h1>
      <div class="meta" id="server-meta">Loading...</div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button onclick="copyLog()" style="background:rgba(255,255,255,0.15);color:#fff;border-color:rgba(255,255,255,0.3);">📋 Copy Log</button>
      <button onclick="downloadLog()" style="background:rgba(255,255,255,0.15);color:#fff;border-color:rgba(255,255,255,0.3);">⬇ Download Log</button>
    </div>
  </header>

  <div class="toolbar">
    <button class="primary" onclick="fetchLogs()">↺ Refresh</button>
    <button id="pause-btn" onclick="togglePause()">⏸ Pause Auto-Refresh</button>
    <span class="status"><span class="dot" id="status-dot"></span><span id="status-text">Auto-refreshing every 5s</span></span>
  </div>

  <div class="stats">
    <div class="stat"><div class="val" id="stat-uptime">—</div><div class="lbl">Uptime</div></div>
    <div class="stat"><div class="val" id="stat-total">—</div><div class="lbl">Total Entries</div></div>
    <div class="stat"><div class="val" id="stat-info" style="color:#1e40af">—</div><div class="lbl">Info</div></div>
    <div class="stat"><div class="val" id="stat-warn" style="color:#92400e">—</div><div class="lbl">Warn</div></div>
    <div class="stat"><div class="val" id="stat-error" style="color:#dc2626">—</div><div class="lbl">Errors</div></div>
    <div class="stat"><div class="val" id="stat-buf">—</div><div class="lbl">Buffer</div></div>
  </div>

  <div class="filters">
    <label>Level:</label>
    <select id="filter-level" onchange="renderTable()">
      <option value="ALL">All Levels</option>
      <option value="INFO">INFO only</option>
      <option value="WARN">WARN only</option>
      <option value="ERROR">ERROR only</option>
      <option value="WARN_ERROR">WARN + ERROR</option>
    </select>
    <label>Search:</label>
    <input type="text" id="filter-search" placeholder="Filter by message..." oninput="renderTable()" />
    <button onclick="clearFilters()">Clear Filters</button>
  </div>

  <div class="wrap">
    <table>
      <thead><tr><th style="width:170px">Timestamp</th><th style="width:70px">Level</th><th>Message</th></tr></thead>
      <tbody id="log-body"></tbody>
    </table>
    <div id="empty-msg" class="empty" style="display:none">No log entries match your filters.</div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    var allEntries = [];
    var paused = false;
    var timer = null;

    function formatUptime(secs) {
      var d = Math.floor(secs / 86400);
      var h = Math.floor((secs % 86400) / 3600);
      var m = Math.floor((secs % 3600) / 60);
      var s = secs % 60;
      if (d > 0) return d + "d " + h + "h " + m + "m";
      if (h > 0) return h + "h " + m + "m " + s + "s";
      if (m > 0) return m + "m " + s + "s";
      return s + "s";
    }

    function formatTs(iso) {
      var d = new Date(iso);
      return d.toLocaleDateString() + " " + d.toLocaleTimeString();
    }

    function fetchLogs() {
      fetch("/api/logs")
        .then(function(r) { return r.json(); })
        .then(function(data) {
          allEntries = data.entries || [];
          document.getElementById("stat-uptime").textContent  = formatUptime(data.uptime);
          document.getElementById("stat-total").textContent   = data.count;
          document.getElementById("stat-buf").textContent     = data.count + "/" + data.max;
          document.getElementById("stat-info").textContent    = allEntries.filter(function(e) { return e.level === "INFO";  }).length;
          document.getElementById("stat-warn").textContent    = allEntries.filter(function(e) { return e.level === "WARN";  }).length;
          document.getElementById("stat-error").textContent   = allEntries.filter(function(e) { return e.level === "ERROR"; }).length;
          document.getElementById("server-meta").textContent  = "Server uptime: " + formatUptime(data.uptime) + "  ·  Buffer: " + data.count + "/" + data.max + " entries";
          renderTable();
        })
        .catch(function() {
          document.getElementById("server-meta").textContent = "⚠️ Could not reach server";
        });
    }

    function renderTable() {
      var level  = document.getElementById("filter-level").value;
      var search = document.getElementById("filter-search").value.toLowerCase();
      var filtered = allEntries.filter(function(e) {
        if (level === "WARN_ERROR" && e.level !== "WARN" && e.level !== "ERROR") return false;
        if (level !== "ALL" && level !== "WARN_ERROR" && e.level !== level) return false;
        if (search && e.message.toLowerCase().indexOf(search) === -1) return false;
        return true;
      });
      var tbody = document.getElementById("log-body");
      var empty = document.getElementById("empty-msg");
      if (filtered.length === 0) {
        tbody.innerHTML = "";
        empty.style.display = "block";
        return;
      }
      empty.style.display = "none";
      tbody.innerHTML = filtered.map(function(e) {
        return "<tr>" +
          "<td class='ts'>" + formatTs(e.ts) + "</td>" +
          "<td><span class='badge " + e.level + "'>" + e.level + "</span></td>" +
          "<td class='msg " + (e.level === "ERROR" ? "ERROR" : "") + "'>" + escHtml(e.message) + "</td>" +
          "</tr>";
      }).join("");
    }

    function escHtml(str) {
      return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    }

    function togglePause() {
      paused = !paused;
      var btn  = document.getElementById("pause-btn");
      var dot  = document.getElementById("status-dot");
      var text = document.getElementById("status-text");
      if (paused) {
        btn.textContent = "▶ Resume Auto-Refresh";
        dot.className = "dot paused";
        text.textContent = "Paused";
        clearInterval(timer);
      } else {
        btn.textContent = "⏸ Pause Auto-Refresh";
        dot.className = "dot";
        text.textContent = "Auto-refreshing every 5s";
        fetchLogs();
        timer = setInterval(fetchLogs, 5000);
      }
    }

    function clearFilters() {
      document.getElementById("filter-level").value = "ALL";
      document.getElementById("filter-search").value = "";
      renderTable();
    }

    function buildPlainText() {
      var lines = ["Draft Board Server Log — " + new Date().toLocaleString(), ""];
      allEntries.slice().reverse().forEach(function(e) {
        lines.push("[" + e.ts + "] [" + e.level + "] " + e.message);
      });
      return lines.join("\\n");
    }

    function copyLog() {
      var text = buildPlainText();
      navigator.clipboard.writeText(text).then(function() {
        showToast("✅ Log copied to clipboard");
      }).catch(function() {
        showToast("⚠️ Copy failed — try Download instead");
      });
    }

    function downloadLog() {
      var text = buildPlainText();
      var blob = new Blob([text], { type: "text/plain" });
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement("a");
      a.href = url;
      a.download = "draft-board-log-" + new Date().toISOString().slice(0,19).replace(/:/g,"-") + ".txt";
      a.click();
      URL.revokeObjectURL(url);
      showToast("⬇ Log downloaded");
    }

    function showToast(msg) {
      var t = document.getElementById("toast");
      t.textContent = msg;
      t.classList.add("show");
      setTimeout(function() { t.classList.remove("show"); }, 2500);
    }

    fetchLogs();
    timer = setInterval(fetchLogs, 5000);
  </script>
</body>
</html>`);
});

// ── Commissioner endpoints ────────────────────────────────────────────────────

// Verify commissioner password
app.post("/draft/:boardId/api/commissioner/verify", (req, res) => {
  var boardId = req.params.boardId;
  var bs = getBoardState(boardId);
  var provided = (req.body && req.body.password) ? req.body.password : "";
  if (provided === bs.commissionerPassword) {
    log("INFO", "Commissioner authenticated for board: " + boardId + " from " + req.ip);
    res.json({ ok: true });
  } else {
    log("WARN", "Commissioner auth failed for board: " + boardId + " from " + req.ip);
    res.status(401).json({ ok: false, error: "Incorrect password" });
  }
});

// Save commissioner config (league info, teams, eval stations, players)
app.post("/draft/:boardId/api/commissioner/settings", (req, res) => {
  var boardId = req.params.boardId;
  var bs = getBoardState(boardId);
  var provided = (req.body && req.body.password) ? req.body.password : "";
  if (provided !== bs.commissionerPassword) {
    log("WARN", "Commissioner settings save rejected — bad password for board: " + boardId);
    return res.status(401).json({ ok: false, error: "Incorrect password" });
  }
  var cfg = req.body.config;
  if (!cfg || typeof cfg !== "object") {
    return res.status(400).json({ ok: false, error: "Missing config payload" });
  }
  bs.commissionerConfig = cfg;
  saveState(boardId, bs.state, bs.locked, bs.draftHistory, bs.notes, bs.playerNotes, bs.commissionerPassword, bs.commissionerConfig, bs.archived, bs.archiveUnlockCode);
  var payload = fullStatePayload(boardId, bs);
  wss.clients.forEach(function(client) {
    if (client.readyState === WebSocket.OPEN && clientBoards.get(client) === boardId) {
      client.send(payload);
    }
  });
  log("INFO", "Commissioner config saved for board: " + boardId + " — " + (cfg.players ? cfg.players.length : 0) + " players, " + (cfg.teams ? cfg.teams.length : 0) + " teams");
  res.json({ ok: true });
});

// Change commissioner password
app.post("/draft/:boardId/api/commissioner/password", (req, res) => {
  var boardId = req.params.boardId;
  var bs = getBoardState(boardId);
  var current  = (req.body && req.body.currentPassword)  ? req.body.currentPassword  : "";
  var newPass  = (req.body && req.body.newPassword)       ? req.body.newPassword       : "";
  if (current !== bs.commissionerPassword) {
    log("WARN", "Commissioner password change rejected — bad current password for board: " + boardId);
    return res.status(401).json({ ok: false, error: "Current password is incorrect" });
  }
  if (!newPass || newPass.trim().length < 4) {
    return res.status(400).json({ ok: false, error: "New password must be at least 4 characters" });
  }
  bs.commissionerPassword = newPass.trim();
  saveState(boardId, bs.state, bs.locked, bs.draftHistory, bs.notes, bs.playerNotes, bs.commissionerPassword, bs.commissionerConfig, bs.archived, bs.archiveUnlockCode);
  log("INFO", "Commissioner password changed for board: " + boardId);
  res.json({ ok: true });
});

// Reset commissioner password to default (no current password required — requires confirmation phrase)
app.post("/draft/:boardId/api/commissioner/reset-password", (req, res) => {
  var boardId = req.params.boardId;
  var bs = getBoardState(boardId);
  var confirmPhrase = (req.body && req.body.confirmPhrase) ? req.body.confirmPhrase.trim() : "";
  if (confirmPhrase !== "RESET PASSWORD") {
    log("WARN", "Commissioner password reset rejected — wrong confirmation phrase for board: " + boardId);
    return res.status(400).json({ ok: false, error: "Incorrect confirmation phrase" });
  }
  bs.commissionerPassword = "commissioner";
  saveState(boardId, bs.state, bs.locked, bs.draftHistory, bs.notes, bs.playerNotes, bs.commissionerPassword, bs.commissionerConfig, bs.archived, bs.archiveUnlockCode);
  log("INFO", "Commissioner password reset to default for board: " + boardId);
  res.json({ ok: true });
});

// ── Commissioner Board Settings endpoints ─────────────────────────────────────

// Lock / Unlock board
app.post("/draft/:boardId/api/commissioner/lock", (req, res) => {
  var boardId = req.params.boardId;
  var bs = getBoardState(boardId);
  var provided = (req.body && req.body.password) ? req.body.password : "";
  if (provided !== bs.commissionerPassword) {
    log("WARN", "Commissioner lock rejected — bad password for board: " + boardId);
    return res.status(401).json({ ok: false, error: "Incorrect password" });
  }
  if (bs.archived) return res.status(400).json({ ok: false, error: "Board is archived and cannot be modified" });
  bs.locked = req.body.locked === true;
  saveState(boardId, bs.state, bs.locked, bs.draftHistory, bs.notes, bs.playerNotes, bs.commissionerPassword, bs.commissionerConfig, bs.archived, bs.archiveUnlockCode);
  var payload = fullStatePayload(boardId, bs);
  wss.clients.forEach(function(client) {
    if (client.readyState === WebSocket.OPEN && clientBoards.get(client) === boardId) client.send(payload);
  });
  log("INFO", "Commissioner " + (bs.locked ? "locked" : "unlocked") + " board: " + boardId);
  res.json({ ok: true, locked: bs.locked });
});

// Reset Draft (picks + history only — preserves position tags)
app.post("/draft/:boardId/api/commissioner/reset", (req, res) => {
  var boardId = req.params.boardId;
  var bs = getBoardState(boardId);
  var provided = (req.body && req.body.password) ? req.body.password : "";
  if (provided !== bs.commissionerPassword) {
    log("WARN", "Commissioner reset rejected — bad password for board: " + boardId);
    return res.status(401).json({ ok: false, error: "Incorrect password" });
  }
  if (bs.archived) return res.status(400).json({ ok: false, error: "Board is archived and cannot be modified" });
  // Preserve position tags — keep only entries that have positions
  var preserved = {};
  Object.keys(bs.state).forEach(function(name) {
    if (bs.state[name].positions && bs.state[name].positions.length > 0) {
      preserved[name] = { positions: bs.state[name].positions };
    }
  });
  bs.state = preserved;
  bs.draftHistory = [];
  bs.locked = false;
  saveState(boardId, bs.state, bs.locked, bs.draftHistory, bs.notes, bs.playerNotes, bs.commissionerPassword, bs.commissionerConfig, bs.archived, bs.archiveUnlockCode);
  var payload = fullStatePayload(boardId, bs);
  wss.clients.forEach(function(client) {
    if (client.readyState === WebSocket.OPEN && clientBoards.get(client) === boardId) client.send(payload);
  });
  log("INFO", "Commissioner reset draft for board: " + boardId + " — position tags preserved");
  res.json({ ok: true });
});

// Full Reset (clears everything — picks, history, notes, position tags)
app.post("/draft/:boardId/api/commissioner/fullreset", (req, res) => {
  var boardId = req.params.boardId;
  var bs = getBoardState(boardId);
  var provided = (req.body && req.body.password) ? req.body.password : "";
  if (provided !== bs.commissionerPassword) {
    log("WARN", "Commissioner full reset rejected — bad password for board: " + boardId);
    return res.status(401).json({ ok: false, error: "Incorrect password" });
  }
  if (bs.archived) return res.status(400).json({ ok: false, error: "Board is archived and cannot be modified" });
  bs.state = {};
  bs.draftHistory = [];
  bs.notes = {};
  bs.playerNotes = {};
  bs.locked = false;
  saveState(boardId, bs.state, bs.locked, bs.draftHistory, bs.notes, bs.playerNotes, bs.commissionerPassword, bs.commissionerConfig, bs.archived, bs.archiveUnlockCode);
  var payload = fullStatePayload(boardId, bs);
  wss.clients.forEach(function(client) {
    if (client.readyState === WebSocket.OPEN && clientBoards.get(client) === boardId) client.send(payload);
  });
  log("INFO", "Commissioner full reset for board: " + boardId + " — all picks, history, notes, and position tags cleared");
  res.json({ ok: true });
});

// New Season / Factory Reset (wipes everything including commissioner config and password)
app.post("/draft/:boardId/api/commissioner/factoryreset", (req, res) => {
  var boardId = req.params.boardId;
  var bs = getBoardState(boardId);
  var provided = (req.body && req.body.password) ? req.body.password : "";
  if (provided !== bs.commissionerPassword) {
    log("WARN", "Commissioner factory reset rejected — bad password for board: " + boardId);
    return res.status(401).json({ ok: false, error: "Incorrect password" });
  }
  var confirmText = (req.body && req.body.confirmText) ? req.body.confirmText : "";
  if (confirmText !== "NEW SEASON") {
    return res.status(400).json({ ok: false, error: "Confirmation text incorrect" });
  }
  bs.state = {};
  bs.draftHistory = [];
  bs.notes = {};
  bs.playerNotes = {};
  bs.locked = false;
  bs.archived = false;
  bs.archiveUnlockCode = null;
  bs.commissionerConfig = null;
  bs.commissionerPassword = "commissioner";
  saveState(boardId, bs.state, bs.locked, bs.draftHistory, bs.notes, bs.playerNotes, bs.commissionerPassword, bs.commissionerConfig, bs.archived, bs.archiveUnlockCode);
  var payload = fullStatePayload(boardId, bs);
  wss.clients.forEach(function(client) {
    if (client.readyState === WebSocket.OPEN && clientBoards.get(client) === boardId) client.send(payload);
  });
  log("INFO", "Commissioner factory reset for board: " + boardId + " — all data, config, and password wiped");
  res.json({ ok: true });
});

// Archive board
app.post("/draft/:boardId/api/commissioner/archive", (req, res) => {
  var boardId = req.params.boardId;
  var bs = getBoardState(boardId);
  var provided = (req.body && req.body.password) ? req.body.password : "";
  if (provided !== bs.commissionerPassword) {
    log("WARN", "Commissioner archive rejected — bad password for board: " + boardId);
    return res.status(401).json({ ok: false, error: "Incorrect password" });
  }
  var unlockCode = (req.body && req.body.unlockCode) ? req.body.unlockCode.trim() : "";
  if (!unlockCode || unlockCode.length < 4) {
    return res.status(400).json({ ok: false, error: "Archive unlock code must be at least 4 characters" });
  }
  bs.archived = true;
  bs.locked = true;
  bs.archiveUnlockCode = unlockCode;
  saveState(boardId, bs.state, bs.locked, bs.draftHistory, bs.notes, bs.playerNotes, bs.commissionerPassword, bs.commissionerConfig, bs.archived, bs.archiveUnlockCode);
  var payload = fullStatePayload(boardId, bs);
  wss.clients.forEach(function(client) {
    if (client.readyState === WebSocket.OPEN && clientBoards.get(client) === boardId) client.send(payload);
  });
  log("INFO", "Board archived: " + boardId);
  res.json({ ok: true });
});

// Unarchive board (requires unlock code)
app.post("/draft/:boardId/api/commissioner/unarchive", (req, res) => {
  var boardId = req.params.boardId;
  var bs = getBoardState(boardId);
  var provided = (req.body && req.body.password) ? req.body.password : "";
  if (provided !== bs.commissionerPassword) {
    log("WARN", "Commissioner unarchive rejected — bad password for board: " + boardId);
    return res.status(401).json({ ok: false, error: "Incorrect password" });
  }
  if (!bs.archived) return res.status(400).json({ ok: false, error: "Board is not archived" });
  var unlockCode = (req.body && req.body.unlockCode) ? req.body.unlockCode.trim() : "";
  if (unlockCode !== bs.archiveUnlockCode) {
    log("WARN", "Commissioner unarchive rejected — bad unlock code for board: " + boardId);
    return res.status(401).json({ ok: false, error: "Incorrect archive unlock code" });
  }
  bs.archived = false;
  bs.locked = false;
  bs.archiveUnlockCode = null;
  saveState(boardId, bs.state, bs.locked, bs.draftHistory, bs.notes, bs.playerNotes, bs.commissionerPassword, bs.commissionerConfig, bs.archived, bs.archiveUnlockCode);
  var payload = fullStatePayload(boardId, bs);
  wss.clients.forEach(function(client) {
    if (client.readyState === WebSocket.OPEN && clientBoards.get(client) === boardId) client.send(payload);
  });
  log("INFO", "Board unarchived: " + boardId);
  res.json({ ok: true });
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

var clientBoards = new Map();

function fullStatePayload(boardId, bs) {
  return JSON.stringify({
    type:               "FULL_STATE",
    boardId:            boardId,
    state:              bs.state,
    locked:             bs.locked,
    draftHistory:       bs.draftHistory,
    notes:              bs.notes || {},
    playerNotes:        bs.playerNotes || {},
    commissionerConfig: bs.commissionerConfig || null,
    archived:           bs.archived || false,
  });
}

function broadcastToBoard(boardId, data, senderSocket) {
  var msg = typeof data === "string" ? data : JSON.stringify(data);
  var count = 0;
  wss.clients.forEach(function(client) {
    if (client !== senderSocket && client.readyState === WebSocket.OPEN && clientBoards.get(client) === boardId) {
      client.send(msg);
      count++;
    }
  });
  return count;
}

wss.on("connection", function(ws) {
  log("INFO", "Client connected — total connections: " + wss.clients.size);

  ws.on("message", function(raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch (e) {
      log("WARN", "Received malformed WebSocket message — could not parse JSON");
      return;
    }

    if (msg.type === "SUBSCRIBE") {
      var boardId = msg.boardId;
      if (!boardId) { log("WARN", "SUBSCRIBE received with no boardId — ignoring"); return; }
      clientBoards.set(ws, boardId);
      var bs = getBoardState(boardId);
      log("INFO", "Client subscribed to board: " + boardId + " — sent FULL_STATE (" + Object.keys(bs.state).length + " players)");
      ws.send(fullStatePayload(boardId, bs));
    }

    if (msg.type === "UPDATE") {
      var boardId = clientBoards.get(ws);
      if (!boardId) { log("WARN", "UPDATE received from unsubscribed client — ignoring"); return; }
      var bs = getBoardState(boardId);
      if (bs.archived) { log("WARN", "UPDATE rejected — board " + boardId + " is archived"); return; }
      bs.state = msg.drafted;
      if (typeof msg.locked === "boolean") bs.locked = msg.locked;
      if (Array.isArray(msg.draftHistory)) bs.draftHistory = msg.draftHistory;
      saveState(boardId, bs.state, bs.locked, bs.draftHistory, bs.notes, bs.playerNotes, bs.commissionerPassword, bs.commissionerConfig, bs.archived, bs.archiveUnlockCode);
      var broadcast = broadcastToBoard(boardId, fullStatePayload(boardId, bs), ws);
      log("INFO", "UPDATE for board: " + boardId + " — broadcasted to " + broadcast + " other client(s)");
    }

    if (msg.type === "UPDATE_NOTES") {
      var boardId = clientBoards.get(ws);
      if (!boardId) { log("WARN", "UPDATE_NOTES received from unsubscribed client — ignoring"); return; }
      if (!msg.team) { log("WARN", "UPDATE_NOTES received with no team — ignoring"); return; }
      var bs = getBoardState(boardId);
      if (bs.archived) { log("WARN", "UPDATE_NOTES rejected — board " + boardId + " is archived"); return; }
      if (!bs.notes) bs.notes = {};
      bs.notes[msg.team] = msg.content || "";
      saveState(boardId, bs.state, bs.locked, bs.draftHistory, bs.notes, bs.playerNotes, bs.commissionerPassword, bs.commissionerConfig, bs.archived, bs.archiveUnlockCode);
      var broadcast = broadcastToBoard(boardId, fullStatePayload(boardId, bs), ws);
      log("INFO", "UPDATE_NOTES for board: " + boardId + " team: " + msg.team + " — broadcasted to " + broadcast + " other client(s)");
    }

    if (msg.type === "UPDATE_PLAYER_NOTE") {
      var boardId = clientBoards.get(ws);
      if (!boardId) { log("WARN", "UPDATE_PLAYER_NOTE received from unsubscribed client — ignoring"); return; }
      if (!msg.teamId || !msg.playerId) { log("WARN", "UPDATE_PLAYER_NOTE received with missing teamId or playerId — ignoring"); return; }
      var bs = getBoardState(boardId);
      if (bs.archived) { log("WARN", "UPDATE_PLAYER_NOTE rejected — board " + boardId + " is archived"); return; }
      if (!bs.playerNotes) bs.playerNotes = {};
      if (!bs.playerNotes[msg.teamId]) bs.playerNotes[msg.teamId] = {};
      bs.playerNotes[msg.teamId][msg.playerId] = msg.note || "";
      saveState(boardId, bs.state, bs.locked, bs.draftHistory, bs.notes, bs.playerNotes, bs.commissionerPassword, bs.commissionerConfig, bs.archived, bs.archiveUnlockCode);
      var broadcast = broadcastToBoard(boardId, fullStatePayload(boardId, bs), ws);
      log("INFO", "UPDATE_PLAYER_NOTE for board: " + boardId + " team: " + msg.teamId + " player: " + msg.playerId + " — broadcasted to " + broadcast + " other client(s)");
    }
  });

  ws.on("close", function() {
    var boardId = clientBoards.get(ws) || "unknown";
    clientBoards.delete(ws);
    log("INFO", "Client disconnected from board: " + boardId + " — total connections: " + wss.clients.size);
  });

  ws.on("error", function(err) {
    log("ERROR", "WebSocket error: " + err.message);
  });
});

server.listen(PORT, function() {
  log("INFO", "═══════════════════════════════════════════════");
  log("INFO", "Draft Board server started on port " + PORT);
  var localIP = getLocalIP();
  log("INFO", "Local access:  http://" + localIP + ":" + PORT + "/draft");
  log("INFO", "Log viewer:    http://" + localIP + ":" + PORT + "/logs");
  log("INFO", "Log buffer:    " + LOG_MAX + " entries max");
  log("INFO", "═══════════════════════════════════════════════");
});
