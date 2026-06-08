// server.js — authoritative Mendicot server. Express serves the client; Socket.IO
// runs rooms with up to 4 seats (humans and/or bots), reconnection, and rematches.
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const G = require('./games/mendicot/game');
const { chooseCard } = require('./games/mendicot/bot');

const app = express();
// Lightweight health/keep-alive endpoint. Free hosts (e.g. Render) sleep a service
// after ~15 min with no inbound HTTP request — and WebSocket traffic does NOT count.
// The client pings this while in a game so the server stays awake mid-session.
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// Shared site assets (landing page, sounds) live in /public, served at "/".
app.use(express.static(path.join(__dirname, 'public')));

// Each game's UI lives in games/<game>/public and is mounted under /<game>.
// The bare clean URL (e.g. /mendicot) serves that game's index.html.
const MENDICOT_DIR = path.join(__dirname, 'games', 'mendicot', 'public');
app.get('/mendicot', (_req, res) => res.sendFile(path.join(MENDICOT_DIR, 'index.html')));
app.use('/mendicot', express.static(MENDICOT_DIR));
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const BOT_DELAY_MS = Number(process.env.BOT_DELAY_MS) || 950; // pause before a bot plays

/** rooms: code -> {
 *   code, numPlayers (4|6), seats:[seat|null x numPlayers], state,
 *   matchScore:[w0,w1], cots:[c0,c1], draws, rematchVotes:Set<token>,
 *   botTimer, createdAt
 * }
 * seat: { token, name, isBot, socketId, connected, creator } */
const rooms = new Map();
const socketIndex = new Map(); // socketId -> { code, token }

