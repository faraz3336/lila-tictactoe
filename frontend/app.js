import * as NakamaJs from "./node_modules/@heroiclabs/nakama-js/dist/nakama-js.esm.mjs";

const SERVER_STATE_OPCODE = 1;
const SERVER_ERROR_OPCODE = 2;
const CLIENT_MOVE_OPCODE = 1;
const CLIENT_REMATCH_OPCODE = 2;
const MATCHMAKER_QUERY = "";
const DEFAULT_ROOM_NAME = "Public Room";
const STORAGE_KEYS = {
  deviceId: "nakama-ttt-device-id",
  host: "nakama-ttt-host",
  port: "nakama-ttt-port",
  ssl: "nakama-ttt-ssl",
  displayName: "nakama-ttt-display-name",
  activeMatchId: "nakama-ttt-active-match-id",
};

const APP_CONFIG = window.__APP_CONFIG__ || {};

const state = {
  client: null,
  socket: null,
  session: null,
  match: null,
  serverState: null,
  matchmakerTicket: null,
  rooms: [],
  uiLocked: false,
  connectionNonce: 0,
  lastAnnouncedMatchStateKey: "",
};

const elements = {
  board: document.querySelector("#board"),
  activityLog: document.querySelector("#activity-log"),
  connectionStatus: document.querySelector("#connection-status"),
  playerDisplay: document.querySelector("#player-display"),
  roomDisplay: document.querySelector("#room-display"),
  matchSummary: document.querySelector("#match-summary"),
  infoBanner: document.querySelector("#info-banner"),
  startBanner: document.querySelector("#start-banner"),
  roomsList: document.querySelector("#rooms-list"),
  playerXName: document.querySelector("#player-x-name"),
  playerXStatus: document.querySelector("#player-x-status"),
  playerOName: document.querySelector("#player-o-name"),
  playerOStatus: document.querySelector("#player-o-status"),
  playerXCard: document.querySelector("#player-x-card"),
  playerOCard: document.querySelector("#player-o-card"),
  loginButton: document.querySelector("#login-button"),
  refreshButton: document.querySelector("#refresh-button"),
  leaveButton: document.querySelector("#leave-button"),
  autoMatchButton: document.querySelector("#auto-match-button"),
  createRoomButton: document.querySelector("#create-room-button"),
  rematchButton: document.querySelector("#rematch-button"),
  displayNameInput: document.querySelector("#display-name"),
  serverHostInput: document.querySelector("#server-host"),
  serverPortInput: document.querySelector("#server-port"),
  serverSslInput: document.querySelector("#server-ssl"),
  roomNameInput: document.querySelector("#room-name"),
};

bootstrap();

function bootstrap() {
  hydrateInputs();
  buildBoard();
  bindEvents();
  render();
}

function bindEvents() {
  elements.loginButton.addEventListener("click", login);
  elements.refreshButton.addEventListener("click", refreshRooms);
  elements.leaveButton.addEventListener("click", leaveMatch);
  elements.autoMatchButton.addEventListener("click", startAutomatch);
  elements.createRoomButton.addEventListener("click", createRoom);
  elements.rematchButton.addEventListener("click", requestRematch);
  elements.displayNameInput.addEventListener("change", persistSettings);
  elements.serverHostInput.addEventListener("change", persistSettings);
  elements.serverPortInput.addEventListener("change", persistSettings);
  elements.serverSslInput.addEventListener("change", persistSettings);
}

function buildBoard() {
  elements.board.innerHTML = "";

  for (let index = 0; index < 9; index += 1) {
    const button = document.createElement("button");
    button.className = "cell";
    button.type = "button";
    button.dataset.index = String(index);
    button.addEventListener("click", () => playMove(index));
    elements.board.appendChild(button);
  }
}

async function login() {
  if (state.uiLocked) {
    return;
  }

  setLocked(true);
  persistSettings();

  try {
    await disconnectCurrentSession();
    const connectionNonce = ++state.connectionNonce;

    const config = readSettings();
    state.client = new NakamaJs.Client("defaultkey", config.host, config.port, config.useSSL);

    const displayName = (config.displayName || "").trim() || makeGuestName();
    const session = await state.client.authenticateDevice(getDeviceId(), true, displayName);
    await state.client.updateAccount(session, { username: displayName });
    session.username = displayName;
    const socket = state.client.createSocket(config.useSSL, false);

    registerSocketHandlers(socket, connectionNonce);
    await socket.connect(session, true);

    state.session = session;
    state.socket = socket;
    log(`Connected as ${displayName}.`);

    await refreshRooms({ silent: true });
    await restoreActiveMatch();
  } catch (error) {
    log(`Login failed: ${formatError(error)}`, "error");
  } finally {
    setLocked(false);
    render();
  }
}

