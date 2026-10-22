// server.js (Kali Tiri) — registers an isolated Socket.IO namespace ("/kt") so this
// game shares the HTTP server/port with Mendicot but none of its logic. Handles rooms,
// seats, reconnection, bots, the 10s bid timer, secret-partner views, and per-player
// running scores. Call register(io) once from the main server.
const G = require('./game');
const Bot = require('./bot');

const BID_TIMEOUT = 10000;     // 10s per human bidding turn → auto-pass
const BID_BOT_DELAY = 700;
const DECLARE_BOT_DELAY = 900;
const PLAY_BOT_DELAY = 900;

const token = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const rid = (n = 4) => {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < n; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
};

function register(io) {
  const ns = io.of('/kt');
  const rooms = new Map();          // code -> room
  const index = new Map();          // socketId -> { code, token }

  const seatBySocket = (room, sid) => room.seats.findIndex((s) => s && s.socketId === sid);
  const seatByToken = (room, tk) => room.seats.findIndex((s) => s && s.token === tk);
  const connectedHumans = (room) => room.seats.filter((s) => s && !s.isBot && s.connected).length;
  const allFilled = (room) => room.seats.every((s) => s !== null);

  function newRoom(numPlayers, decks) {
    numPlayers = [4, 6, 8].includes(numPlayers) ? numPlayers : 4;
    decks = G.decksFor(numPlayers, decks);
    let code; do { code = rid(); } while (rooms.has(code));
    const room = {
      code, numPlayers, decks,
      seats: Array.from({ length: numPlayers }, () => null),
      state: null, scores: Array(numPlayers).fill(0),
      rematchVotes: new Set(), scored: false,
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
      scores: room.scores,
    };
  }

  function gameView(room, seat) {
    const st = room.state;
    if (!st) return null;
    const names = room.seats.map((s) => s ? s.name : '—');
    const isBot = room.seats.map((s) => !!(s && s.isBot));
    const connected = room.seats.map((s) => !!(s && (s.isBot || s.connected)));
    const hand = seat != null && seat >= 0 ? st.hands[seat] : [];
    const onTeam = seat != null && seat >= 0 &&
      (seat === st.declarer || st.revealed[seat] || (st.remainingCalls || []).some((id) => hand.some((c) => c.id === id)));
    return {
      you: seat, phase: st.phase, numPlayers: st.numPlayers, decks: st.decks,
      tricksPerHand: st.tricksPerHand, names, isBot, connected,
      hand, handCounts: st.hands.map((h) => h.length),
      // bidding (public)
      bidMin: st.bidMin, bidMax: st.bidMax, bidTurn: st.bidTurn, bids: st.bids,
      passed: st.passed, highBid: st.highBid, highBidder: st.highBidder, forcedBid: st.forcedBid,
      bidDeadline: st.phase === 'bidding' ? room.bidDeadline : null,
      // contract / declare
      declarer: st.declarer, contract: st.contract, trump: st.trump,
      partnerCards: st.partnerCards, revealed: st.revealed, youOnBiddingTeam: onTeam,
      // play
      leader: st.leader, turn: st.turn, leadSuit: st.leadSuit,
      currentTrick: st.currentTrick, trickNumber: st.trickNumber, lastTrick: st.lastTrick,
      pointsBySeat: st.pointsBySeat,
      legal: st.phase === 'playing' && seat === st.turn ? G.legalMoves(st, seat).map((c) => c.uid) : [],
      // result + running match score (per player)
      result: st.result, scores: room.scores,
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

  // ---- turn driver ----
  function scheduleActor(room) {
    const st = room.state;
    if (!st) return;
    if (st.phase === 'bidding') {
      const s = room.seats[st.bidTurn];
      if (!s) return;
      if (s.isBot) room.timer = setTimeout(() => safe(room, () => botBid(room)), BID_BOT_DELAY);
      else { room.bidDeadline = Date.now() + BID_TIMEOUT; room.timer = setTimeout(() => safe(room, () => autoBid(room, st.bidTurn)), BID_TIMEOUT); }
    } else if (st.phase === 'declaring') {
      const s = room.seats[st.declarer];
      if (s && s.isBot) room.timer = setTimeout(() => safe(room, () => botDeclare(room)), DECLARE_BOT_DELAY);
    } else if (st.phase === 'playing') {
      const s = room.seats[st.turn];
      if (s && s.isBot) room.timer = setTimeout(() => safe(room, () => botPlay(room)), PLAY_BOT_DELAY);
    }
  }

  // After any action: bank scores once on finish, schedule the next actor, broadcast.
  function progress(room) {
    clearTimer(room);
    const st = room.state;
    if (st && st.phase === 'finished' && !room.scored) {
      room.scored = true;
      for (let s = 0; s < room.numPlayers; s++) room.scores[s] += st.pointsBySeat[s];
      room.rematchVotes = new Set();
    }
    if (st && st.phase !== 'finished') scheduleActor(room);
    broadcastLobby(room);
    broadcastGame(room);
  }

  const safe = (room, fn) => { try { fn(); } catch (e) { console.error('[kt] error in room', room && room.code, e); } };

  function botBid(room) {
    const st = room.state; if (!st || st.phase !== 'bidding') return;
    const seat = st.bidTurn; const s = room.seats[seat]; if (!s || !s.isBot) return;
    const d = Bot.chooseBid(st, seat);
    if (d.action === 'pass') G.passBid(st, seat); else G.bid(st, seat, d.amount);
    progress(room);
  }
  function autoBid(room, seat) {
    const st = room.state; if (!st || st.phase !== 'bidding' || st.bidTurn !== seat) return;
    const forced = G.activeSeats(st).length === 1 && st.highBid === null;
    if (forced) G.bid(st, seat, st.bidMin); else G.passBid(st, seat);
    progress(room);
  }
  function botDeclare(room) {
    const st = room.state; if (!st || st.phase !== 'declaring') return;
    const seat = st.declarer; const s = room.seats[seat]; if (!s || !s.isBot) return;
    const { trump, partnerCards } = Bot.chooseDeclare(st, seat);
    G.declare(st, seat, trump, partnerCards);
    progress(room);
  }
  function botPlay(room) {
    const st = room.state; if (!st || st.phase !== 'playing') return;
    const seat = st.turn; const s = room.seats[seat]; if (!s || !s.isBot) return;
    const card = Bot.chooseCard(st, seat); if (!card) return;
    G.playCard(st, seat, card.uid);
    progress(room);
  }

  function startDeal(room) {
    room.state = G.createGame(Math.random, room.numPlayers, room.decks);
    room.scored = false;
    room.rematchVotes = new Set();
    progress(room);
  }

  // ---- socket handlers ----
  ns.on('connection', (socket) => {
    socket.on('createRoom', ({ name, players, decks } = {}, ack) => {
      const nm = (name || '').trim();
      if (!nm) return ack && ack({ ok: false, error: 'Please enter your name.' });
      const room = newRoom(players, decks === 2 ? 2 : 1);
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
      ack && ack({ ok: true }); startDeal(room);
    });

    const actorSeat = (room) => { const c = index.get(socket.id); return c ? seatBySocket(room, socket.id) : -1; };

    socket.on('bid', ({ amount } = {}, ack) => {
      const ctx = index.get(socket.id); const room = ctx && rooms.get(ctx.code);
      if (!room || !room.state) return ack && ack({ ok: false });
      const res = G.bid(room.state, actorSeat(room), amount);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true }); progress(room);
    });
    socket.on('passBid', (_, ack) => {
      const ctx = index.get(socket.id); const room = ctx && rooms.get(ctx.code);
      if (!room || !room.state) return ack && ack({ ok: false });
      const res = G.passBid(room.state, actorSeat(room));
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true }); progress(room);
    });
    socket.on('declare', ({ trump, partnerCards } = {}, ack) => {
      const ctx = index.get(socket.id); const room = ctx && rooms.get(ctx.code);
      if (!room || !room.state) return ack && ack({ ok: false });
      const res = G.declare(room.state, actorSeat(room), trump, partnerCards);
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
      if (room.rematchVotes.size >= humans.length) startDeal(room);
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
