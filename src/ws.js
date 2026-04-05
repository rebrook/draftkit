"use strict";

const { getBoardState, saveState } = require("./state");

// ── DraftKit FULL_STATE payload ───────────────────────────────────────────────
function statePayload(boardId, bs) {
  return JSON.stringify({
    type:               "FULL_STATE",
    boardId:            boardId,
    state:              bs.state,
    locked:             bs.locked,
    draftHistory:       bs.draftHistory,
    notes:              bs.notes              || {},
    playerNotes:        bs.playerNotes        || {},
    commissionerConfig: bs.commissionerConfig || null,
    archived:           bs.archived           || false,
  });
}

// ── WebSocket message handler ─────────────────────────────────────────────────
function handleMessage(ws, msg, context) {
  var log           = context.log;
  var clientBoards  = context.clientBoards;
  var broadcastToBoard = context.broadcastToBoard;

  if (msg.type === "SUBSCRIBE") {
    var boardId = msg.boardId;
    if (!boardId) { log("WARN", "[DraftKit] SUBSCRIBE received with no boardId — ignoring"); return; }
    clientBoards.set(ws, boardId);
    var bs = getBoardState(boardId, log);
    log("INFO", "[DraftKit] Client subscribed to board: " + boardId +
      " — sent FULL_STATE (" + Object.keys(bs.state).length + " players)");
    ws.send(statePayload(boardId, bs));
  }

  if (msg.type === "UPDATE") {
    var boardId = clientBoards.get(ws);
    if (!boardId) { log("WARN", "[DraftKit] UPDATE received from unsubscribed client — ignoring"); return; }
    var bs = getBoardState(boardId, log);
    if (bs.archived) { log("WARN", "[DraftKit] UPDATE rejected — board " + boardId + " is archived"); return; }
    bs.state = msg.drafted;
    if (typeof msg.locked === "boolean") bs.locked = msg.locked;
    if (Array.isArray(msg.draftHistory)) bs.draftHistory = msg.draftHistory;
    saveState(boardId, bs, log);
    var count = broadcastToBoard(boardId, statePayload(boardId, bs), ws);
    log("INFO", "[DraftKit] UPDATE for board: " + boardId + " — broadcasted to " + count + " other client(s)");
  }

  if (msg.type === "UPDATE_NOTES") {
    var boardId = clientBoards.get(ws);
    if (!boardId) { log("WARN", "[DraftKit] UPDATE_NOTES received from unsubscribed client — ignoring"); return; }
    if (!msg.team) { log("WARN", "[DraftKit] UPDATE_NOTES received with no team — ignoring"); return; }
    var bs = getBoardState(boardId, log);
    if (bs.archived) { log("WARN", "[DraftKit] UPDATE_NOTES rejected — board " + boardId + " is archived"); return; }
    if (!bs.notes) bs.notes = {};
    bs.notes[msg.team] = msg.content || "";
    saveState(boardId, bs, log);
    var count = broadcastToBoard(boardId, statePayload(boardId, bs), ws);
    log("INFO", "[DraftKit] UPDATE_NOTES for board: " + boardId + " team: " + msg.team + " — broadcasted to " + count + " other client(s)");
  }

  if (msg.type === "UPDATE_PLAYER_NOTE") {
    var boardId = clientBoards.get(ws);
    if (!boardId) { log("WARN", "[DraftKit] UPDATE_PLAYER_NOTE received from unsubscribed client — ignoring"); return; }
    if (!msg.teamId || !msg.playerId) { log("WARN", "[DraftKit] UPDATE_PLAYER_NOTE received with missing teamId or playerId — ignoring"); return; }
    var bs = getBoardState(boardId, log);
    if (bs.archived) { log("WARN", "[DraftKit] UPDATE_PLAYER_NOTE rejected — board " + boardId + " is archived"); return; }
    if (!bs.playerNotes) bs.playerNotes = {};
    if (!bs.playerNotes[msg.teamId]) bs.playerNotes[msg.teamId] = {};
    bs.playerNotes[msg.teamId][msg.playerId] = msg.note || "";
    saveState(boardId, bs, log);
    var count = broadcastToBoard(boardId, statePayload(boardId, bs), ws);
    log("INFO", "[DraftKit] UPDATE_PLAYER_NOTE for board: " + boardId +
      " team: " + msg.teamId + " player: " + msg.playerId +
      " — broadcasted to " + count + " other client(s)");
  }
}

module.exports = { handleMessage, statePayload };