const rid = (n = 4) => {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
  let s = '';
  for (let i = 0; i < n; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
};
const token = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

function newRoom(numPlayers = 4, decks = 1) {
  if (![4, 6, 8].includes(numPlayers)) numPlayers = 4;
  decks = G.decksFor(numPlayers, decks);
  let code;
  do { code = rid(); } while (rooms.has(code));
  const room = {
    code, numPlayers, decks,
    seats: Array.from({ length: numPlayers }, () => null), state: null,
    matchScore: [0, 0], cots: [0, 0], draws: 0, rematchVotes: new Set(),
    botTimer: null, createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

const seatBySocket = (room, socketId) =>
  room.seats.findIndex((s) => s && s.socketId === socketId);
const seatByToken = (room, tk) => room.seats.findIndex((s) => s && s.token === tk);
const connectedHumans = (room) =>
  room.seats.filter((s) => s && !s.isBot && s.connected).length;
const allSeatsFilled = (room) => room.seats.every((s) => s !== null);

// ---- Broadcasting ---------------------------------------------------------

function lobbyPayload(room) {
  return {
    code: room.code,
    numPlayers: room.numPlayers,
    decks: room.decks,
    seats: room.seats.map((s) =>
      s ? { name: s.name, isBot: s.isBot, connected: s.connected, creator: !!s.creator } : null),
    started: !!room.state && room.state.phase !== 'finished',
    inProgress: !!room.state,
    matchScore: room.matchScore,
    cots: room.cots,
    draws: room.draws,
  };
}

function broadcastLobby(room) {
  io.to(room.code).emit('lobby', lobbyPayload(room));
}

// Personalized game view for a given seat.
function gameView(room, seat) {
  const st = room.state;
  if (!st) return null;
  const names = room.seats.map((s) => (s ? s.name : '—'));
  const isBot = room.seats.map((s) => !!(s && s.isBot));
  const connected = room.seats.map((s) => !!(s && (s.isBot || s.connected)));
  return {
    you: seat,
    phase: st.phase,
    numPlayers: st.numPlayers,
    decks: st.decks,
    tricksPerHand: st.tricksPerHand,
    names, isBot, connected,
    dealer: st.dealer,
    trump: st.trump,
    leadSuit: st.leadSuit,
    turn: st.turn,
    leader: st.leader,
    hand: seat != null && seat >= 0 ? st.hands[seat] : [],
    handCounts: st.hands.map((h) => h.length),
    currentTrick: st.currentTrick,
    tricksWon: st.tricksWon,
    mendis: { 0: st.mendis[0], 1: st.mendis[1] },
    trickNumber: st.trickNumber,
    lastTrick: st.lastTrick,
    legal: seat != null && seat === st.turn ? G.legalMoves(st, seat).map((c) => c.uid) : [],
    result: st.result,
    matchScore: room.matchScore,
    cots: room.cots,
    draws: room.draws,
  };
}

function broadcastGame(room) {
  if (!room.state) return;
  for (let seat = 0; seat < room.numPlayers; seat++) {
    const s = room.seats[seat];
    if (s && !s.isBot && s.socketId && s.connected) {
      io.to(s.socketId).emit('game', gameView(room, seat));
    }
  }
}

// ---- Bot driver -----------------------------------------------------------

function scheduleBots(room) {
  if (room.botTimer) return;
  const st = room.state;
  if (!st || st.phase !== 'playing') return;
  const cur = room.seats[st.turn];
  if (!cur || !cur.isBot) return;

  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    // This runs detached from any request, so an uncaught throw here would crash the
    // whole server (kicking every room). Keep it fully guarded.
    try {
      const s = room.state;
      if (!s || s.phase !== 'playing') return;
      const c = room.seats[s.turn];
      if (!c || !c.isBot) return;
      const card = chooseCard(s, s.turn);
      if (!card) return; // nothing legal to play — bail rather than crash
      const res = G.playCard(s, s.turn, card.uid);
      if (!res || !res.ok) return; // illegal/duplicate — don't loop forever
      broadcastGame(room);
      if (s.phase === 'finished') return finishDeal(room);
      scheduleBots(room);
    } catch (e) {
      console.error('[bot] error in room', room.code, e);
    }
  }, BOT_DELAY_MS);
}

function finishDeal(room) {
  const r = room.state.result;
  if (r.draw) room.draws += 1;
  else {
    room.matchScore[r.winningTeam] += 1;
    if (r.cot) room.cots[r.winningTeam] += 1;
  }
  room.rematchVotes = new Set();
  broadcastLobby(room);
  broadcastGame(room);
}

// Who leads (starts) the next deal:
//  • while the cot counts are UNEQUAL, the team behind on cots must start every deal
//    until the cots are equal again (cot penalty — takes priority);
//  • otherwise the team that LOST the previous deal starts.
// The seat rotates to the next player of that team after the previous leader. Returns
// undefined for the very first deal of a room (then createGame picks at random).
function nextLeaderSeat(room) {
  const prev = room.state;
  if (!prev || !prev.result) return undefined;
  const N = room.numPlayers;
  let leadTeam;
  if (room.cots[0] !== room.cots[1]) {
    leadTeam = room.cots[0] < room.cots[1] ? 0 : 1;     // behind on cots starts
  } else if (prev.result.draw || prev.result.winningTeam == null) {
    return G.nextSeat(prev.leader, N);                   // drawn deal: just rotate
  } else {
    leadTeam = 1 - prev.result.winningTeam;             // losers of last deal start
  }
  for (let i = 1; i <= N; i++) {
    const s = (prev.leader + i) % N;
    if (G.teamOf(s) === leadTeam) return s;
  }
  return undefined;
}

function startDeal(room) {
  const firstLeader = nextLeaderSeat(room);
  room.state = G.createGame(Math.random, room.numPlayers, room.decks, firstLeader);
  room.rematchVotes = new Set();
  broadcastLobby(room);
  broadcastGame(room);
  scheduleBots(room);
}

// ---- Socket handlers ------------------------------------------------------

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, players, decks } = {}, ack) => {
    const nm = (name || '').trim();
    if (!nm) return ack && ack({ ok: false, error: 'Please enter your name.' });
    const room = newRoom([4, 6, 8].includes(players) ? players : 4, decks === 2 ? 2 : 1);
    const tk = token();
    room.seats[0] = {
      token: tk, name: nm.slice(0, 20), isBot: false,
      socketId: socket.id, connected: true, creator: true,
    };
    socket.join(room.code);
    socketIndex.set(socket.id, { code: room.code, token: tk });
    ack && ack({ ok: true, code: room.code, token: tk, seat: 0 });
    broadcastLobby(room);
  });

  socket.on('joinRoom', ({ code, name, token: tk } = {}, ack) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return ack && ack({ ok: false, error: 'Room not found.' });

    // Reconnect path: a matching token reclaims its seat.
    let seat = tk ? seatByToken(room, tk) : -1;
    if (seat >= 0) {
      const s = room.seats[seat];
      s.socketId = socket.id;
      s.connected = true;
      if (name) s.name = name.slice(0, 20);
    } else {
      const nm = (name || '').trim();
      if (!nm) return ack && ack({ ok: false, error: 'Please enter your name.' });
      seat = room.seats.findIndex((x) => x === null);
      if (seat < 0) return ack && ack({ ok: false, error: 'Room is full.' });
      tk = token();
      room.seats[seat] = {
        token: tk, name: nm.slice(0, 20), isBot: false,
        socketId: socket.id, connected: true, creator: false,
      };
    }
    socket.join(room.code);
    socketIndex.set(socket.id, { code, token: tk });
    ack && ack({ ok: true, code, token: tk, seat });
    broadcastLobby(room);
    if (room.state) io.to(socket.id).emit('game', gameView(room, seat));
  });

  socket.on('addBot', (_, ack) => {
    const ctx = socketIndex.get(socket.id);
    const room = ctx && rooms.get(ctx.code);
    if (!room) return ack && ack({ ok: false, error: 'Not in a room.' });
    if (room.state) return ack && ack({ ok: false, error: 'Game already started.' });
    const seat = room.seats.findIndex((x) => x === null);
    if (seat < 0) return ack && ack({ ok: false, error: 'No free seats.' });
    room.seats[seat] = {
      token: token(), name: 'Bot ' + (seat + 1), isBot: true,
      socketId: null, connected: true, creator: false,
    };
    ack && ack({ ok: true });
    broadcastLobby(room);
  });

  socket.on('removeBot', ({ seat } = {}, ack) => {
    const ctx = socketIndex.get(socket.id);
    const room = ctx && rooms.get(ctx.code);
    if (!room || room.state) return ack && ack({ ok: false });
    if (room.seats[seat] && room.seats[seat].isBot) room.seats[seat] = null;
    ack && ack({ ok: true });
    broadcastLobby(room);
  });

  socket.on('startGame', (_, ack) => {
    const ctx = socketIndex.get(socket.id);
    const room = ctx && rooms.get(ctx.code);
    if (!room) return ack && ack({ ok: false, error: 'Not in a room.' });
    if (room.state && room.state.phase !== 'finished')
      return ack && ack({ ok: false, error: 'Game already in progress.' });
    if (!allSeatsFilled(room))
      return ack && ack({ ok: false, error: 'Every seat must be filled.' });
    ack && ack({ ok: true });
    startDeal(room);
  });

  socket.on('playCard', ({ id } = {}, ack) => {
    const ctx = socketIndex.get(socket.id);
    const room = ctx && rooms.get(ctx.code);
    if (!room || !room.state) return ack && ack({ ok: false, error: 'No active game.' });
    const seat = seatBySocket(room, socket.id);
    if (seat < 0) return ack && ack({ ok: false, error: 'You are not seated.' });
    const res = G.playCard(room.state, seat, id);
    if (!res.ok) return ack && ack(res);
    ack && ack({ ok: true });
    broadcastGame(room);
    if (room.state.phase === 'finished') return finishDeal(room);
    scheduleBots(room);
  });

  // Rematch: a fresh deal keeping the same seats. Any human can request; we deal
  // once every connected human has voted (solo-with-bots starts immediately).
  socket.on('rematch', (_, ack) => {
    const ctx = socketIndex.get(socket.id);
    const room = ctx && rooms.get(ctx.code);
    if (!room) return ack && ack({ ok: false });
    if (!room.state || room.state.phase !== 'finished')
      return ack && ack({ ok: false, error: 'No finished game to rematch.' });
    room.rematchVotes.add(ctx.token);
    const humans = room.seats.filter((s) => s && !s.isBot && s.connected);
    if (room.rematchVotes.size >= humans.length) startDeal(room);
    else { broadcastLobby(room); ack && ack({ ok: true, waiting: true }); }
  });

  socket.on('disconnect', () => {
    const ctx = socketIndex.get(socket.id);
    socketIndex.delete(socket.id);
    if (!ctx) return;
    const room = rooms.get(ctx.code);
    if (!room) return;
    const seat = seatBySocket(room, socket.id);
    if (seat >= 0) {
      if (!room.state) {
        // Not started yet: free the seat so others can join.
        room.seats[seat] = null;
      } else {
        room.seats[seat].connected = false;
        room.seats[seat].socketId = null;
      }
    }
    broadcastLobby(room);
    // Clean up rooms with no connected humans.
    if (connectedHumans(room) === 0) {
      setTimeout(() => {
        const r = rooms.get(room.code);
        if (r && connectedHumans(r) === 0) {
          if (r.botTimer) clearTimeout(r.botTimer);
          rooms.delete(room.code);
        }
      }, 60 * 1000);
    }
  });
});

// Hourly sweep of stale empty rooms.
setInterval(() => {
  for (const [code, room] of rooms) {
    if (connectedHumans(room) === 0 && Date.now() - room.createdAt > 60 * 60 * 1000) {
      if (room.botTimer) clearTimeout(room.botTimer);
      rooms.delete(code);
    }
  }
}, 30 * 60 * 1000);

// Last-resort safety net: a single bad event (a malformed message, a bot edge case)
// should never take the whole server down and disconnect every room. Log it loudly
// and keep serving. The stack trace shows up in the Render "Logs" tab for debugging.
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

server.listen(PORT, () => {
  console.log(`Mendicot server running on http://localhost:${PORT}`);
});
