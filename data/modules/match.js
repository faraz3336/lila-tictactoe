var OP_CODES = {
  STATE: 1,
  ERROR: 2,
};

var CLIENT_OP_CODES = {
  MOVE: 1,
  REMATCH: 2,
};

var GAME_STATUS = {
  WAITING: "waiting",
  PLAYING: "playing",
  FINISHED: "finished",
};

var TICK_RATE = 2;
var DISCONNECT_FORFEIT_TICKS = 20;

var InitModule = function (ctx, logger, nk, initializer) {
  logger.info("Tic-tac-toe module loaded");

  initializer.registerMatch("tic-tac-toe", {
    matchInit: matchInit,
    matchJoinAttempt: matchJoinAttempt,
    matchJoin: matchJoin,
    matchLeave: matchLeave,
    matchLoop: matchLoop,
    matchTerminate: matchTerminate,
    matchSignal: matchSignal,
  });

  initializer.registerMatchmakerMatched(matchmakerMatched);
  initializer.registerRpc("create_match", rpcCreateMatch);
};

function rpcCreateMatch(ctx, logger, nk, payload) {
  var request = safeParsePayload(nk, payload);
  var roomName = sanitizeRoomName(request.roomName);
  var matchId = nk.matchCreate("tic-tac-toe", {
    roomName: roomName,
    creatorUserId: ctx.userId || "",
  });

  logger.info("Created public room %s for user %s", roomName, ctx.userId);

  return JSON.stringify({
    matchId: matchId,
    roomName: roomName,
  });
}

function matchmakerMatched(ctx, logger, nk, matches) {
  var roomName = "Matchmade Room";
  var invited = [];
  var i;

  for (i = 0; i < matches.length; i++) {
    invited.push({
      userId: matches[i].presence.userId,
      username: matches[i].presence.username,
    });
  }

  logger.info("Creating matchmade room for %s players", invited.length);

  return nk.matchCreate("tic-tac-toe", {
    roomName: roomName,
    invited: invited,
    createdBy: "matchmaker",
  });
}

function matchInit(ctx, logger, nk, params) {
  var roomName = sanitizeRoomName(params.roomName);
  var reservedUserIds = {};
  var i;

  if (params.invited && params.invited.length) {
    for (i = 0; i < params.invited.length; i++) {
      reservedUserIds[params.invited[i].userId] = true;
    }
  }

  var state = {
    roomName: roomName,
    board: createBoard(),
    seats: [null, null],
    status: GAME_STATUS.WAITING,
    currentTurn: "X",
    winner: null,
    winLine: null,
    rematchVotes: {},
    reservedUserIds: reservedUserIds,
    createdBy: params.createdBy || "rpc",
    creatorUserId: params.creatorUserId || "",
    lastUpdatedTick: 0,
  };

  return {
    state: state,
    tickRate: TICK_RATE,
    label: buildLabel(state),
  };
}

function matchJoinAttempt(
  ctx,
  logger,
  nk,
  dispatcher,
  tick,
  state,
  presence,
  metadata,
) {
  var seatIndex = findSeatIndexByUserId(state, presence.userId);
  var openSeatIndex = findOpenSeatIndex(state);
  var hasReservations = hasReservedUsers(state);
  var isReserved = state.reservedUserIds[presence.userId] === true;

  if (seatIndex !== -1) {
    return { state: state, accept: true };
  }

  if (hasReservations && !isReserved) {
    return { state: state, accept: false, rejectMessage: "This match is reserved." };
  }

  if (openSeatIndex === -1) {
    return { state: state, accept: false, rejectMessage: "Match is full." };
  }

  return { state: state, accept: true };
}

function matchJoin(ctx, logger, nk, dispatcher, tick, state, presences) {
  var i;
  for (i = 0; i < presences.length; i++) {
    assignPresenceToSeat(state, presences[i]);
    delete state.reservedUserIds[presences[i].userId];
  }

  refreshStatus(state);
  state.lastUpdatedTick = tick;
  updateLabel(dispatcher, state);
  broadcastState(dispatcher, state, null);

  return { state: state };
}

