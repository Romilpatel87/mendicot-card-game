/* client.js — Kali Tiri front-end. Talks to the server over the "/kt" Socket.IO namespace. */
(() => {
  const socket = io('/kt');
  const $ = (id) => document.getElementById(id);

  let me = { name: '', code: '', token: '', seat: -1 };
  let lobby = null, game = null, selected = null;
  let viewLock = false, queuedView = null, shownTricks = -1;
  let declareSel = { trump: null, partners: [] };

  const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const SUIT_NAME = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };
  const isRed = (s) => s === 'H' || s === 'D';
  const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  // render a card id ("AH") as a small coloured label "A♥"
  const cardLabelHtml = (id) => { const su = id.slice(-1), r = id.slice(0, -1); return `<span style="color:${isRed(su) ? '#ff9f8f' : '#f4ecd8'}">${r}${SUIT[su]}</span>`; };

  // keep free hosts awake during play
  setInterval(() => { if (me.code) fetch('/healthz').catch(() => {}); }, 4 * 60 * 1000);

  // ---- session ----
  const SKEY = 'kalitiri.session';
  const saveSession = () => localStorage.setItem(SKEY, JSON.stringify({ code: me.code, token: me.token, name: me.name }));
  const loadSession = () => { try { return JSON.parse(localStorage.getItem(SKEY)); } catch { return null; } };
  const clearSession = () => localStorage.removeItem(SKEY);

  const showScreen = (name) => { for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === name); };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function cardEl(card, opts = {}) {
    const el = document.createElement('div');
    const hi = card.points >= 10 || (card.value === 3 && card.suit === 'S'); // honour / point card
    el.className = 'card' + (isRed(card.suit) ? ' red' : '') + (hi ? ' hi' : '') + (opts.cls ? ' ' + opts.cls : '');
    el.dataset.id = card.id; el.dataset.uid = card.uid || card.id;
    const s = SUIT[card.suit];
    // standard rectangular face: rank+suit in opposite corners, big suit pip in the middle
    el.innerHTML =
      `<span class="corner tl"><span class="r">${card.label}</span><span class="s">${s}</span></span>` +
      `<span class="pip">${s}</span>` +
      `<span class="corner br"><span class="r">${card.label}</span><span class="s">${s}</span></span>`;
    if (card.points) { const b = document.createElement('div'); b.className = 'pts-badge'; b.textContent = card.points; el.appendChild(b); }
    return el;
  }

  // ======================================================================
  //  HOME
  // ======================================================================
  let chosenPlayers = 4, chosenDecks = 1;
  const modeToggle = $('modeToggle'), deckField = $('deckField'), deckToggle = $('deckToggle');
  modeToggle.querySelectorAll('.mode-opt').forEach((b) => b.onclick = () => {
    chosenPlayers = +b.dataset.players;
    modeToggle.querySelectorAll('.mode-opt').forEach((x) => x.classList.toggle('active', x === b));
    if (deckField) deckField.hidden = chosenPlayers !== 6;
  });
  deckToggle.querySelectorAll('.mode-opt').forEach((b) => b.onclick = () => {
    chosenDecks = +b.dataset.decks;
    deckToggle.querySelectorAll('.mode-opt').forEach((x) => x.classList.toggle('active', x === b));
  });
  const decksForCreate = () => (chosenPlayers === 8 ? 2 : chosenPlayers === 6 ? chosenDecks : 1);

  $('createBtn').onclick = () => {
    const name = requireName(); if (!name) return;
    me.name = name;
    socket.emit('createRoom', { name, players: chosenPlayers, decks: decksForCreate() }, (res) => {
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
    <h4>The goal</h4>
    <p>Win the <b>bid</b>, then capture at least that many <b>points</b> with your team.</p>
    <h4>Points</h4>
    <ul><li><b>3♠</b> = 30 · A / 10 / J / Q / K = 10 each · 5 = 5 · everything else = 0.</li>
    <li>Total 250 (single deck) or 500 (double).</li></ul>
    <h4>Bidding</h4>
    <ul><li>Bid a point target (min 150 / 300) or <b>pass</b> — passing is final.</li>
    <li>Raise +5 to +20. Highest bid wins and picks the <b>trump</b> and a <b>secret partner</b> card.</li></ul>
    <h4>Play</h4>
    <ul><li>Follow suit; highest trump wins, else the highest card of the led suit.</li>
    <li>The trick winner takes its point cards. A partner is revealed when they play the named card.</li></ul>
    <h4>Winning</h4>
    <p>The bidding team wins the deal if it captures at least its bid — otherwise the others do.</p>`;

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
    4: ['bottom', 'right', 'top', 'left'],
    6: ['bottom', 'bottom-right', 'top-right', 'top', 'top-left', 'bottom-left'],
    8: ['bottom', 'bottom-right', 'right', 'top-right', 'top', 'top-left', 'left', 'bottom-left'],
  };
  const numPlayers = (v) => (v && v.numPlayers) || (lobby && lobby.numPlayers) || 4;
  const posOf = (seat, v) => { const n = numPlayers(v); return (POS_BY_N[n] || POS_BY_N[4])[(seat - me.seat + n) % n]; };

  function renderPlayers(v, completed) {
    const layer = $('seatsLayer'); layer.innerHTML = ''; const n = numPlayers(v);
    for (let seat = 0; seat < n; seat++) {
      const box = document.createElement('div'); box.className = 'seat-box pos-' + posOf(seat, v);
      const isTurn = (v.phase === 'bidding' && v.bidTurn === seat) ||
        (v.phase === 'declaring' && v.declarer === seat) ||
        (v.phase === 'playing' && v.turn === seat && !completed);
      const team0 = seat === v.declarer || (v.revealed && v.revealed[seat]);
      const p = document.createElement('div');
      p.className = 'player ' + (team0 && v.declarer != null ? 'usteam' : '') + (isTurn ? ' turn' : '');
      const count = v.handCounts[seat];
      const backs = Array.from({ length: Math.min(count, 6) }, () => '<span class="cardback"></span>').join('');
      let chip = '';
      if (v.phase === 'bidding') {
        if (v.passed[seat]) chip = '<div class="seat-chip pass">passed</div>';
        else if (v.bids[seat] != null) chip = `<div class="seat-chip ${v.highBidder === seat ? 'high' : ''}">bid ${v.bids[seat]}</div>`;
      } else if (v.phase !== 'finished' && v.pointsBySeat) {
        chip = `<div class="seat-chip">${v.pointsBySeat[seat]} pts</div>`;
      }
      const role = seat === v.declarer ? '<span class="badge-dealer">BID</span>'
        : (v.revealed && v.revealed[seat] ? '<span class="badge-dealer">PARTNER</span>' : '');
      p.innerHTML = `<div class="pname">${escapeHtml(v.names[seat])}${seat === me.seat ? ' <span class="badge-you">YOU</span>' : ''}${role}</div>` +
        `<div class="cardback-row">${backs}</div>` + chip;
      box.appendChild(p); layer.appendChild(box);
    }
  }

  function renderTrick(v, completed) {
    const area = $('trickArea'); const n = numPlayers(v); area.className = 'trick n-' + n;
    const felt = area.closest('.felt'); if (felt) felt.dataset.players = n;
    area.innerHTML = '';
    const plays = completed ? completed.plays : (v.currentTrick || []);
    const winner = completed ? completed.winner : null;
    const R = window.innerWidth <= 680 ? 108 : 162;
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
    if (v.trump) { tb.classList.add('show'); tb.innerHTML = `Trump · <span style="color:${isRed(v.trump) ? '#ff9f8f' : '#fff'}">${SUIT[v.trump]} ${SUIT_NAME[v.trump]}</span>`; }
    else { tb.classList.remove('show'); tb.textContent = ''; }
    const sl = $('statusLine');
    if (completed) { sl.textContent = `${v.names[completed.winner]} takes it (+${completed.points})`; return; }
    if (v.phase === 'bidding') sl.textContent = v.bidTurn === me.seat ? 'Your turn to bid' : `${v.names[v.bidTurn]} is bidding…`;
    else if (v.phase === 'declaring') sl.textContent = v.declarer === me.seat ? 'Choose trump & partner(s)' : `${v.names[v.declarer]} is choosing trump & partners…`;
    else if (v.phase === 'playing') sl.textContent = v.turn === me.seat ? 'Your turn — play a card' : `Waiting for ${v.names[v.turn]}…`;
    else sl.textContent = 'Deal over';
  }

  function scoreListHtml(v) {
    let h = '<div class="sb-scorelist">';
    for (let s = 0; s < v.numPlayers; s++) h += `<div class="row ${s === me.seat ? 'you' : ''}"><span>${escapeHtml(v.names[s])}${s === me.seat ? ' (you)' : ''}</span><span>${v.scores[s]}</span></div>`;
    return h + '</div>';
  }
  function renderScoreboard(v) {
    const sb = $('scoreboard');
    if (v.phase === 'bidding') {
      sb.innerHTML = `<h4>Bidding</h4>` +
        `<div class="sb-row"><span class="sb-label">High bid</span><span>${v.highBid != null ? v.highBid : '—'}</span></div>` +
        (v.highBidder != null ? `<div class="sb-row"><span class="sb-label">By</span><span>${escapeHtml(v.names[v.highBidder])}</span></div>` : '') +
        `<div class="sb-section-title">Running scores</div>` + scoreListHtml(v);
      return;
    }
    const total = v.pointsBySeat.reduce((a, b) => a + b, 0);
    const bidTeam = v.pointsBySeat.reduce((sum, p, seat) => sum + ((seat === v.declarer || (v.revealed && v.revealed[seat])) ? p : 0), 0);
    const need = Math.max(0, (v.contract || 0) - bidTeam);
    const calls = (v.partnerCards || []).map(cardLabelHtml).join(' ');
    // The partner CALL is public; only who holds it is the secret (until they play it).
    const role = v.youOnBiddingTeam ? (v.you === v.declarer ? 'you bid' : 'you’re the secret partner') : '';
    sb.innerHTML =
      `<h4>${v.trump ? SUIT[v.trump] + ' ' : ''}Bid ${v.contract || ''}</h4>` +
      `<div class="sb-row"><span class="sb-label">Declarer</span><span>${escapeHtml(v.names[v.declarer])}</span></div>` +
      (calls ? `<div class="sb-row"><span class="sb-label">Partner call${v.partnerCards.length > 1 ? 's' : ''}</span><span class="sb-mendis">${calls}</span></div>` : '') +
      (role ? `<div class="sb-need" style="color:var(--us)">🤝 ${role}</div>` : '') +
      `<div class="sb-section-title">This deal</div>` +
      `<div class="sb-points"><span class="sb-team-us">Bidding team</span><span class="big">${bidTeam}</span></div>` +
      (v.phase !== 'finished' ? `<div class="sb-need">needs ${need} more of ${v.contract}</div>` : '') +
      `<div class="sb-points"><span class="sb-team-them">Others</span><span class="big">${total - bidTeam}</span></div>` +
      `<div class="sb-section-title">Running scores</div>` + scoreListHtml(v);
  }

  function renderMatchStrip(v) {
    const ms = $('matchStrip');
    if (v.phase === 'bidding') ms.textContent = 'Bidding for the contract…';
    else ms.innerHTML = `Bid <b>${v.contract || '—'}</b> · ${v.trump ? SUIT[v.trump] : ''} · ${escapeHtml(v.names[v.declarer] || '')}`;
  }

  // ---- bid panel ----
  const ackErr = (res) => { if (res && !res.ok) $('statusLine').textContent = res.error; };
  function renderBidPanel(v) {
    const p = $('bidPanel');
    if (v.phase !== 'bidding' || v.bidTurn !== me.seat) { p.hidden = true; return; }
    p.hidden = false;
    const opening = v.highBid === null;
    const base = opening ? v.bidMin : v.highBid;
    const btns = [];
    if (opening) btns.push({ label: `Bid ${v.bidMin}`, amt: v.bidMin });
    for (const inc of [5, 10, 15, 20]) { const amt = base + inc; if (amt <= v.bidMax) btns.push({ label: `+${inc}`, amt }); }
    let html = `<div class="panel-title">Your bid</div>` +
      `<div class="panel-sub">${opening ? `Open at <b>${v.bidMin}</b> or raise` : `High bid <b>${v.highBid}</b> by ${escapeHtml(v.names[v.highBidder])}`}</div>` +
      `<div class="bid-row">`;
    for (const b of btns) html += `<button class="bid-btn" data-amt="${b.amt}">${b.label}${b.label[0] === '+' ? `<small style="display:block;font-size:10px;opacity:.75">${b.amt}</small>` : ''}</button>`;
    if (!v.forcedBid) html += `<button class="bid-btn pass" data-pass="1">Pass</button>`;
    html += `</div><div class="bid-timer" id="bidTimer"></div>`;
    p.innerHTML = html;
    p.querySelectorAll('[data-amt]').forEach((b) => b.onclick = () => socket.emit('bid', { amount: +b.dataset.amt }, ackErr));
    const pb = p.querySelector('[data-pass]'); if (pb) pb.onclick = () => socket.emit('passBid', {}, ackErr);
    updateBidTimer(v);
  }
  function updateBidTimer(v) {
    const el = $('bidTimer'); if (!el) return;
    if (!v.bidDeadline) { el.textContent = ''; return; }
    const ms = Math.max(0, v.bidDeadline - Date.now());
    el.innerHTML = `${Math.ceil(ms / 1000)}s<div class="bar"><i style="width:${Math.min(100, ms / 100)}%"></i></div>`;
  }
  setInterval(() => {
    if (!game || game.phase !== 'bidding' || !game.bidDeadline) return;
    if (game.bidTurn === me.seat) updateBidTimer(game);
    else { const ms = Math.max(0, game.bidDeadline - Date.now()); $('statusLine').textContent = `${game.names[game.bidTurn]} is bidding… ${Math.ceil(ms / 1000)}s`; }
  }, 250);

  // ---- declare panel ----
  function renderDeclarePanel(v) {
    const p = $('declarePanel');
    if (v.phase !== 'declaring' || v.declarer !== me.seat) { p.hidden = true; return; }
    p.hidden = false;
    const need = v.numPlayers / 2 - 1;
    const ranks = v.numPlayers === 6 ? RANKS.filter((r) => r !== '2') : RANKS;
    let html = `<div class="panel-title">You won at ${v.contract}!</div>` +
      `<div class="panel-sub">Pick your <b>trump</b> and ${need} secret partner card${need > 1 ? 's' : ''}.</div>` +
      `<div class="trump-pick">`;
    for (const s of ['S', 'H', 'D', 'C']) html += `<div class="trump-opt ${isRed(s) ? 'red' : ''} ${declareSel.trump === s ? 'sel' : ''}" data-trump="${s}">${SUIT[s]}</div>`;
    html += `</div><div class="pg-label">Partner card${need > 1 ? 's' : ''} — pick ${need} (${declareSel.partners.length}/${need})</div><div class="partner-grid">`;
    for (const s of ['S', 'H', 'D', 'C']) for (const r of ranks) {
      const id = r + s;
      html += `<div class="pg-card ${isRed(s) ? 'red' : ''} ${declareSel.partners.includes(id) ? 'sel' : ''}" data-card="${id}">${r}<span class="s">${SUIT[s]}</span></div>`;
    }
    const ready = declareSel.trump && declareSel.partners.length === need;
    html += `</div><button class="btn primary" id="declareGo" ${ready ? '' : 'disabled'}>Declare</button>` +
      `<div class="declare-hint">Naming a card you hold means you play that slot solo.</div>`;
    p.innerHTML = html;
    p.querySelectorAll('[data-trump]').forEach((b) => b.onclick = () => { declareSel.trump = b.dataset.trump; renderDeclarePanel(v); });
    p.querySelectorAll('[data-card]').forEach((b) => b.onclick = () => {
      const id = b.dataset.card, i = declareSel.partners.indexOf(id);
      if (i >= 0) declareSel.partners.splice(i, 1);
      else if (declareSel.partners.length < need) declareSel.partners.push(id);
      renderDeclarePanel(v);
    });
    const go = $('declareGo');
    if (go) go.onclick = () => socket.emit('declare', { trump: declareSel.trump, partnerCards: declareSel.partners.slice() }, (res) => {
      if (res && !res.ok) $('statusLine').textContent = res.error; else declareSel = { trump: null, partners: [] };
    });
  }

  function renderHand(v, completed) {
    const hand = $('handArea'); hand.innerHTML = '';
    const myTurn = v.phase === 'playing' && v.turn === me.seat && !completed;
    const legal = new Set(v.legal || []);
    const calls = new Set(v.partnerCards || []);
    for (const card of (v.hand || [])) {
      const uid = card.uid || card.id;
      const playable = myTurn && legal.has(uid);
      const isCalled = calls.has(card.id); // you hold the named partner card → you're the ally
      const cls = (playable ? 'playable' : (myTurn ? 'illegal' : '')) + (selected === uid ? ' selected' : '') + (isCalled ? ' partner-card' : '');
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
    renderDeclarePanel(v);
  }

  // ---- result ----
  function showResult(v) {
    const r = v.result;
    const youTeam0 = r.team0.includes(me.seat);
    const won = (r.winningTeam === 0) === youTeam0;
    $('overlay').classList.add('show');
    const title = $('resultTitle');
    title.className = won ? 'win' : 'lose';
    $('resultCrest').textContent = won ? '♛' : '♟';
    title.textContent = won ? 'You win the deal' : 'You lose the deal';
    $('resultDetail').textContent =
      `${v.names[r.declarer]} bid ${r.contract} (${SUIT[r.trump]}) and captured ${r.declarerPoints} — ` +
      (r.made ? 'made it!' : `short by ${r.contract - r.declarerPoints}.`);
    $('resultStats').innerHTML =
      `<div class="col"><span class="sb-label">Bidding team</span><span class="big" style="color:var(--us)">${r.declarerPoints}</span><span>${r.team0.map((s) => escapeHtml(v.names[s])).join(', ')}</span></div>` +
      `<div class="col"><span class="sb-label">Opponents</span><span class="big" style="color:var(--them)">${r.opponentPoints}</span><span>${r.team1.map((s) => escapeHtml(v.names[s])).join(', ')}</span></div>`;
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
    if (v.phase === 'bidding') { shownTricks = -1; declareSel = { trump: null, partners: [] }; }
    const justCompleted = (v.phase === 'playing' || v.phase === 'finished') && v.lastTrick &&
      v.trickNumber > shownTricks && v.currentTrick.length === 0;
    if (justCompleted) {
      shownTricks = v.trickNumber;
      renderTable(v, v.lastTrick);
      viewLock = true;
      setTimeout(() => {
        viewLock = false;
        const nv = queuedView || v; queuedView = null;
        game = nv; shownTricks = Math.max(shownTricks, nv.trickNumber || 0);
        if (nv.phase === 'finished') { renderTable(nv, null); showResult(nv); } else renderTable(nv, null);
      }, 1600);
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