function registerSocketHandlers(socket, connectionNonce) {
  socket.onmatchdata = (message) => {
    if (!isCurrentConnection(socket, connectionNonce)) {
      return;
    }

    if (message.op_code === SERVER_STATE_OPCODE) {
      const previousStatus = state.serverState?.status || null;
      state.serverState = safeParseJson(readRealtimePayload(message.data), null);
      if (state.serverState) {
        syncActiveRoomIntoList();
        handleMatchStateAnnouncement(previousStatus, state.serverState);
      }
      refreshRooms({ silent: true }).catch(() => {});
      render();
      return;
    }

    if (message.op_code === SERVER_ERROR_OPCODE) {
      const payload = safeParseJson(readRealtimePayload(message.data), {});
      log(payload.message || "Server returned an unknown error.", "error");
    }
  };

  socket.onmatchpresence = () => {
    if (!isCurrentConnection(socket, connectionNonce)) {
      return;
    }

    refreshRooms({ silent: true }).catch(() => {});
    render();
  };

  socket.onmatchmakermatched = async (matched) => {
    if (!isCurrentConnection(socket, connectionNonce)) {
      return;
    }

    try {
      log("Matchmaker found an opponent. Joining authoritative match...");
      await joinMatch(null, matched.token);
      state.matchmakerTicket = null;
    } catch (error) {
      log(`Unable to join matchmade room: ${formatError(error)}`, "error");
    }
  };

  socket.ondisconnect = () => {
    if (!isCurrentConnection(socket, connectionNonce)) {
      return;
    }

    log("Socket disconnected.", "error");
    state.socket = null;
    state.match = null;
    state.serverState = null;
    state.matchmakerTicket = null;
    render();
  };
}

async function refreshRooms(options = { silent: false }) {
  return refreshRoomsInternal(options);
}

async function refreshRoomsInternal(options = { silent: false }) {
  if (!ensureAuthenticated()) {
    return;
  }

  try {
    const response = await state.client.listMatches(state.session, 20, true, null, 0, 2);
    state.rooms = (response.matches || [])
      .map((match) => normalizeRoom(match))
      .filter((room) => room.game === "tic-tac-toe");
    syncActiveRoomIntoList();
    if (!options.silent) {
      log(`Loaded ${state.rooms.length} public room(s).`);
    }
  } catch (error) {
    log(`Unable to load rooms: ${formatError(error)}`, "error");
  }

  render();
}

async function createRoom() {
  if (!ensureAuthenticated()) {
    return;
  }

  try {
    await cancelMatchmakerIfNeeded();
    const roomName = elements.roomNameInput.value.trim() || DEFAULT_ROOM_NAME;
    const response = await state.client.rpc(state.session, "create_match", { roomName });
    const payload = JSON.parse(response.payload || "{}");
    upsertRoom({
      matchId: payload.matchId,
      roomName: payload.roomName || roomName,
      game: "tic-tac-toe",
      open: true,
      players: 0,
      status: "waiting",
    });
    render();

    log(`Created room "${payload.roomName || roomName}". Joining now...`);
    await joinMatch(payload.matchId);
    await refreshRooms({ silent: true });
  } catch (error) {
    log(`Unable to create room: ${formatError(error)}`, "error");
  }
}

async function startAutomatch() {
  if (!ensureAuthenticated() || !state.socket) {
    return;
  }

  try {
    if (state.matchmakerTicket) {
      log("You are already in the matchmaking queue.");
      return;
    }

    const ticket = await state.socket.addMatchmaker(MATCHMAKER_QUERY, 2, 2);
    state.matchmakerTicket = ticket.ticket;
    log("Searching for an opponent...");
    render();
  } catch (error) {
    log(`Unable to start matchmaking: ${formatError(error)}`, "error");
  }
}

async function joinRoom(matchId) {
  if (!ensureAuthenticated()) {
    return;
  }

  try {
    await cancelMatchmakerIfNeeded();
    await joinMatch(matchId);
    log("Joined room successfully.");
  } catch (error) {
    log(`Unable to join room: ${formatError(error)}`, "error");
  }
}

