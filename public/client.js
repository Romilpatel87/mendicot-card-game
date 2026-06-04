/* client.js — Mendicot front-end. Talks to the server over Socket.IO. */
(() => {
  const socket = io();
  const $ = (id) => document.getElementById(id);

  // ---- local state ----
  let me = { name: '', code: '', token: '', seat: -1 };
  let lobby = null;
  let game = null;
  let selected = null;
  // completed-trick "beat" handling
  let viewLock = false, queuedView = null, shownTricks = -1;

  const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const SUIT_NAME = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };
  const isRed = (s) => s === 'H' || s === 'D';

  // ---- session persistence (for reconnects / refresh) ----
  const SKEY = 'mendicot.session';
  const saveSession = () => localStorage.setItem(SKEY, JSON.stringify({ code: me.code, token: me.token, name: me.name }));
  const loadSession = () => { try { return JSON.parse(localStorage.getItem(SKEY)); } catch { return null; } };
  const clearSession = () => localStorage.removeItem(SKEY);

  // ---- screens ----
  function showScreen(name) {
    for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === name);
  }

  // ---- card element ----
  function cardEl(card, opts = {}) {
    const el = document.createElement('div');
    el.className = 'card' + (isRed(card.suit) ? ' red' : '') + (card.value === 10 ? ' mendi' : '');
    if (opts.cls) el.className += ' ' + opts.cls;
    el.dataset.id = card.id;
    el.dataset.uid = card.uid || card.id;
    el.innerHTML =
      `<div class="corner tl"><span class="r">${card.label}</span><span class="s">${SUIT[card.suit]}</span></div>` +
      `<div class="pip">${SUIT[card.suit]}</div>` +
      `<div class="corner br"><span class="r">${card.label}</span><span class="s">${SUIT[card.suit]}</span></div>`;
    return el;
  }

  // ======================================================================
  //  HOME
  // ======================================================================
  // ---- player-count + deck mode toggles ----
  let chosenPlayers = 4;
  let chosenDecks = 1; // only meaningful for 6 players (4p = single, 8p = double)
  const modeToggle = $('modeToggle');
  const deckField = $('deckField');
  const deckToggle = $('deckToggle');
  if (modeToggle) {
    modeToggle.querySelectorAll('.mode-opt').forEach((b) => {
      b.onclick = () => {
        chosenPlayers = +b.dataset.players;
        modeToggle.querySelectorAll('.mode-opt').forEach((x) => x.classList.toggle('active', x === b));
        // The single/double-deck choice only applies to the 6-player table.
        if (deckField) deckField.hidden = chosenPlayers !== 6;
      };
    });
  }
  if (deckToggle) {
    deckToggle.querySelectorAll('.mode-opt').forEach((b) => {
      b.onclick = () => {
        chosenDecks = +b.dataset.decks;
        deckToggle.querySelectorAll('.mode-opt').forEach((x) => x.classList.toggle('active', x === b));
      };
    });
  }
  const decksForCreate = () => (chosenPlayers === 8 ? 2 : chosenPlayers === 6 ? chosenDecks : 1);

  $('createBtn').onclick = () => {
    const name = requireName();
    if (!name) return;
    me.name = name;
    socket.emit('createRoom', { name, players: chosenPlayers, decks: decksForCreate() }, (res) => {
      if (!res || !res.ok) return setHomeError(res && res.error);
      me.code = res.code; me.token = res.token; me.seat = res.seat;
      saveSession();
    });
  };

  $('joinBtn').onclick = () => doJoin();
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  function doJoin() {
    const name = requireName();
    if (!name) return;
    const code = $('codeInput').value.trim().toUpperCase();
    if (!code) return setHomeError('Enter a room code.');
    me.name = name;
    socket.emit('joinRoom', { code, name }, (res) => {
      if (!res || !res.ok) return setHomeError(res && res.error);
      me.code = res.code; me.token = res.token; me.seat = res.seat;
      saveSession();
    });
  }
  const setHomeError = (msg) => { $('homeError').textContent = msg || 'Something went wrong.'; };

  // A real player must enter a name before creating or joining. Returns the trimmed
  // name, or '' (and flags the field in red) if it's empty.
  function requireName() {
    const name = $('nameInput').value.trim();
    if (!name) {
      setHomeError('Please enter your name to play.');
      $('nameInput').classList.add('invalid');
      $('nameInput').focus();
      return '';
    }
    $('nameInput').classList.remove('invalid');
    return name;
  }
  // Clear the red flag as soon as they start typing a name.
  $('nameInput').addEventListener('input', () => {
    $('nameInput').classList.remove('invalid');
    if ($('homeError').textContent === 'Please enter your name to play.') $('homeError').textContent = '';
  });

  $('rulesToggle').onclick = () => $('rulesBox').classList.toggle('open');
  $('rulesBox').innerHTML = `
    <h4>The goal</h4>
    <p>Win the four <b>10s</b> ("mendis"). Win all four and you take the <b>cot</b> — the true victory.</p>
    <h4>Each trick</h4>
    <ul>
      <li>The leader plays any card; its suit is the suit for that trick.</li>
      <li>Everyone must follow that suit if they can.</li>
      <li>Can't follow? Play any card — that's how the <b>trump</b> gets decided (below).</li>
      <li>Highest trump wins; with no trump in the trick, the highest card of the led suit wins.</li>
    </ul>
    <h4>Choosing the trump</h4>
    <p>The <b>first trick</b> where someone can't follow the led suit decides the trump.
    Each player in that trick who can't follow may play any suit, and each one <b>overrides</b>
    the previous choice — so the <b>last</b> player who can't follow sets the trump.
    Once that trick ends, the trump is <b>fixed for the rest of the game</b>.</p>
    <h4>Winning</h4>
    <ul>
      <li>Take <b>all</b> the mendis → win the <b>cot</b>. Take a majority → win the deal.</li>
      <li>An even split → whoever took more tricks wins.</li>
      <li><b>Single deck</b> = 4 tens: take 3+ to win, all 4 for the cot.</li>
      <li><b>Double deck</b> = 8 tens: take 5+ to win, all 8 for the cot.</li>
    </ul>
    <h4>Table sizes</h4>
    <ul>
      <li>4 players — single deck (52 cards).</li>
      <li>6 players — your choice: single deck (48 cards, 8 tricks) or double deck (72 cards, 12 tricks).</li>
      <li>8 players — double deck (104 cards, 13 tricks).</li>
    </ul>
    <h4>Two decks</h4>
    <p>Every card exists twice. If the same card is played again, the <b>second one wins</b> — e.g. an opponent's Ace of Clubs is beaten by the other Ace of Clubs played after it.</p>
    <p>Alternate seats are partners (2-v-2 with 4 players, 3-v-3 with 6, 4-v-4 with 8). Play cooperatively!</p>`;

  // ======================================================================
  //  LOBBY
  // ======================================================================
  function renderLobby() {
    if (!lobby) return;
    $('lobbyCode').textContent = lobby.code;
    const n = lobby.numPlayers || 4;
    const note = $('teamNote');
    if (note) note.firstChild && (note.firstChild.textContent =
      n === 8 ? 'Alternate seats are partners (4 v 4) · '
      : n === 6 ? 'Alternate seats are partners (3 v 3) · '
      : 'Alternate seats are partners (2 v 2) · ');
    const wrap = $('lobbySeats');
    wrap.innerHTML = '';
    for (let seat = 0; seat < n; seat++) {
      const s = lobby.seats[seat];
      const div = document.createElement('div');
      const teamUs = seat % 2 === me.seat % 2;
      div.className = 'seat-card' + (s ? ' filled' : '') + (seat === me.seat ? ' you' : '');
      if (s) {
        div.innerHTML =
          `<div class="seat-name">${escapeHtml(s.name)}${seat === me.seat ? ' <span class="seat-tag">(you)</span>' : ''}</div>` +
          `<div class="seat-tag ${teamUs ? 'usT' : 'themT'}">${teamUs ? 'Your team' : 'Opponents'}</div>` +
          (s.isBot ? `<div class="mini add" data-rm="${seat}">remove bot</div>`
                   : `<div class="mini">${s.connected ? 'ready' : 'reconnecting…'}</div>`);
      } else {
        div.innerHTML =
          `<div class="seat-name" style="opacity:.6">Empty</div>` +
          `<div class="seat-tag ${teamUs ? 'usT' : 'themT'}">${teamUs ? 'Your team' : 'Opponents'}</div>` +
          `<div class="mini add" data-bot="1">+ add bot</div>`;
      }
      wrap.appendChild(div);
    }
    wrap.querySelectorAll('[data-bot]').forEach((b) => b.onclick = () => socket.emit('addBot', {}, () => {}));
    wrap.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => socket.emit('removeBot', { seat: +b.dataset.rm }, () => {}));
    const filled = lobby.seats.every((x) => x);
    $('startBtn').disabled = !filled;
  }

  $('lobbyCode').onclick = () => {
    navigator.clipboard && navigator.clipboard.writeText(lobby.code);
    const el = $('lobbyCode'); const t = el.textContent; el.textContent = 'COPIED'; setTimeout(() => el.textContent = t, 900);
  };
  $('startBtn').onclick = () => socket.emit('startGame', {}, (res) => { if (res && !res.ok) alert(res.error); });
  $('leaveLobbyBtn').onclick = leaveRoom;
  $('leaveGameBtn').onclick = leaveRoom;
  function leaveRoom() { clearSession(); location.reload(); }

  // ======================================================================
  //  TABLE
  // ======================================================================
  // Relative-seat → on-screen position. Index 0 is always "me" (bottom).
  const POS_BY_N = {
    4: ['bottom', 'right', 'top', 'left'],
    6: ['bottom', 'bottom-right', 'top-right', 'top', 'top-left', 'bottom-left'],
    8: ['bottom', 'bottom-right', 'right', 'top-right', 'top', 'top-left', 'left', 'bottom-left'],
  };
  const numPlayers = (v) => (v && v.numPlayers) || (lobby && lobby.numPlayers) || 4;
  const posOf = (seat, v) => {
    const n = numPlayers(v);
    const list = POS_BY_N[n] || POS_BY_N[4];
    return list[(seat - me.seat + n) % n];
  };

  function renderPlayers(v, completed) {
    const layer = $('seatsLayer');
    layer.innerHTML = '';
    const n = numPlayers(v);
    for (let seat = 0; seat < n; seat++) {
      const pos = posOf(seat, v);
      const box = document.createElement('div');
      box.className = 'seat-box pos-' + pos;
      const teamUs = seat % 2 === me.seat % 2;
      const p = document.createElement('div');
      p.className = 'player ' + (teamUs ? 'usteam' : 'themteam') + (v.turn === seat && v.phase === 'playing' && !completed ? ' turn' : '');
      const count = v.handCounts[seat];
      const backs = Array.from({ length: Math.min(count, 6) }, () => '<span class="cardback"></span>').join('');
      const conn = v.connected[seat];
      p.innerHTML =
        `<div class="pname">${escapeHtml(v.names[seat])}${seat === me.seat ? ' <span class="badge-you">YOU</span>' : ''}</div>` +
        `<div class="cardback-row">${backs}</div>` +
        `<div class="pmeta">${count} cards${!conn ? ' · offline' : ''}${v.dealer === seat ? ' · dealer' : ''}</div>`;
      box.appendChild(p);
      layer.appendChild(box);
    }
  }

  function renderTrick(v, completed) {
    const area = $('trickArea');
    const n = numPlayers(v);
    area.className = 'trick n-' + n;
    const felt = area.closest('.felt');
    if (felt) felt.dataset.players = n;
    area.innerHTML = '';
    const plays = completed ? completed.plays : v.currentTrick;
    const winner = completed ? completed.winner : null;
    // Lay the played cards on a circle around the centre badge. Each seat gets an
    // even slice of 360°; relative index 0 ("me") sits at the bottom, the rest run
    // clockwise so a card appears in front of the player who played it. One formula
    // for every table size, so 4/6/8 all get a clean ring.
    const R = window.innerWidth <= 680 ? 108 : 162; // circle radius (px)
    for (const play of plays) {
      const k = (play.seat - me.seat + n) % n;
      const theta = (90 - k * (360 / n)) * Math.PI / 180; // 90° = bottom, clockwise
      const dx = Math.round(Math.cos(theta) * R);
      const dy = Math.round(Math.sin(theta) * R);
      const c = cardEl(play.card, { cls: 'tcard' + (winner === play.seat ? ' win' : '') });
      c.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      // Hover any played card to see who put it down.
      c.dataset.player = v.names[play.seat] + (play.seat === me.seat ? ' (you)' : '');
      area.appendChild(c);
    }
  }

  function renderTrumpAndStatus(v, completed) {
    const tb = $('trumpBadge');
    if (v.trump) {
      tb.classList.add('show');
      tb.innerHTML = `Trump · <span style="color:${isRed(v.trump) ? '#ff9f8f' : '#fff'}">${SUIT[v.trump]} ${SUIT_NAME[v.trump]}</span>`;
    } else { tb.classList.remove('show'); tb.textContent = ''; }

    const sl = $('statusLine');
    if (completed) {
      const wname = v.names[completed.winner];
      const m = completed.capturedMendis && completed.capturedMendis.length
        ? ` · bagged ${completed.capturedMendis.map((s) => SUIT[s]).join(' ')}!` : '';
      sl.textContent = `${wname} won the trick${m}`;
    } else if (v.phase === 'finished') {
      sl.textContent = 'Round over';
    } else if (v.turn === me.seat) {
      sl.textContent = 'Your turn — pick a card';
    } else {
      sl.textContent = `Waiting for ${v.names[v.turn]}…`;
    }
  }

  function renderScoreboard(v) {
    const usTeam = me.seat % 2;
    const them = 1 - usTeam;
    const mendiIcons = (arr) => arr.length
      ? arr.map((s) => `<span style="color:${isRed(s) ? '#ff9f8f' : '#f4ecd8'}">${SUIT[s]}</span>`).join('')
      : '<span style="opacity:.4">—</span>';
    const total = v.tricksPerHand || 13;
    $('scoreboard').innerHTML =
      `<h4>Scoreboard</h4>` +
      `<div class="sb-row"><span class="sb-label">Trick</span><span>${Math.min(v.trickNumber + (v.phase === 'finished' ? 0 : 1), total)} / ${total}</span></div>` +
      `<div class="sb-section-title">Tricks won</div>` +
      `<div class="sb-row"><span class="sb-team-us">Your team</span><span>${v.tricksWon[usTeam]}</span></div>` +
      `<div class="sb-row"><span class="sb-team-them">Opponents</span><span>${v.tricksWon[them]}</span></div>` +
      `<div class="sb-section-title">Mendis (10s)</div>` +
      `<div class="sb-row"><span class="sb-team-us">Your team</span><span class="sb-mendis">${mendiIcons(v.mendis[usTeam])}</span></div>` +
      `<div class="sb-row"><span class="sb-team-them">Opponents</span><span class="sb-mendis">${mendiIcons(v.mendis[them])}</span></div>`;
  }

  function renderMatchStrip(v) {
    const usTeam = me.seat % 2, them = 1 - usTeam;
    $('matchStrip').innerHTML =
      `Deals — <b class="us">You ${v.matchScore[usTeam]}</b> · <b class="them">Them ${v.matchScore[them]}</b>` +
      (v.cots[usTeam] || v.cots[them] ? `  ·  Cots <b class="us">${v.cots[usTeam]}</b>/<b class="them">${v.cots[them]}</b>` : '') +
      (v.draws ? `  ·  Draws ${v.draws}` : '');
  }

  function renderHand(v, completed) {
    const hand = $('handArea');
    hand.innerHTML = '';
    const myTurn = v.turn === me.seat && v.phase === 'playing' && !completed;
    const legal = new Set(v.legal || []);
    for (const card of v.hand) {
      const uid = card.uid || card.id;
      const playable = myTurn && legal.has(uid);
      const cls = (playable ? 'playable' : (myTurn ? 'illegal' : '')) + (selected === uid ? ' selected' : '');
      const el = cardEl(card, { cls });
      if (playable) {
        el.onclick = () => { selected = (selected === uid) ? null : uid; renderHand(game, null); updatePlayBtn(); };
      }
      hand.appendChild(el);
    }
    updatePlayBtn();
  }
  function updatePlayBtn() {
    const myTurn = game && game.turn === me.seat && game.phase === 'playing';
    $('playBtn').disabled = !(myTurn && selected);
  }
  $('playBtn').onclick = () => {
    if (!selected) return;
    const id = selected;
    socket.emit('playCard', { id }, (res) => { if (res && !res.ok) { $('statusLine').textContent = res.error; } });
    selected = null;
  };

  function renderTable(v, completed) {
    showScreen('table');
    renderMatchStrip(v);
    renderPlayers(v, completed);
    renderTrick(v, completed);
    renderTrumpAndStatus(v, completed);
    renderScoreboard(v);
    renderHand(v, completed);
  }

  // ---- result overlay ----
  function showResult(v) {
    const r = v.result;
    const usTeam = me.seat % 2;
    const won = r.winningTeam === usTeam;
    $('overlay').classList.add('show');
    const title = $('resultTitle');
    if (r.draw) {
      title.className = '';
      $('resultCrest').textContent = '⚖';
      title.textContent = 'A dead heat';
      $('resultDetail').textContent = 'Both teams tied on mendis and tricks — no winner this deal.';
    } else {
      title.className = won ? 'win' : 'lose';
      $('resultCrest').textContent = won ? '♛' : '♟';
      if (r.cot) title.textContent = won ? 'You won the cot!' : 'Opponents took the cot';
      else title.textContent = won ? 'Your team wins' : 'Opponents win';
      $('resultDetail').textContent = `${won ? 'Your team' : 'The opponents'} ${r.reason}.`;
    }
    const them = 1 - usTeam;
    $('resultStats').innerHTML =
      `<div class="col"><span class="sb-label">Your mendis</span><span class="big" style="color:var(--us)">${r.mendis[usTeam].length}</span><span>${r.tricks[usTeam]} tricks</span></div>` +
      `<div class="col"><span class="sb-label">Their mendis</span><span class="big" style="color:var(--them)">${r.mendis[them].length}</span><span>${r.tricks[them]} tricks</span></div>`;
    $('rematchWait').textContent = '';
  }
  $('rematchBtn').onclick = () => {
    socket.emit('rematch', {}, (res) => {
      if (res && res.waiting) $('rematchWait').textContent = 'Waiting for the others…';
      else if (res && !res.ok) $('rematchWait').textContent = res.error || '';
    });
  };

  // ======================================================================
  //  SOCKET EVENTS
  // ======================================================================
  function applyView(v) {
    game = v;
    if (v.phase === 'playing') $('overlay').classList.remove('show');
    if (v.phase === 'playing' && v.trickNumber === 0) shownTricks = -1; // fresh deal

    const justCompleted = v.lastTrick && v.trickNumber > shownTricks && v.currentTrick.length === 0;
    if (justCompleted) {
      shownTricks = v.trickNumber;
      renderTable(v, v.lastTrick);     // hold on the finished trick
      viewLock = true;
      setTimeout(() => {
        viewLock = false;
        const nv = queuedView || v; queuedView = null;
        game = nv; shownTricks = Math.max(shownTricks, nv.trickNumber);
        if (nv.phase === 'finished') { renderTable(nv, null); showResult(nv); }
        else renderTable(nv, null);
      }, 2200);
    } else {
      shownTricks = Math.max(shownTricks, v.trickNumber);
      if (v.phase === 'finished') { renderTable(v, null); showResult(v); }
      else renderTable(v, null);
    }
  }

  socket.on('lobby', (l) => {
    lobby = l;
    // figure out my seat from the session if we don't have it yet
    if (me.seat < 0) {
      const sess = loadSession();
      // seat is set on join ack; nothing to do here
    }
    if (!l.inProgress) { showScreen('lobby'); renderLobby(); }
    else if (l.started === false && game && game.phase === 'finished') { /* keep result overlay */ }
  });

  socket.on('game', (v) => {
    if (viewLock) { queuedView = v; return; }
    applyView(v);
  });

  // ---- auto reconnect on load ----
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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // prefill name from session
  const sess0 = loadSession();
  if (sess0 && sess0.name) $('nameInput').value = sess0.name;
})();
