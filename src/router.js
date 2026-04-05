"use strict";

const express = require("express");
const fs      = require("fs");
const path    = require("path");
const router  = express.Router();

const { getBoardState, saveState } = require("./state");

// log is injected at mount time via router.use
var _log = function() {};
router.use(function(req, res, next) { next(); }); // placeholder — log injected by host

// Helper to get the shared log function injected by host server
function log(level, msg) { _log(level, msg); }

// ── Inject log function from host ─────────────────────────────────────────────
router.setLog = function(logFn) { _log = logFn; };

// ── Shared broadcaster (injected by host) ─────────────────────────────────────
var _broadcast = function() {};
router.setBroadcast = function(fn) { _broadcast = fn; };

// ── Changelog ─────────────────────────────────────────────────────────────────
router.get("/changelog", (req, res) => {
  try {
    var data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "changelog.json"), "utf8"));
    res.json(data);
  } catch (e) {
    log("ERROR", "[DraftKit] Could not read changelog: " + e.message);
    res.status(404).json({ error: "changelog.json not found" });
  }
});

// ── State ─────────────────────────────────────────────────────────────────────
router.get("/:boardId/api/state", (req, res) => {
  log("INFO", "[DraftKit] State requested for board: " + req.params.boardId + " from " + req.ip);
  var bs = getBoardState(req.params.boardId, log);
  res.json({ state: bs.state, locked: bs.locked, draftHistory: bs.draftHistory });
});

// ── Commissioner: verify ──────────────────────────────────────────────────────
router.post("/:boardId/api/commissioner/verify", (req, res) => {
  var boardId  = req.params.boardId;
  var bs       = getBoardState(boardId, log);
  var provided = (req.body && req.body.password) ? req.body.password : "";
  if (provided === bs.commissionerPassword) {
    log("INFO", "[DraftKit] Commissioner verified for board: " + boardId);
    res.json({ ok: true });
  } else {
    log("WARN", "[DraftKit] Commissioner verify failed for board: " + boardId);
    res.status(401).json({ ok: false, error: "Incorrect password" });
  }
});

// ── Commissioner: save settings ───────────────────────────────────────────────
router.post("/:boardId/api/commissioner/settings", (req, res) => {
  var boardId  = req.params.boardId;
  var bs       = getBoardState(boardId, log);
  var provided = (req.body && req.body.password) ? req.body.password : "";
  if (provided !== bs.commissionerPassword) {
    log("WARN", "[DraftKit] Commissioner settings rejected — bad password for board: " + boardId);
    return res.status(401).json({ ok: false, error: "Incorrect password" });
  }
  var cfg = req.body.config;
  if (!cfg || typeof cfg !== "object") return res.status(400).json({ ok: false, error: "Missing config payload" });
  bs.commissionerConfig = cfg;
  saveState(boardId, bs, log);
  _broadcast(boardId);
  log("INFO", "[DraftKit] Commissioner config saved for board: " + boardId +
    " — " + (cfg.players ? cfg.players.length : 0) + " players, " +
    (cfg.teams ? cfg.teams.length : 0) + " teams");
  res.json({ ok: true });
});

// ── Commissioner: change password ─────────────────────────────────────────────
router.post("/:boardId/api/commissioner/password", (req, res) => {
  var boardId  = req.params.boardId;
  var bs       = getBoardState(boardId, log);
  var current  = (req.body && req.body.currentPassword) ? req.body.currentPassword : "";
  var newPass  = (req.body && req.body.newPassword)      ? req.body.newPassword      : "";
  if (current !== bs.commissionerPassword) {
    log("WARN", "[DraftKit] Password change rejected for board: " + boardId);
    return res.status(401).json({ ok: false, error: "Current password is incorrect" });
  }
  if (!newPass || newPass.trim().length < 4) return res.status(400).json({ ok: false, error: "New password must be at least 4 characters" });
  bs.commissionerPassword = newPass.trim();
  saveState(boardId, bs, log);
  log("INFO", "[DraftKit] Commissioner password changed for board: " + boardId);
  res.json({ ok: true });
});

// ── Commissioner: reset password ──────────────────────────────────────────────
router.post("/:boardId/api/commissioner/reset-password", (req, res) => {
  var boardId       = req.params.boardId;
  var bs            = getBoardState(boardId, log);
  var confirmPhrase = (req.body && req.body.confirmPhrase) ? req.body.confirmPhrase.trim() : "";
  if (confirmPhrase !== "RESET PASSWORD") {
    log("WARN", "[DraftKit] Password reset rejected for board: " + boardId);
    return res.status(400).json({ ok: false, error: "Incorrect confirmation phrase" });
  }
  bs.commissionerPassword = "commissioner";
  saveState(boardId, bs, log);
  log("INFO", "[DraftKit] Commissioner password reset to default for board: " + boardId);
  res.json({ ok: true });
});

// ── Commissioner: lock/unlock ─────────────────────────────────────────────────
router.post("/:boardId/api/commissioner/lock", (req, res) => {
  var boardId  = req.params.boardId;
  var bs       = getBoardState(boardId, log);
  var provided = (req.body && req.body.password) ? req.body.password : "";
  if (provided !== bs.commissionerPassword) {
    log("WARN", "[DraftKit] Lock rejected for board: " + boardId);
    return res.status(401).json({ ok: false, error: "Incorrect password" });
  }
  if (bs.archived) return res.status(400).json({ ok: false, error: "Board is archived and cannot be modified" });
  bs.locked = req.body.locked === true;
  saveState(boardId, bs, log);
  _broadcast(boardId);
  log("INFO", "[DraftKit] Commissioner " + (bs.locked ? "locked" : "unlocked") + " board: " + boardId);
  res.json({ ok: true, locked: bs.locked });
});

