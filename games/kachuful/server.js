// server.js (Kachuful) — registers an isolated Socket.IO namespace ("/kf") sharing the
// HTTP server/port with the other games but none of their logic. Handles rooms, seats,
// reconnection, bots, the per-turn bid timer, the pause between hands, and the running
// (per-player, cross-hand) scores that live inside the game state. Call register(io) once.
const G = require('./game');
const Bot = require('./bot');

const BID_TIMEOUT = 15000;   // 15s per human bidding turn → auto-bid the bot's estimate
const BID_BOT_DELAY = 650;
const PLAY_BOT_DELAY = 800;
const HAND_PAUSE = 5200;     // pause on the hand-result before dealing the next hand

const token = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const rid = (n = 4) => {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < n; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
};

function register(io) {
  const ns = io.of('/kf');
  const rooms = new Map();   // code -> room
  const index = new Map();   // socketId -> { code, token }

  const seatBySocket = (room, sid) => room.seats.findIndex((s) => s && s.socketId === sid);
  const seatByToken = (room, tk) => room.seats.findIndex((s) => s && s.token === tk);
  const connectedHumans = (room) => room.seats.filter((s) => s && !s.isBot && s.connected).length;
  const allFilled = (room) => room.seats.every((s) => s !== null);

  function newRoom(numPlayers, decks) {
    numPlayers = Math.max(3, Math.min(7, Number(numPlayers) || 4));
    decks = G.decksFor(decks);
    let code; do { code = rid(); } while (rooms.has(code));
    const room = {
      code, numPlayers, decks,
      seats: Array.from({ length: numPlayers }, () => null),
      state: null, rematchVotes: new Set(),
      timer: null, bidDeadline: null, createdAt: Date.now(),
    };
    rooms.set(code, room);
    return room;
  }

  const clearTimer = (room) => { if (room.timer) { clearTimeout(room.timer); room.timer = null; } room.bidDeadline = null; };

  // ---- views ----
  function lobbyPayload(room) {
    return {
      code: room.code, numPlayers: room.numPlayers, decks: room.decks,
      seats: room.seats.map((s) => s ? { name: s.name, isBot: s.isBot, connected: s.connected, creator: !!s.creator } : null),
      inProgress: !!room.state,
      started: !!room.state && room.state.phase !== 'finished',
    };
  }

  function gameView(room, seat) {
    const st = room.state;
    if (!st) return null;
    const names = room.seats.map((s) => s ? s.name : '—');
    const isBot = room.seats.map((s) => !!(s && s.isBot));
    const connected = room.seats.map((s) => !!(s && (s.isBot || s.connected)));
    const hand = seat != null && seat >= 0 ? st.hands[seat] : [];
    return {
      you: seat, phase: st.phase, numPlayers: st.numPlayers, decks: st.decks,
      names, isBot, connected,
      hand, handCounts: st.hands.map((h) => h.length),
      // hand meta
      handNumber: st.handIndex + 1, totalHands: st.totalHands,
      cardsThisHand: st.cardsThisHand, trump: st.trump, dealer: st.dealer,
      // bidding
      bidTurn: st.bidTurn, bids: st.bids,
      dealerForbidden: seat != null && seat >= 0 ? G.dealerForbidden(st, seat) : -1,
      bidDeadline: st.phase === 'bidding' ? room.bidDeadline : null,
      // play
      leader: st.leader, turn: st.turn, leadSuit: st.leadSuit,
      currentTrick: st.currentTrick, trickNumber: st.trickNumber, lastTrick: st.lastTrick,
      tricksWon: st.tricksWon,
      legal: st.phase === 'playing' && seat === st.turn ? G.legalMoves(st, seat).map((c) => c.uid) : [],
      // scores + results
      scores: st.scores, handResult: st.handResult, result: st.result,
    };
  }

  const broadcastLobby = (room) => ns.to(room.code).emit('lobby', lobbyPayload(room));
  function broadcastGame(room) {
    if (!room.state) return;
    for (let seat = 0; seat < room.numPlayers; seat++) {
      const s = room.seats[seat];
      if (s && !s.isBot && s.socketId && s.connected) ns.to(s.socketId).emit('game', gameView(room, seat));
    }
  }

  const safe = (room, fn) => { try { fn(); } catch (e) { console.error('[kf] error in room', room && room.code, e); } };

  // ---- turn driver ----
  function scheduleActor(room) {
    const st = room.state;
    if (!st) return;
    if (st.phase === 'bidding') {
      const s = room.seats[st.bidTurn]; if (!s) return;
      if (s.isBot) room.timer = setTimeout(() => safe(room, () => botBid(room)), BID_BOT_DELAY);
      else { room.bidDeadline = Date.now() + BID_TIMEOUT; room.timer = setTimeout(() => safe(room, () => autoBid(room, st.bidTurn)), BID_TIMEOUT); }
    } else if (st.phase === 'playing') {
      const s = room.seats[st.turn];
      if (s && s.isBot) room.timer = setTimeout(() => safe(room, () => botPlay(room)), PLAY_BOT_DELAY);
    } else if (st.phase === 'handOver') {
      room.timer = setTimeout(() => safe(room, () => { G.nextHand(room.state, Math.random); progress(room); }), HAND_PAUSE);
    }
  }

  function progress(room) {
    clearTimer(room);
    const st = room.state;
    if (st && st.phase === 'finished') room.rematchVotes = room.rematchVotes || new Set();
    if (st && st.phase !== 'finished') scheduleActor(room);
    broadcastLobby(room);
    broadcastGame(room);
  }

  function botBid(room) {
    const st = room.state; if (!st || st.phase !== 'bidding') return;
    const seat = st.bidTurn; const s = room.seats[seat]; if (!s || !s.isBot) return;
    G.bid(st, seat, Bot.chooseBid(st, seat));
    progress(room);
  }
  function autoBid(room, seat) {
    const st = room.state; if (!st || st.phase !== 'bidding' || st.bidTurn !== seat) return;
    G.bid(st, seat, Bot.chooseBid(st, seat)); // auto-pick a legal estimate for the idle human
    progress(room);
  }
  function botPlay(room) {
    const st = room.state; if (!st || st.phase !== 'playing') return;
    const seat = st.turn; const s = room.seats[seat]; if (!s || !s.isBot) return;
    const card = Bot.chooseCard(st, seat); if (!card) return;
    G.playCard(st, seat, card.uid);
    progress(room);
  }

  function startGame(room) {
    room.state = G.createGame(Math.random, room.numPlayers, room.decks);
    room.rematchVotes = new Set();
    progress(room);
  }

  // ---- socket handlers ----
  ns.on('connection', (socket) => {
    socket.on('createRoom', ({ name, players, decks } = {}, ack) => {
      const nm = (name || '').trim();
      if (!nm) return ack && ack({ ok: false, error: 'Please enter your name.' });
      const room = newRoom(players, decks);
      const tk = token();
      room.seats[0] = { token: tk, name: nm.slice(0, 20), isBot: false, socketId: socket.id, connected: true, creator: true };
      socket.join(room.code); index.set(socket.id, { code: room.code, token: tk });
      ack && ack({ ok: true, code: room.code, token: tk, seat: 0 });
      broadcastLobby(room);
    });

    socket.on('joinRoom', ({ code, name, token: tk } = {}, ack) => {
      code = (code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return ack && ack({ ok: false, error: 'Room not found.' });
      let seat = tk ? seatByToken(room, tk) : -1;
      if (seat >= 0) {
        const s = room.seats[seat]; s.socketId = socket.id; s.connected = true; if (name) s.name = name.slice(0, 20);
      } else {
        const nm = (name || '').trim();
        if (!nm) return ack && ack({ ok: false, error: 'Please enter your name.' });
        seat = room.seats.findIndex((x) => x === null);
        if (seat < 0) return ack && ack({ ok: false, error: 'Room is full.' });
        tk = token();
        room.seats[seat] = { token: tk, name: nm.slice(0, 20), isBot: false, socketId: socket.id, connected: true, creator: false };
      }
      socket.join(room.code); index.set(socket.id, { code, token: tk });
      ack && ack({ ok: true, code, token: tk, seat });
      broadcastLobby(room);
      if (room.state) ns.to(socket.id).emit('game', gameView(room, seat));
    });

    socket.on('addBot', (_, ack) => {
      const ctx = index.get(socket.id); const room = ctx && rooms.get(ctx.code);
      if (!room || room.state) return ack && ack({ ok: false });
      const seat = room.seats.findIndex((x) => x === null);
      if (seat < 0) return ack && ack({ ok: false, error: 'No free seats.' });
      room.seats[seat] = { token: token(), name: 'Bot ' + (seat + 1), isBot: true, socketId: null, connected: true, creator: false };
      ack && ack({ ok: true }); broadcastLobby(room);
    });

    socket.on('removeBot', ({ seat } = {}, ack) => {
      const ctx = index.get(socket.id); const room = ctx && rooms.get(ctx.code);
      if (!room || room.state) return ack && ack({ ok: false });
      if (room.seats[seat] && room.seats[seat].isBot) room.seats[seat] = null;
      ack && ack({ ok: true }); broadcastLobby(room);
    });

    socket.on('startGame', (_, ack) => {
      const ctx = index.get(socket.id); const room = ctx && rooms.get(ctx.code);
      if (!room) return ack && ack({ ok: false, error: 'Not in a room.' });
      if (room.state && room.state.phase !== 'finished') return ack && ack({ ok: false, error: 'Game in progress.' });
      if (!allFilled(room)) return ack && ack({ ok: false, error: 'Every seat must be filled.' });
      ack && ack({ ok: true }); startGame(room);
    });

    const actorSeat = (room) => (index.get(socket.id) ? seatBySocket(room, socket.id) : -1);

    socket.on('bid', ({ amount } = {}, ack) => {
      const ctx = index.get(socket.id); const room = ctx && rooms.get(ctx.code);
      if (!room || !room.state) return ack && ack({ ok: false });
      const res = G.bid(room.state, actorSeat(room), amount);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true }); progress(room);
    });
    socket.on('playCard', ({ id } = {}, ack) => {
      const ctx = index.get(socket.id); const room = ctx && rooms.get(ctx.code);
      if (!room || !room.state) return ack && ack({ ok: false });
      const res = G.playCard(room.state, actorSeat(room), id);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true }); progress(room);
    });

    socket.on('rematch', (_, ack) => {
      const ctx = index.get(socket.id); const room = ctx && rooms.get(ctx.code);
      if (!room) return ack && ack({ ok: false });
      if (!room.state || room.state.phase !== 'finished') return ack && ack({ ok: false, error: 'No finished game.' });
      room.rematchVotes.add(ctx.token);
      const humans = room.seats.filter((s) => s && !s.isBot && s.connected);
      if (room.rematchVotes.size >= humans.length) startGame(room);
      else { broadcastLobby(room); ack && ack({ ok: true, waiting: true }); }
    });

    socket.on('disconnect', () => {
      const ctx = index.get(socket.id); index.delete(socket.id);
      if (!ctx) return;
      const room = rooms.get(ctx.code); if (!room) return;
      const seat = seatBySocket(room, socket.id);
      if (seat >= 0) {
        if (!room.state) room.seats[seat] = null;
        else { room.seats[seat].connected = false; room.seats[seat].socketId = null; }
      }
      broadcastLobby(room);
      if (connectedHumans(room) === 0) {
        setTimeout(() => {
          const r = rooms.get(room.code);
          if (r && connectedHumans(r) === 0) { clearTimer(r); rooms.delete(room.code); }
        }, 60 * 1000);
      }
    });
  });
}

module.exports = register;
