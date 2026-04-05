"use strict";

const fs   = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");

// ── Ensure data directory exists ──────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ── Fresh state defaults ──────────────────────────────────────────────────────
const DEFAULTS = {
  state:                {},
  locked:               false,
  draftHistory:         [],
  notes:                {},
  playerNotes:          {},
  commissionerPassword: "commissioner",
  commissionerConfig:   null,
  archived:             false,
  archiveUnlockCode:    null,
};

// ── In-memory cache ───────────────────────────────────────────────────────────
var boardStates = {};

// ── Helpers ───────────────────────────────────────────────────────────────────
function stateFile(boardId) {
  var safe = boardId.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(DATA_DIR, safe + ".json");
}

function loadState(boardId, log) {
  try {
    var file = stateFile(boardId);
    if (fs.existsSync(file)) {
      var saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved && typeof saved.locked === "boolean") {
        log("INFO", "[DraftKit] Loaded state for board: " + boardId);
        return Object.assign({}, DEFAULTS, saved);
      }
      log("INFO", "[DraftKit] Loaded legacy state for board: " + boardId);
      return Object.assign({}, DEFAULTS, { state: saved });
    }
    log("INFO", "[DraftKit] No saved state for board: " + boardId + " — starting fresh");
  } catch (e) {
    log("ERROR", "[DraftKit] Could not read state for board " + boardId + ": " + e.message);
  }
  return Object.assign({}, DEFAULTS);
}

function saveState(boardId, bs, log) {
  try {
    fs.writeFileSync(stateFile(boardId), JSON.stringify(bs, null, 2));
    log("INFO", "[DraftKit] Saved state for board: " + boardId +
      " (" + Object.keys(bs.state).length + " players drafted" +
      ", locked: " + bs.locked +
      ", archived: " + bs.archived + ")");
  } catch (e) {
    log("ERROR", "[DraftKit] Could not save state for board " + boardId + ": " + e.message);
  }
}

function getBoardState(boardId, log) {
  if (!boardStates[boardId]) {
    boardStates[boardId] = loadState(boardId, log);
  }
  return boardStates[boardId];
}

module.exports = { getBoardState, saveState, DEFAULTS };