// ── Commissioner: reset draft ─────────────────────────────────────────────────
router.post("/:boardId/api/commissioner/reset", (req, res) => {
  var boardId  = req.params.boardId;
  var bs       = getBoardState(boardId, log);
  var provided = (req.body && req.body.password) ? req.body.password : "";
  if (provided !== bs.commissionerPassword) {
    log("WARN", "[DraftKit] Reset rejected for board: " + boardId);
    return res.status(401).json({ ok: false, error: "Incorrect password" });
  }
  if (bs.archived) return res.status(400).json({ ok: false, error: "Board is archived and cannot be modified" });
  var preserved = {};
  Object.keys(bs.state).forEach(function(name) {
    if (bs.state[name].positions && bs.state[name].positions.length > 0) {
      preserved[name] = { positions: bs.state[name].positions };
    }
  });
  bs.state = preserved;
  bs.draftHistory = [];
  bs.locked = false;
  saveState(boardId, bs, log);
  _broadcast(boardId);
  log("INFO", "[DraftKit] Commissioner reset draft for board: " + boardId + " — position tags preserved");
  res.json({ ok: true });
});

// ── Commissioner: full reset ──────────────────────────────────────────────────
router.post("/:boardId/api/commissioner/fullreset", (req, res) => {
  var boardId  = req.params.boardId;
  var bs       = getBoardState(boardId, log);
  var provided = (req.body && req.body.password) ? req.body.password : "";
  if (provided !== bs.commissionerPassword) {
    log("WARN", "[DraftKit] Full reset rejected for board: " + boardId);
    return res.status(401).json({ ok: false, error: "Incorrect password" });
  }
  if (bs.archived) return res.status(400).json({ ok: false, error: "Board is archived and cannot be modified" });
  bs.state = {};
  bs.draftHistory = [];
  bs.notes = {};
  bs.playerNotes = {};
  bs.locked = false;
  saveState(boardId, bs, log);
  _broadcast(boardId);
  log("INFO", "[DraftKit] Commissioner full reset for board: " + boardId);
  res.json({ ok: true });
});

// ── Commissioner: factory reset (new season) ──────────────────────────────────
router.post("/:boardId/api/commissioner/factoryreset", (req, res) => {
  var boardId     = req.params.boardId;
  var bs          = getBoardState(boardId, log);
  var provided    = (req.body && req.body.password)    ? req.body.password    : "";
  var confirmText = (req.body && req.body.confirmText) ? req.body.confirmText : "";
  if (provided !== bs.commissionerPassword) {
    log("WARN", "[DraftKit] Factory reset rejected for board: " + boardId);
    return res.status(401).json({ ok: false, error: "Incorrect password" });
  }
  if (confirmText !== "NEW SEASON") return res.status(400).json({ ok: false, error: "Confirmation text incorrect" });
  bs.state = {};
  bs.draftHistory = [];
  bs.notes = {};
  bs.playerNotes = {};
  bs.locked = false;
  bs.archived = false;
  bs.archiveUnlockCode = null;
  bs.commissionerConfig = null;
  bs.commissionerPassword = "commissioner";
  saveState(boardId, bs, log);
  _broadcast(boardId);
  log("INFO", "[DraftKit] Commissioner factory reset for board: " + boardId);
  res.json({ ok: true });
});

// ── Commissioner: archive ─────────────────────────────────────────────────────
router.post("/:boardId/api/commissioner/archive", (req, res) => {
  var boardId    = req.params.boardId;
  var bs         = getBoardState(boardId, log);
  var provided   = (req.body && req.body.password)    ? req.body.password    : "";
  var unlockCode = (req.body && req.body.unlockCode)  ? req.body.unlockCode.trim() : "";
  if (provided !== bs.commissionerPassword) {
    log("WARN", "[DraftKit] Archive rejected for board: " + boardId);
    return res.status(401).json({ ok: false, error: "Incorrect password" });
  }
  if (!unlockCode || unlockCode.length < 4) return res.status(400).json({ ok: false, error: "Archive unlock code must be at least 4 characters" });
  bs.archived = true;
  bs.locked = true;
  bs.archiveUnlockCode = unlockCode;
  saveState(boardId, bs, log);
  _broadcast(boardId);
  log("INFO", "[DraftKit] Board archived: " + boardId);
  res.json({ ok: true });
});

// ── Commissioner: unarchive ───────────────────────────────────────────────────
router.post("/:boardId/api/commissioner/unarchive", (req, res) => {
  var boardId    = req.params.boardId;
  var bs         = getBoardState(boardId, log);
  var provided   = (req.body && req.body.password)   ? req.body.password   : "";
  var unlockCode = (req.body && req.body.unlockCode) ? req.body.unlockCode.trim() : "";
  if (provided !== bs.commissionerPassword) {
    log("WARN", "[DraftKit] Unarchive rejected for board: " + boardId);
    return res.status(401).json({ ok: false, error: "Incorrect password" });
  }
  if (!bs.archived) return res.status(400).json({ ok: false, error: "Board is not archived" });
  if (unlockCode !== bs.archiveUnlockCode) {
    log("WARN", "[DraftKit] Unarchive rejected — bad unlock code for board: " + boardId);
    return res.status(401).json({ ok: false, error: "Incorrect archive unlock code" });
  }
  bs.archived = false;
  bs.locked = false;
  bs.archiveUnlockCode = null;
  saveState(boardId, bs, log);
  _broadcast(boardId);
  log("INFO", "[DraftKit] Board unarchived: " + boardId);
  res.json({ ok: true });
});

module.exports = router;