function matchLeave(ctx, logger, nk, dispatcher, tick, state, presences) {
  var i;
  for (i = 0; i < presences.length; i++) {
    if (state.status === GAME_STATUS.PLAYING) {
      markSeatDisconnected(state, presences[i], tick);
    } else {
      clearSeat(state, presences[i].userId);
    }
  }

  refreshStatus(state);
  state.lastUpdatedTick = tick;
  updateLabel(dispatcher, state);
  broadcastState(dispatcher, state, null);

  return { state: state };
}

function matchLoop(ctx, logger, nk, dispatcher, tick, state, messages) {
  var i;

  for (i = 0; i < messages.length; i++) {
    handleMessage(logger, nk, dispatcher, tick, state, messages[i]);
  }

  handleDisconnectForfeit(dispatcher, tick, state);

  return { state: state };
}

function matchTerminate(ctx, logger, nk, dispatcher, tick, state, graceSeconds) {
  return { state: state };
}

function matchSignal(ctx, logger, nk, dispatcher, tick, state, data) {
  return { state: state, data: JSON.stringify(serializeState(state)) };
}

function handleMessage(logger, nk, dispatcher, tick, state, message) {
  var payload;
  try {
    payload = safeParsePayload(nk, message.data);
  } catch (error) {
    sendError(dispatcher, message.sender, "Invalid message payload.");
    return;
  }

  var seatIndex = findSeatIndexByUserId(state, message.sender.userId);

  if (seatIndex === -1) {
    sendError(dispatcher, message.sender, "You are not part of this match.");
    return;
  }

  if (!state.seats[seatIndex].connected) {
    sendError(dispatcher, message.sender, "Reconnect before sending commands.");
    return;
  }

  if (message.opCode === CLIENT_OP_CODES.MOVE) {
    handleMove(dispatcher, tick, state, message.sender, payload);
    return;
  }

  if (message.opCode === CLIENT_OP_CODES.REMATCH) {
    handleRematch(dispatcher, tick, state, message.sender);
    return;
  }

  sendError(dispatcher, message.sender, "Unknown operation.");
}

function handleMove(dispatcher, tick, state, sender, payload) {
  var seatIndex = findSeatIndexByUserId(state, sender.userId);
  var seat = seatIndex === -1 ? null : state.seats[seatIndex];
  var position = normalizeBoardPosition(payload.position);

  if (!seat) {
    sendError(dispatcher, sender, "Unknown player.");
    return;
  }

  if (state.status !== GAME_STATUS.PLAYING) {
    sendError(dispatcher, sender, "The match is not ready for moves.");
    return;
  }

  if (seat.mark !== state.currentTurn) {
    sendError(dispatcher, sender, "Wait for your turn.");
    return;
  }

  if (position === null) {
    sendError(dispatcher, sender, "Invalid board position.");
    return;
  }

  if (state.board[position] !== "") {
    sendError(dispatcher, sender, "That cell is already occupied.");
    return;
  }

  state.board[position] = seat.mark;
  state.rematchVotes = {};
  state.lastUpdatedTick = tick;

  var evaluation = evaluateBoard(state.board);
  if (evaluation.winner) {
    state.status = GAME_STATUS.FINISHED;
    state.winner = evaluation.winner;
    state.winLine = evaluation.winLine;
  } else if (isBoardFull(state.board)) {
    state.status = GAME_STATUS.FINISHED;
    state.winner = "draw";
    state.winLine = null;
  } else {
    state.currentTurn = seat.mark === "X" ? "O" : "X";
  }

  updateLabel(dispatcher, state);
  broadcastState(dispatcher, state, null);
}

function handleRematch(dispatcher, tick, state, sender) {
  var seatIndex = findSeatIndexByUserId(state, sender.userId);
  var playerCount = connectedSeatCount(state);

  if (seatIndex === -1) {
    sendError(dispatcher, sender, "Unknown player.");
    return;
  }

  if (state.status !== GAME_STATUS.FINISHED) {
    sendError(dispatcher, sender, "Rematch is only available after the game ends.");
    return;
  }

  if (playerCount < 2) {
    sendError(dispatcher, sender, "Both players must be connected to start a rematch.");
    return;
  }

  state.rematchVotes[sender.userId] = true;

  if (bothPlayersVotedForRematch(state)) {
    resetBoard(state);
    state.currentTurn = state.currentTurn === "X" ? "O" : "X";
    state.status = GAME_STATUS.PLAYING;
    state.winner = null;
    state.winLine = null;
    state.rematchVotes = {};
  }

  state.lastUpdatedTick = tick;
  updateLabel(dispatcher, state);
  broadcastState(dispatcher, state, null);
}