async function joinMatch(matchId, token) {
  if (!state.socket) {
    throw new Error("Login first.");
  }

  if (state.match && state.match.match_id === matchId && !token) {
    return;
  }

  if (state.match && state.match.match_id && state.match.match_id !== matchId) {
    await leaveMatch();
  }

  const joined = await state.socket.joinMatch(matchId, token);
  state.match = joined;
  state.serverState = null;
  persistActiveMatchId(joined.match_id || matchId || "");

  const joinedRoomId = joined.match_id || matchId || "matchmade room";
  log(`Joined ${joinedRoomId}.`);
  render();
}

async function leaveMatch() {
  if (!state.socket || !state.match) {
    return;
  }

  try {
    await cancelMatchmakerIfNeeded();
    await state.socket.leaveMatch(state.match.match_id);
    log("Left the active match.");
  } catch (error) {
    log(`Leave match failed: ${formatError(error)}`, "error");
  } finally {
    state.match = null;
    state.serverState = null;
    clearActiveMatchId();
    render();
    await refreshRooms({ silent: true });
  }
}

async function playMove(position) {
  if (!state.match || !state.socket || !canPlayPosition(position)) {
    return;
  }

  try {
    await state.socket.sendMatchState(
      state.match.match_id,
      CLIENT_MOVE_OPCODE,
      JSON.stringify({ position }),
    );
  } catch (error) {
    log(`Move failed: ${formatError(error)}`, "error");
  }
}

async function requestRematch() {
  if (!state.match || !state.socket) {
    return;
  }

  try {
    await state.socket.sendMatchState(
      state.match.match_id,
      CLIENT_REMATCH_OPCODE,
      JSON.stringify({}),
    );
    log("Rematch requested.");
  } catch (error) {
    log(`Unable to request rematch: ${formatError(error)}`, "error");
  }
}

function canPlayPosition(position) {
  const board = state.serverState?.board || [];
  const me = getCurrentPlayer();

  if (!state.serverState || !me) {
    return false;
  }

  if (state.serverState.status !== "playing") {
    return false;
  }

  if (me.mark !== state.serverState.currentTurn) {
    return false;
  }

  return board[position] === "";
}

function render() {
  renderHeader();
  renderPlayers();
  renderBoard();
  renderRooms();
  renderButtons();
}

function renderHeader() {
  const connected = Boolean(state.socket && state.session);
  const me = getCurrentPlayer();
  const roomName = state.serverState?.roomName || "None";

  elements.connectionStatus.textContent = connected ? "Online" : "Offline";
  elements.connectionStatus.dataset.online = String(connected);
  elements.playerDisplay.textContent = connected
    ? (state.session?.username || makeGuestNameFromSession())
    : "Not connected";
  elements.roomDisplay.textContent = roomName;

  if (!state.serverState) {
    hideStartBanner();
    elements.matchSummary.textContent = connected
      ? "Create a room, browse open rooms, or use auto match."
      : "Login to start playing.";
    elements.infoBanner.textContent =
      "Server validation is active. Invalid turns are rejected by the match handler.";
    return;
  }

  const winnerText = state.serverState.winner === "draw"
    ? "Game ended in a draw."
    : state.serverState.winner
      ? `${state.serverState.winner} won the match.`
      : `${state.serverState.currentTurn} to move.`;

  elements.matchSummary.textContent = `${state.serverState.roomName} · ${state.serverState.status}`;
  elements.infoBanner.textContent = me
    ? `You are ${me.mark}. ${winnerText}`
    : winnerText;
}

function renderPlayers() {
  const players = state.serverState?.players || [null, null];
  renderSeat(players[0], elements.playerXCard, elements.playerXName, elements.playerXStatus, "X");
  renderSeat(players[1], elements.playerOCard, elements.playerOName, elements.playerOStatus, "O");
}

function renderSeat(player, card, nameElement, statusElement, fallbackMark) {
  card.dataset.active = "false";

  if (!player) {
    nameElement.textContent = "Waiting...";
    statusElement.textContent = "Open seat";
    return;
  }

  const me = state.session?.user_id === player.userId;
  nameElement.textContent = me ? `${player.username} (You)` : player.username;
  statusElement.textContent = `${fallbackMark} · ${player.connected ? "Connected" : "Disconnected"}`;
  card.dataset.active = String(player.mark === state.serverState?.currentTurn && state.serverState?.status === "playing");
}

function renderBoard() {
  const board = state.serverState?.board || Array(9).fill("");
  const winLine = state.serverState?.winLine || [];

  [...elements.board.children].forEach((cell, index) => {
    const value = board[index];
    cell.textContent = value || "";
    cell.disabled = !canPlayPosition(index);
    cell.dataset.filled = String(Boolean(value));
    cell.dataset.winner = String(winLine.includes(index));
  });
}

