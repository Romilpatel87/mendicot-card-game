/* client.js — Kachuful front-end. Talks to the server over the "/kf" Socket.IO namespace. */
(() => {
  const socket = io('/kf');
  const $ = (id) => document.getElementById(id);

  let me = { name: '', code: '', token: '', seat: -1 };
  let lobby = null, game = null, selected = null;
  let viewLock = false, queuedView = null, shownTricks = -1;

  const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const SUIT_NAME = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };
  const isRed = (s) => s === 'H' || s === 'D';

  // keep free hosts awake during play
  setInterval(() => { if (me.code) fetch('/healthz').catch(() => {}); }, 4 * 60 * 1000);

  // ---- session ----
  const SKEY = 'kachuful.session';
  const saveSession = () => localStorage.setItem(SKEY, JSON.stringify({ code: me.code, token: me.token, name: me.name }));
  const loadSession = () => { try { return JSON.parse(localStorage.getItem(SKEY)); } catch { return null; } };
  const clearSession = () => localStorage.removeItem(SKEY);

  const showScreen = (name) => { for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === name); };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function cardEl(card, opts = {}) {
    const el = document.createElement('div');
    const isTrump = game && card.suit === game.trump;
    el.className = 'card' + (isRed(card.suit) ? ' red' : '') + (isTrump ? ' trump' : '') + (opts.cls ? ' ' + opts.cls : '');
    el.dataset.id = card.id; el.dataset.uid = card.uid || card.id;
    const s = SUIT[card.suit];
    el.innerHTML =
      `<span class="corner tl"><span class="r">${card.label}</span><span class="s">${s}</span></span>` +
      `<span class="pip">${s}</span>` +
      `<span class="corner br"><span class="r">${card.label}</span><span class="s">${s}</span></span>`;
    return el;
  }

  // ======================================================================
  //  HOME
  // ======================================================================
  let chosenPlayers = 4, chosenDecks = 1;
  const modeToggle = $('modeToggle'), deckToggle = $('deckToggle');
  const ladderText = (n, decks) => {
    const start = Math.min(10, Math.floor((52 * decks) / n));
    return `Starts at ${start} cards, down to 1 and back up — ${start * 2 - 1} hands.`;
  };
  const setLadderNote = () => { $('ladderNote').textContent = ladderText(chosenPlayers, chosenDecks); };
  modeToggle.querySelectorAll('.mode-opt').forEach((b) => b.onclick = () => {
    chosenPlayers = +b.dataset.players;
    modeToggle.querySelectorAll('.mode-opt').forEach((x) => x.classList.toggle('active', x === b));
    setLadderNote();
  });
  deckToggle.querySelectorAll('.mode-opt').forEach((b) => b.onclick = () => {
    chosenDecks = +b.dataset.decks;
    deckToggle.querySelectorAll('.mode-opt').forEach((x) => x.classList.toggle('active', x === b));
    setLadderNote();
  });
  setLadderNote();

  $('createBtn').onclick = () => {
    const name = requireName(); if (!name) return;
    me.name = name;
    socket.emit('createRoom', { name, players: chosenPlayers, decks: chosenDecks }, (res) => {
      if (!res || !res.ok) return setHomeError(res && res.error);
      me.code = res.code; me.token = res.token; me.seat = res.seat; saveSession();
    });
  };
  $('joinBtn').onclick = () => doJoin();
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  function doJoin() {
    const name = requireName(); if (!name) return;
    const code = $('codeInput').value.trim().toUpperCase();
    if (!code) return setHomeError('Enter a room code.');
    me.name = name;
    socket.emit('joinRoom', { code, name }, (res) => {
      if (!res || !res.ok) return setHomeError(res && res.error);
      me.code = res.code; me.token = res.token; me.seat = res.seat; saveSession();
    });
  }
  const setHomeError = (m) => { $('homeError').textContent = m || 'Something went wrong.'; };
  function requireName() {
    const name = $('nameInput').value.trim();
    if (!name) { setHomeError('Please enter your name to play.'); $('nameInput').classList.add('invalid'); $('nameInput').focus(); return ''; }
    $('nameInput').classList.remove('invalid'); return name;
  }
  $('nameInput').addEventListener('input', () => { $('nameInput').classList.remove('invalid'); if ($('homeError').textContent === 'Please enter your name to play.') $('homeError').textContent = ''; });

  $('rulesToggle').onclick = () => $('rulesBox').classList.toggle('open');
  $('rulesBox').innerHTML = `
    <h4>The idea</h4>
    <p>Each hand you <b>predict</b> how many tricks you'll win. Hit it <b>exactly</b> for a bonus — it's every player for themselves.</p>
    <h4>The deal</h4>
    <ul><li>Cards shrink by one each hand down to a single card, then grow back up.</li>
    <li>Trump rotates every hand: ♠ → ♦ → ♣ → ♥ …</li></ul>
    <h4>Bidding</h4>
    <ul><li>Say how many tricks you'll take (0 is fine). The dealer bids last and can't make the bids total the number of tricks — someone always misses.</li></ul>
    <h4>Play</h4>
    <ul><li>Follow suit if you can; highest trump wins, else the highest card of the led suit.</li>
    <li><b>Double deck:</b> every card exists twice — if an identical card is played after yours, the <b>second one wins</b>.</li></ul>
    <h4>Scoring</h4>
    <ul><li><b>1 point</b> per trick won, <b>+10</b> if you took exactly your bid.</li>
    <li>Highest total after the final hand wins.</li></ul>`;

  // ======================================================================
  //  LOBBY
  // ======================================================================
  function renderLobby() {
    if (!lobby) return;
    $('lobbyCode').textContent = lobby.code;
    const n = lobby.numPlayers || 4;
    const wrap = $('lobbySeats'); wrap.innerHTML = '';
    for (let seat = 0; seat < n; seat++) {
      const s = lobby.seats[seat];
      const div = document.createElement('div');
      div.className = 'seat-card' + (s ? ' filled' : '') + (seat === me.seat ? ' you' : '');
      if (s) {
        div.innerHTML = `<div class="seat-name">${escapeHtml(s.name)}${seat === me.seat ? ' <span class="seat-tag">(you)</span>' : ''}</div>` +
          (s.isBot ? `<div class="mini add" data-rm="${seat}">remove bot</div>` : `<div class="mini">${s.connected ? 'ready' : 'reconnecting…'}</div>`);
      } else {
        div.innerHTML = `<div class="seat-name" style="opacity:.6">Empty</div><div class="mini add" data-bot="1">+ add bot</div>`;
      }
      wrap.appendChild(div);
    }
    wrap.querySelectorAll('[data-bot]').forEach((b) => b.onclick = () => socket.emit('addBot', {}, () => {}));
    wrap.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => socket.emit('removeBot', { seat: +b.dataset.rm }, () => {}));
    $('startBtn').disabled = !lobby.seats.every((x) => x);
  }
  $('lobbyCode').onclick = () => { navigator.clipboard && navigator.clipboard.writeText(lobby.code); const el = $('lobbyCode'), t = el.textContent; el.textContent = 'COPIED'; setTimeout(() => el.textContent = t, 900); };
  $('startBtn').onclick = () => socket.emit('startGame', {}, (res) => { if (res && !res.ok) alert(res.error); });
  $('leaveLobbyBtn').onclick = leaveRoom;
  $('leaveGameBtn').onclick = leaveRoom;
  function leaveRoom() { clearSession(); location.href = '/'; }

  // ======================================================================
  //  TABLE
  // ======================================================================
  const POS_BY_N = {
    3: ['bottom', 'top-right', 'top-left'],
    4: ['bottom', 'right', 'top', 'left'],
    5: ['bottom', 'right', 'top-right', 'top-left', 'left'],
    6: ['bottom', 'bottom-right', 'top-right', 'top', 'top-left', 'bottom-left'],
    7: ['bottom', 'bottom-right', 'right', 'top-right', 'top-left', 'left', 'bottom-left'],
  };
  const numPlayers = (v) => (v && v.numPlayers) || (lobby && lobby.numPlayers) || 4;
  const posOf = (seat, v) => { const n = numPlayers(v); return (POS_BY_N[n] || POS_BY_N[4])[(seat - me.seat + n) % n]; };

  function renderPlayers(v, completed) {
    const layer = $('seatsLayer'); layer.innerHTML = ''; const n = numPlayers(v);
    for (let seat = 0; seat < n; seat++) {
      const box = document.createElement('div'); box.className = 'seat-box pos-' + posOf(seat, v);
      const isTurn = (v.phase === 'bidding' && v.bidTurn === seat) || (v.phase === 'playing' && v.turn === seat && !completed);
      const p = document.createElement('div');
      p.className = 'player' + (isTurn ? ' turn' : '');
      const count = v.handCounts[seat];
      const backs = Array.from({ length: Math.min(count, 8) }, () => '<span class="cardback"></span>').join('');
      let chip = '';
      if (v.phase === 'bidding') {
        if (v.bids[seat] != null) chip = `<div class="seat-chip set">bid ${v.bids[seat]}</div>`;
      } else {
        const bid = v.bids[seat], won = v.tricksWon[seat];
        const cls = won === bid ? 'exact' : (won > bid ? 'over' : 'under');
        chip = `<div class="seat-chip ${cls}">${won} / ${bid}</div>`;
      }
      const dealer = seat === v.dealer ? '<span class="badge-dealer">DEAL</span>' : '';
      p.innerHTML = `<div class="pname">${escapeHtml(v.names[seat])}${seat === me.seat ? ' <span class="badge-you">YOU</span>' : ''}${dealer}</div>` +
        `<div class="cardback-row">${backs}</div>` + chip;
      box.appendChild(p); layer.appendChild(box);
    }
  }

  function renderTrick(v, completed) {
    const area = $('trickArea'); const n = numPlayers(v); area.className = 'trick n-' + n;
    area.innerHTML = '';
    const plays = completed ? completed.plays : (v.currentTrick || []);
    const winner = completed ? completed.winner : null;
    const R = window.innerWidth <= 680 ? 104 : 158;
    for (const play of plays) {
      const k = (play.seat - me.seat + n) % n;
      const theta = (90 - k * (360 / n)) * Math.PI / 180;
      const dx = Math.round(Math.cos(theta) * R), dy = Math.round(Math.sin(theta) * R);
      const c = cardEl(play.card, { cls: 'tcard' + (winner === play.seat ? ' win' : '') });
      c.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      c.dataset.player = v.names[play.seat] + (play.seat === me.seat ? ' (you)' : '');
      area.appendChild(c);
    }
  }

  function renderStatus(v, completed) {
    const tb = $('trumpBadge');
    if (v.trump) { tb.classList.add('show'); tb.innerHTML = `Trump · <span style="color:${isRed(v.trump) ? '#ffb3a0' : '#fff'}">${SUIT[v.trump]} ${SUIT_NAME[v.trump]}</span>`; }
    else { tb.classList.remove('show'); tb.textContent = ''; }
    const sl = $('statusLine');
    if (completed) { sl.textContent = `${v.names[completed.winner]} takes the trick`; return; }
    if (v.phase === 'bidding') sl.textContent = v.bidTurn === me.seat ? 'Your turn — predict your tricks' : `${v.names[v.bidTurn]} is bidding…`;
    else if (v.phase === 'playing') sl.textContent = v.turn === me.seat ? 'Your turn — play a card' : `Waiting for ${v.names[v.turn]}…`;
    else if (v.phase === 'handOver') sl.textContent = 'Hand complete';
    else sl.textContent = 'Game over';
  }

  function renderScoreboard(v) {
    const sb = $('scoreboard');
    const totalBid = v.bids.reduce((a, b) => a + (b || 0), 0);
    let rows = '<div class="sb-scorelist">';
    // sort by running score desc for a leaderboard feel
    const order = Array.from({ length: v.numPlayers }, (_, s) => s).sort((a, b) => v.scores[b] - v.scores[a]);
    for (const s of order) {
      const bid = v.bids[s], won = v.tricksWon[s];
      const tag = v.phase === 'bidding'
        ? (bid != null ? `<span class="sb-bid">bid ${bid}</span>` : '<span class="sb-bid dim">—</span>')
        : `<span class="sb-bid ${won === bid ? 'exact' : ''}">${won}/${bid}</span>`;
      rows += `<div class="row ${s === me.seat ? 'you' : ''}"><span class="nm">${escapeHtml(v.names[s])}${s === me.seat ? ' (you)' : ''}</span>${tag}<span class="tot">${v.scores[s]}</span></div>`;
    }
    rows += '</div>';
    sb.innerHTML =
      `<h4>Hand ${v.handNumber} / ${v.totalHands}</h4>` +
      `<div class="sb-row"><span class="sb-label">Cards</span><span>${v.cardsThisHand}</span></div>` +
      `<div class="sb-row"><span class="sb-label">Trump</span><span class="${isRed(v.trump) ? 'red' : ''}">${SUIT[v.trump]} ${SUIT_NAME[v.trump]}</span></div>` +
      (v.phase === 'bidding'
        ? `<div class="sb-row"><span class="sb-label">Bids so far</span><span>${totalBid} / ${v.cardsThisHand}</span></div>`
        : `<div class="sb-row"><span class="sb-label">Tricks</span><span>${v.trickNumber} / ${v.cardsThisHand}</span></div>`) +
      `<div class="sb-section-title">Leaderboard</div>` + rows;
  }

  function renderMatchStrip(v) {
    $('matchStrip').innerHTML = `Hand <b>${v.handNumber}</b>/${v.totalHands} · ${v.cardsThisHand} cards · Trump <span class="${isRed(v.trump) ? 'tr' : ''}">${SUIT[v.trump]}</span>${v.decks === 2 ? ' · 2 decks' : ''}`;
  }

  // ---- bid panel ----
  const ackErr = (res) => { if (res && !res.ok) $('statusLine').textContent = res.error; };
  function renderBidPanel(v) {
    const p = $('bidPanel');
    if (v.phase !== 'bidding' || v.bidTurn !== me.seat) { p.hidden = true; return; }
    p.hidden = false;
    let html = `<div class="panel-title">Your prediction</div>` +
      `<div class="panel-sub">How many of the <b>${v.cardsThisHand}</b> tricks will you take?</div>` +
      `<div class="bid-row">`;
    for (let k = 0; k <= v.cardsThisHand; k++) {
      const forbidden = k === v.dealerForbidden;
      html += `<button class="bid-btn${forbidden ? ' forbidden' : ''}" data-amt="${k}"${forbidden ? ' disabled title="Dealer can\'t bid this"' : ''}>${k}</button>`;
    }
    html += `</div>`;
    if (v.dealerForbidden >= 0) html += `<div class="panel-note">You're the dealer — you can't bid ${v.dealerForbidden}.</div>`;
    html += `<div class="bid-timer" id="bidTimer"></div>`;
    p.innerHTML = html;
    p.querySelectorAll('[data-amt]').forEach((b) => b.onclick = () => { if (!b.disabled) socket.emit('bid', { amount: +b.dataset.amt }, ackErr); });
    updateBidTimer(v);
  }
  function updateBidTimer(v) {
    const el = $('bidTimer'); if (!el) return;
    if (!v.bidDeadline) { el.textContent = ''; return; }
    const ms = Math.max(0, v.bidDeadline - Date.now());
    el.innerHTML = `${Math.ceil(ms / 1000)}s<div class="bar"><i style="width:${Math.min(100, ms / 150)}%"></i></div>`;
  }
  setInterval(() => {
    if (!game || game.phase !== 'bidding' || !game.bidDeadline) return;
    if (game.bidTurn === me.seat) updateBidTimer(game);
    else { const ms = Math.max(0, game.bidDeadline - Date.now()); $('statusLine').textContent = `${game.names[game.bidTurn]} is bidding… ${Math.ceil(ms / 1000)}s`; }
  }, 250);

  // ---- between-hands panel ----
  function renderHandPanel(v) {
    const p = $('handPanel');
    if (v.phase !== 'handOver' || !v.handResult) { p.hidden = true; return; }
    const r = v.handResult;
    p.hidden = false;
    const order = Array.from({ length: v.numPlayers }, (_, s) => s).sort((a, b) => r.deltas[b] - r.deltas[a]);
    let rows = '';
    for (const s of order) {
      const made = r.made[s];
      rows += `<div class="hp-row ${s === me.seat ? 'you' : ''}">` +
        `<span class="hp-name">${escapeHtml(v.names[s])}${s === me.seat ? ' (you)' : ''}</span>` +
        `<span class="hp-mid">bid ${r.bids[s]} · took ${r.tricksWon[s]}</span>` +
        `<span class="hp-delta ${made ? 'good' : 'bad'}">${made ? '✓ +' + r.deltas[s] : '+' + r.deltas[s]}</span>` +
        `<span class="hp-tot">${r.scores[s]}</span></div>`;
    }
    p.innerHTML =
      `<div class="panel-title">Hand ${r.handNumber} done</div>` +
      `<div class="panel-sub">Exact bids score <b>+10</b> and are marked ✓. Next hand dealing…</div>` +
      `<div class="hp-list">${rows}</div>`;
  }

  function renderHand(v, completed) {
    const hand = $('handArea'); hand.innerHTML = '';
    const myTurn = v.phase === 'playing' && v.turn === me.seat && !completed;
    const legal = new Set(v.legal || []);
    for (const card of (v.hand || [])) {
      const uid = card.uid || card.id;
      const playable = myTurn && legal.has(uid);
      const cls = (playable ? 'playable' : (myTurn ? 'illegal' : '')) + (selected === uid ? ' selected' : '');
      const el = cardEl(card, { cls });
      if (playable) el.onclick = () => { selected = (selected === uid) ? null : uid; renderHand(game, null); updatePlayBtn(); };
      hand.appendChild(el);
    }
    updatePlayBtn();
  }
  function updatePlayBtn() { const myTurn = game && game.phase === 'playing' && game.turn === me.seat; $('playBtn').disabled = !(myTurn && selected); }
  $('playBtn').onclick = () => { if (!selected) return; const id = selected; selected = null; socket.emit('playCard', { id }, ackErr); };

  function renderTable(v, completed) {
    showScreen('table');
    renderMatchStrip(v);
    renderPlayers(v, completed);
    renderTrick(v, completed);
    renderStatus(v, completed);
    renderScoreboard(v);
    renderHand(v, completed);
    renderBidPanel(v);
    renderHandPanel(v);
  }

  // ---- result ----
  function showResult(v) {
    const r = v.result;
    const iWon = r.winners.includes(me.seat);
    $('overlay').classList.add('show');
    const title = $('resultTitle');
    title.className = iWon ? 'win' : 'lose';
    $('resultCrest').textContent = iWon ? '❀' : '♣';
    const winnerNames = r.winners.map((s) => v.names[s]).join(' & ');
    title.textContent = iWon ? (r.winners.length > 1 ? 'You share the win!' : 'You win!') : `${winnerNames} ${r.winners.length > 1 ? 'win' : 'wins'}`;
    $('resultDetail').textContent = `Top score ${r.topScore} after ${v.totalHands} hands.`;
    let stats = '<div class="final-table">';
    r.ranking.forEach((s, i) => {
      stats += `<div class="final-row ${s === me.seat ? 'you' : ''} ${r.winners.includes(s) ? 'win' : ''}">` +
        `<span class="fr-rank">${i + 1}</span>` +
        `<span class="fr-name">${escapeHtml(v.names[s])}${s === me.seat ? ' (you)' : ''}</span>` +
        `<span class="fr-score">${r.scores[s]}</span></div>`;
    });
    stats += '</div>';
    $('resultStats').innerHTML = stats;
    $('rematchWait').textContent = '';
  }
  $('rematchBtn').onclick = () => socket.emit('rematch', {}, (res) => {
    if (res && res.waiting) $('rematchWait').textContent = 'Waiting for the others…';
    else if (res && !res.ok) $('rematchWait').textContent = res.error || '';
  });

  // ======================================================================
  //  SOCKET
  // ======================================================================
  function applyView(v) {
    game = v;
    if (v.phase !== 'finished') $('overlay').classList.remove('show');
    if (v.phase === 'bidding') shownTricks = -1;
    const justCompleted = (v.phase === 'playing' || v.phase === 'handOver' || v.phase === 'finished') &&
      v.lastTrick && v.trickNumber > shownTricks && v.currentTrick.length === 0 && v.trickNumber > 0;
    if (justCompleted) {
      shownTricks = v.trickNumber;
      renderTable(v, v.lastTrick);
      viewLock = true;
      setTimeout(() => {
        viewLock = false;
        const nv = queuedView || v; queuedView = null;
        game = nv; shownTricks = Math.max(shownTricks, nv.trickNumber || 0);
        if (nv.phase === 'finished') { renderTable(nv, null); showResult(nv); } else renderTable(nv, null);
      }, 1500);
    } else {
      shownTricks = Math.max(shownTricks, v.trickNumber || 0);
      if (v.phase === 'finished') { renderTable(v, null); showResult(v); } else renderTable(v, null);
    }
  }

  socket.on('lobby', (l) => { lobby = l; if (!l.inProgress) { showScreen('lobby'); renderLobby(); } });
  socket.on('game', (v) => { if (viewLock) { queuedView = v; return; } applyView(v); });

  socket.on('connect', () => {
    const sess = loadSession();
    if (sess && sess.code && sess.token && me.seat < 0) {
      me.name = sess.name || 'Player';
      socket.emit('joinRoom', { code: sess.code, token: sess.token, name: sess.name }, (res) => {
        if (res && res.ok) { me.code = res.code; me.token = res.token; me.seat = res.seat; saveSession(); }
        else { clearSession(); showScreen('home'); }
      });
    }
  });

  const sess0 = loadSession();
  if (sess0 && sess0.name) $('nameInput').value = sess0.name;
})();