function handleDisconnectForfeit(dispatcher, tick, state) {
  if (state.status !== GAME_STATUS.PLAYING) {
    return;
  }

  var i;
  for (i = 0; i < state.seats.length; i++) {
    var seat = state.seats[i];
    if (
      seat &&
      !seat.connected &&
      typeof seat.disconnectedAtTick === "number" &&
      tick - seat.disconnectedAtTick >= DISCONNECT_FORFEIT_TICKS
    ) {
      state.status = GAME_STATUS.FINISHED;
      state.winner = seat.mark === "X" ? "O" : "X";
      state.winLine = null;
      state.rematchVotes = {};
      state.lastUpdatedTick = tick;
      updateLabel(dispatcher, state);
      broadcastState(dispatcher, state, null);
      return;
    }
  }
}

function assignPresenceToSeat(state, presence) {
  var existingSeatIndex = findSeatIndexByUserId(state, presence.userId);
  if (existingSeatIndex !== -1) {
    state.seats[existingSeatIndex].presence = toPresence(presence);
    state.seats[existingSeatIndex].username = presence.username;
    state.seats[existingSeatIndex].connected = true;
    state.seats[existingSeatIndex].disconnectedAtTick = null;
    return;
  }

  var openSeatIndex = findOpenSeatIndex(state);
  if (openSeatIndex === -1) {
    return;
  }

  state.seats[openSeatIndex] = {
    userId: presence.userId,
    username: presence.username,
    presence: toPresence(presence),
    connected: true,
    disconnectedAtTick: null,
    mark: openSeatIndex === 0 ? "X" : "O",
  };
}

function markSeatDisconnected(state, presence, tick) {
  var seatIndex = findSeatIndexByUserId(state, presence.userId);
  if (seatIndex === -1) {
    return;
  }

  state.seats[seatIndex].presence = null;
  state.seats[seatIndex].connected = false;
  state.seats[seatIndex].disconnectedAtTick = tick;
}

function clearSeat(state, userId) {
  var seatIndex = findSeatIndexByUserId(state, userId);
  if (seatIndex === -1) {
    return;
  }

  state.seats[seatIndex] = null;
}

function refreshStatus(state) {
  if (occupiedSeatCount(state) < 2) {
    resetBoard(state);
    state.currentTurn = "X";
    state.winner = null;
    state.winLine = null;
    state.rematchVotes = {};
    state.status = GAME_STATUS.WAITING;
    return;
  }

  if (state.status === GAME_STATUS.FINISHED) {
    return;
  }

  if (connectedSeatCount(state) < 2 && !boardHasMarks(state.board)) {
    state.status = GAME_STATUS.WAITING;
    return;
  }

  state.status = GAME_STATUS.PLAYING;
}

function serializeState(state) {
  return {
    roomName: state.roomName,
    board: state.board.slice(0),
    status: state.status,
    currentTurn: state.currentTurn,
    winner: state.winner,
    winLine: state.winLine,
    rematchVotes: copyObject(state.rematchVotes),
    players: [
      serializeSeat(state.seats[0]),
      serializeSeat(state.seats[1]),
    ],
  };
}

function serializeSeat(seat) {
  if (!seat) {
    return null;
  }

  return {
    userId: seat.userId,
    username: seat.username,
    connected: seat.connected,
    mark: seat.mark,
  };
}

function broadcastState(dispatcher, state, presences) {
  dispatcher.broadcastMessage(OP_CODES.STATE, JSON.stringify(serializeState(state)), presences, null);
}

function sendError(dispatcher, presence, message) {
  dispatcher.broadcastMessage(OP_CODES.ERROR, JSON.stringify({ message: message }), [presence], null);
}

function buildLabel(state) {
  return JSON.stringify({
    game: "tic-tac-toe",
    roomName: state.roomName,
    open: occupiedSeatCount(state) < 2,
    status: state.status,
    players: occupiedSeatCount(state),
    maxPlayers: 2,
  });
}

function updateLabel(dispatcher, state) {
  dispatcher.matchLabelUpdate(buildLabel(state));
}