function renderRooms() {
  if (!state.rooms.length) {
    elements.roomsList.innerHTML = '<p class="empty-state">No public rooms are open right now.</p>';
    return;
  }

  elements.roomsList.innerHTML = "";

  state.rooms.forEach((room) => {
    const item = document.createElement("article");
    item.className = "room-card";

    const title = document.createElement("div");
    title.innerHTML = `<h3>${escapeHtml(room.roomName)}</h3><p>${room.status} · ${room.players}/2 players</p>`;

    const button = document.createElement("button");
    button.textContent = room.open ? "Join" : "Spectate Full";
    button.disabled = !room.matchId || !room.open;
    button.addEventListener("click", () => joinRoom(room.matchId));

    item.appendChild(title);
    item.appendChild(button);
    elements.roomsList.appendChild(item);
  });
}

function renderButtons() {
  const connected = Boolean(state.socket && state.session);
  const inMatch = Boolean(state.match);
  const finished = state.serverState?.status === "finished";

  elements.loginButton.textContent = connected ? "Reconnect" : "Login";
  elements.refreshButton.disabled = !connected;
  elements.leaveButton.disabled = !inMatch;
  elements.autoMatchButton.disabled = !connected || inMatch || Boolean(state.matchmakerTicket);
  elements.createRoomButton.disabled = !connected || inMatch;
  elements.rematchButton.disabled = !inMatch || !finished;
  elements.loginButton.disabled = state.uiLocked;
}

function handleMatchStateAnnouncement(previousStatus, currentState) {
  const currentPlayers = (currentState.players || []).filter(Boolean).length;
  const announcementKey = `${state.match?.match_id || ""}:${currentState.status}:${currentPlayers}`;

  if (
    previousStatus !== "playing" &&
    currentState.status === "playing" &&
    currentPlayers === 2 &&
    state.lastAnnouncedMatchStateKey !== announcementKey
  ) {
    state.lastAnnouncedMatchStateKey = announcementKey;
    showStartBanner("Match started. Both players are connected.");
    log(`Match started in ${currentState.roomName}.`, "success");
    return;
  }

  if (currentState.status !== "playing") {
    hideStartBanner();
  }
}

function showStartBanner(message) {
  elements.startBanner.hidden = false;
  elements.startBanner.textContent = message;
}

function hideStartBanner() {
  elements.startBanner.hidden = true;
}

function normalizeRoom(match) {
  const rawLabel = safeParseJson(match.label, {});

  return {
    matchId: match.match_id,
    roomName: rawLabel.roomName || "Public Room",
    game: rawLabel.game || "",
    open: Boolean(rawLabel.open),
    players: rawLabel.players ?? match.size ?? 0,
    status: rawLabel.status || "waiting",
  };
}

function getCurrentPlayer() {
  if (!state.serverState || !state.session) {
    return null;
  }

  return (state.serverState.players || []).find((player) => player && player.userId === state.session.user_id) || null;
}

function log(message, kind = "info") {
  const item = document.createElement("p");
  item.className = `log-entry ${kind}`;
  item.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  elements.activityLog.prepend(item);
}

function ensureAuthenticated() {
  if (state.client && state.session && state.socket) {
    return true;
  }

  log("Login first to use multiplayer features.", "error");
  return false;
}

async function cancelMatchmakerIfNeeded() {
  if (!state.socket || !state.matchmakerTicket) {
    return;
  }

  await state.socket.removeMatchmaker(state.matchmakerTicket);
  state.matchmakerTicket = null;
  log("Stopped matchmaking queue.");
}

async function disconnectCurrentSession() {
  if (!state.socket && !state.session && !state.client) {
    return;
  }

  state.connectionNonce += 1;

  try {
    await cancelMatchmakerIfNeeded();
  } catch (error) {
    log(`Unable to cancel matchmaking cleanly: ${formatError(error)}`, "error");
  }

  try {
    if (state.socket && state.match?.match_id) {
      await state.socket.leaveMatch(state.match.match_id);
    }
  } catch (error) {
    log(`Unable to leave the active match cleanly: ${formatError(error)}`, "error");
  }

  try {
    state.socket?.disconnect();
  } catch (error) {
    log(`Unable to close the previous realtime connection cleanly: ${formatError(error)}`, "error");
  }

  state.client = null;
  state.socket = null;
  state.session = null;
  state.match = null;
  state.serverState = null;
  state.matchmakerTicket = null;
  state.rooms = [];
  state.lastAnnouncedMatchStateKey = "";
  hideStartBanner();
  render();
}

function setLocked(value) {
  state.uiLocked = value;
  renderButtons();
}

function hydrateInputs() {
  const defaultHost = APP_CONFIG.nakamaHost
    || (window.location.hostname && window.location.hostname !== "localhost"
      ? window.location.hostname
      : "127.0.0.1");
  const defaultPort = APP_CONFIG.nakamaPort || "7350";
  const defaultSsl = typeof APP_CONFIG.nakamaUseSSL === "boolean"
    ? APP_CONFIG.nakamaUseSSL
    : false;

  elements.displayNameInput.value = localStorage.getItem(STORAGE_KEYS.displayName) || "";
  elements.serverHostInput.value = localStorage.getItem(STORAGE_KEYS.host) || defaultHost;
  elements.serverPortInput.value = localStorage.getItem(STORAGE_KEYS.port) || defaultPort;
  elements.serverSslInput.checked = localStorage.getItem(STORAGE_KEYS.ssl)
    ? localStorage.getItem(STORAGE_KEYS.ssl) === "true"
    : defaultSsl;
}

function persistSettings() {
  localStorage.setItem(STORAGE_KEYS.displayName, elements.displayNameInput.value.trim());
  localStorage.setItem(STORAGE_KEYS.host, elements.serverHostInput.value.trim());
  localStorage.setItem(STORAGE_KEYS.port, elements.serverPortInput.value.trim());
  localStorage.setItem(STORAGE_KEYS.ssl, String(elements.serverSslInput.checked));
}

function readSettings() {
  return {
    displayName: elements.displayNameInput.value.trim(),
    host: elements.serverHostInput.value.trim() || "127.0.0.1",
    port: elements.serverPortInput.value.trim() || "7350",
    useSSL: elements.serverSslInput.checked,
  };
}

async function restoreActiveMatch() {
  const activeMatchId = localStorage.getItem(STORAGE_KEYS.activeMatchId);

  if (!activeMatchId || !state.socket) {
    return;
  }

  try {
    await joinMatch(activeMatchId);
    log("Rejoined your active match.");
  } catch (error) {
    clearActiveMatchId();
    log(`Could not restore previous match: ${formatError(error)}`, "error");
  }
}

function getDeviceId() {
  let deviceId = localStorage.getItem(STORAGE_KEYS.deviceId);

  if (!deviceId) {
    deviceId = self.crypto?.randomUUID?.() || `device-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(STORAGE_KEYS.deviceId, deviceId);
  }

  return deviceId;
}

function makeGuestName() {
  const name = `Player-${getDeviceId().slice(0, 6)}`;
  elements.displayNameInput.value = name;
  persistSettings();
  return name;
}

function makeGuestNameFromSession() {
  return state.session?.user_id ? `Player-${state.session.user_id.slice(0, 6)}` : "Connected";
}

function formatError(error) {
  return error?.message || String(error);
}

function safeParseJson(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function persistActiveMatchId(matchId) {
  if (!matchId) {
    clearActiveMatchId();
    return;
  }

  localStorage.setItem(STORAGE_KEYS.activeMatchId, matchId);
}

function clearActiveMatchId() {
  localStorage.removeItem(STORAGE_KEYS.activeMatchId);
}

function isCurrentConnection(socket, connectionNonce) {
  return state.socket === socket && state.connectionNonce === connectionNonce;
}

function upsertRoom(room) {
  if (!room?.matchId) {
    return;
  }

  const index = state.rooms.findIndex((existingRoom) => existingRoom.matchId === room.matchId);
  if (index === -1) {
    state.rooms = [room, ...state.rooms];
    return;
  }

  state.rooms[index] = { ...state.rooms[index], ...room };
}

function syncActiveRoomIntoList() {
  if (!state.match?.match_id || !state.serverState) {
    return;
  }

  upsertRoom({
    matchId: state.match.match_id,
    roomName: state.serverState.roomName || "Public Room",
    game: "tic-tac-toe",
    open: (state.serverState.players || []).filter(Boolean).length < 2,
    players: (state.serverState.players || []).filter(Boolean).length,
    status: state.serverState.status || "waiting",
  });
}

function readRealtimePayload(payload) {
  if (typeof payload === "string") {
    return payload;
  }

  if (payload instanceof Uint8Array) {
    return new TextDecoder().decode(payload);
  }

  return "";
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