function evaluateBoard(board) {
  var lines = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ];

  var i;
  for (i = 0; i < lines.length; i++) {
    var a = lines[i][0];
    var b = lines[i][1];
    var c = lines[i][2];

    if (board[a] !== "" && board[a] === board[b] && board[a] === board[c]) {
      return {
        winner: board[a],
        winLine: lines[i],
      };
    }
  }

  return {
    winner: null,
    winLine: null,
  };
}

function bothPlayersVotedForRematch(state) {
  var i;
  for (i = 0; i < state.seats.length; i++) {
    if (!state.seats[i] || !state.rematchVotes[state.seats[i].userId]) {
      return false;
    }
  }

  return true;
}

function occupiedSeatCount(state) {
  var count = 0;
  var i;

  for (i = 0; i < state.seats.length; i++) {
    if (state.seats[i]) {
      count += 1;
    }
  }

  return count;
}

function connectedSeatCount(state) {
  var count = 0;
  var i;

  for (i = 0; i < state.seats.length; i++) {
    if (state.seats[i] && state.seats[i].connected) {
      count += 1;
    }
  }

  return count;
}

function findOpenSeatIndex(state) {
  var i;
  for (i = 0; i < state.seats.length; i++) {
    if (!state.seats[i]) {
      return i;
    }
  }

  return -1;
}

function findSeatIndexByUserId(state, userId) {
  var i;
  for (i = 0; i < state.seats.length; i++) {
    if (state.seats[i] && state.seats[i].userId === userId) {
      return i;
    }
  }

  return -1;
}

function hasReservedUsers(state) {
  var key;
  for (key in state.reservedUserIds) {
    if (state.reservedUserIds.hasOwnProperty(key)) {
      return true;
    }
  }

  return false;
}

function createBoard() {
  return ["", "", "", "", "", "", "", "", ""];
}

function resetBoard(state) {
  state.board = createBoard();
}

function isBoardFull(board) {
  var i;
  for (i = 0; i < board.length; i++) {
    if (board[i] === "") {
      return false;
    }
  }

  return true;
}

function boardHasMarks(board) {
  var i;
  for (i = 0; i < board.length; i++) {
    if (board[i] !== "") {
      return true;
    }
  }

  return false;
}

function sanitizeRoomName(name) {
  if (typeof name !== "string") {
    return "Public Room";
  }

  var trimmed = name.replace(/^\s+|\s+$/g, "");
  if (!trimmed) {
    return "Public Room";
  }

  if (trimmed.length > 48) {
    return trimmed.slice(0, 48);
  }

  return trimmed;
}

function safeParsePayload(nk, payload) {
  if (!payload) {
    return {};
  }

  if (typeof payload === "object" && typeof nk.binaryToString === "function") {
    return JSON.parse(nk.binaryToString(payload));
  }

  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch (error) {
      return JSON.parse(base64Decode(payload));
    }
  }

  return payload;
}

function base64Decode(input) {
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  var str = String(input).replace(/=+$/, "");
  var output = "";
  var bc = 0;
  var bs;
  var buffer;
  var idx = 0;

  while ((buffer = str.charAt(idx++))) {
    buffer = chars.indexOf(buffer);
    if (buffer === -1) {
      continue;
    }

    bs = bc % 4 ? bs * 64 + buffer : buffer;
    bc += 1;

    if (bc % 4) {
      output += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6)));
    }
  }

  try {
    return decodeURIComponent(escape(output));
  } catch (error) {
    return output;
  }
}

function normalizeBoardPosition(value) {
  if (typeof value === "number" && value % 1 === 0 && value >= 0 && value <= 8) {
    return value;
  }

  if (typeof value === "string" && value !== "") {
    var parsed = Number(value);
    if (!isNaN(parsed) && parsed % 1 === 0 && parsed >= 0 && parsed <= 8) {
      return parsed;
    }
  }

  return null;
}

function copyObject(source) {
  var target = {};
  var key;

  for (key in source) {
    if (source.hasOwnProperty(key)) {
      target[key] = source[key];
    }
  }

  return target;
}

function toPresence(presence) {
  return {
    userId: presence.userId,
    sessionId: presence.sessionId,
    username: presence.username,
    node: presence.node,
  };
}
