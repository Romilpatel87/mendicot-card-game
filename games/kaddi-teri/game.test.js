// game.test.js — sanity checks for the Kali Tiri rules engine.
const G = require('./game');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let failures = 0;
function check(cond, msg) { if (!cond) { failures++; console.error('FAIL:', msg); } }

// Drive a random-but-legal auction to completion.
function runAuction(state, rng) {
  let guard = 0;
  while (state.phase === 'bidding') {
    if (guard++ > 500) { check(false, 'auction did not terminate'); break; }
    const seat = state.bidTurn;
    const floor = state.highBid === null ? state.bidMin : state.highBid + 5;
    const canRaise = floor <= state.bidMax;
    const forced = G.activeSeats(state).length === 1 && state.highBid === null;
    // Bias toward passing so the auction ends, but the forced player must bid.
    if (!forced && (!canRaise || rng() < 0.5)) {
      const r = G.passBid(state, seat);
      check(r.ok, `pass ok (${r.error || ''})`);
    } else {
      const inc = 5 * (1 + Math.floor(rng() * 4));         // +5..+20
      const amount = Math.min(state.bidMax, floor - 5 + inc <= state.bidMax ? floor - 5 + inc : floor);
      // floor already includes the +5 minimum for raises; clamp to range.
      const amt = Math.min(state.bidMax, Math.max(floor, floor - 5 + inc));
      const r = G.bid(state, seat, Math.min(state.bidMax, amt));
      check(r.ok, `bid ${amt} ok (${r.error || ''})`);
    }
  }
}

function randomDeclare(state, rng) {
  const trump = G.SUITS[Math.floor(rng() * 4)];
  const ids = G.makeDeck(state.numPlayers, state.decks).map((c) => c.id);
  const need = G.requiredPartners(state.numPlayers);
  const picks = [];
  for (let i = 0; i < need; i++) picks.push(ids[Math.floor(rng() * ids.length)]);
  const r = G.declare(state, state.declarer, trump, picks);
  check(r.ok, `declare ok (${r.error || ''})`);
}

function fuzz(numPlayers, decks, seedBase, count) {
  decks = G.decksFor(numPlayers, decks);
  const total = G.totalPoints(numPlayers, decks);
  const deckSize = G.makeDeck(numPlayers, decks).length;
  const cardsEach = deckSize / numPlayers;
  for (let s = 0; s < count; s++) {
    const seed = seedBase + s;
    const rng = mulberry32(seed);
    const state = G.createGame(rng, numPlayers, decks);
    const tag = `${numPlayers}p×${decks} seed ${seed}`;

    check(state.hands.every((h) => h.length === cardsEach), `${tag}: ${cardsEach} cards each`);
    check(new Set(state.hands.flat().map((c) => c.uid)).size === deckSize, `${tag}: full deck dealt`);

    runAuction(state, rng);
    check(state.phase === 'declaring', `${tag}: reaches declaring`);
    check(state.declarer !== null, `${tag}: a declarer won`);
    check(state.contract >= state.bidMin && state.contract <= state.bidMax, `${tag}: contract in range`);

    randomDeclare(state, rng);
    check(state.phase === 'playing', `${tag}: reaches playing`);
    check(state.trump && G.SUITS.includes(state.trump), `${tag}: trump set`);
    check(state.turn === state.declarer, `${tag}: declarer leads first`);

    let guard = 0;
    while (state.phase === 'playing') {
      if (guard++ > 3000) { check(false, `${tag}: play did not terminate`); break; }
      const seat = state.turn;
      const legal = G.legalMoves(state, seat);
      check(legal.length > 0, `${tag}: seat ${seat} has a legal move`);
      if (state.currentTrick.length > 0) {
        const hasLead = state.hands[seat].some((c) => c.suit === state.leadSuit);
        if (hasLead) check(legal.every((c) => c.suit === state.leadSuit), `${tag}: forced to follow suit`);
      }
      const pick = legal[Math.floor(rng() * legal.length)];
      const r = G.playCard(state, seat, pick.uid);
      check(r.ok, `${tag}: play ok (${r.error || ''})`);
    }

    check(state.hands.every((h) => h.length === 0), `${tag}: all hands empty`);
    const r = state.result;
    check(r, `${tag}: result produced`);
    check(r.declarerPoints + r.opponentPoints === total, `${tag}: points total ${total} (got ${r.declarerPoints}+${r.opponentPoints})`);
    check(state.pointsBySeat.reduce((a, b) => a + b, 0) === total, `${tag}: seat points total ${total}`);
    check(r.team0.includes(state.declarer), `${tag}: declarer on team0`);
    check(r.team0.length + r.team1.length === numPlayers, `${tag}: everyone on a team`);
    check(r.made === (r.declarerPoints >= state.contract), `${tag}: made == reached contract`);
    check(r.winningTeam === (r.made ? 0 : 1), `${tag}: winningTeam matches made`);
    // The minimum bid is above half, so a successful maker always holds the majority.
    // (A failed maker may still hold more points than the setters — the deal is decided
    // by the contract, not by who has more points — so we only assert the made case.)
    if (r.made) check(r.declarerPoints > total / 2, `${tag}: maker has majority`);
  }
}

fuzz(4, 1, 1, 1500);
fuzz(6, 1, 50000, 1500);
fuzz(6, 2, 100000, 1500);
fuzz(8, 2, 150000, 1500);

// Targeted: point values & totals.
{
  check(G.pointsOf(3, 'S') === 30, '3 of spades = 30');
  check(G.pointsOf(3, 'H') === 0, 'other 3s = 0');
  check(G.pointsOf(14, 'C') === 10 && G.pointsOf(10, 'D') === 10 && G.pointsOf(13, 'S') === 10, 'A/10/K = 10');
  check(G.pointsOf(5, 'H') === 5, '5 = 5');
  check(G.pointsOf(7, 'S') === 0, '7 = 0');
  check(G.totalPoints(4, 1) === 250, 'single deck total 250');
  check(G.totalPoints(8, 2) === 500, 'double deck total 500');
  check(G.totalPoints(6, 1) === 250 && G.totalPoints(6, 2) === 500, '6p totals 250 / 500');
}

// Targeted: deck sizes (2s dropped for 6 players, kept otherwise).
{
  check(G.makeDeck(4, 1).length === 52, '4p deck 52');
  check(G.makeDeck(6, 1).length === 48, '6p single deck 48 (2s dropped)');
  check(G.makeDeck(6, 2).length === 96, '6p double deck 96 (2s dropped)');
  check(G.makeDeck(8, 2).length === 104, '8p double deck 104');
  check(!G.makeDeck(6, 1).some((c) => c.value === 2), '6p deck has no 2s');
}

// Targeted: bidding — turn order, open/raise caps (+20), strictly-increasing.
{
  const st = G.createGame(mulberry32(3), 4, 1);
  st.passed = [false, false, false, false]; st.highBid = null; st.highBidder = null;
  st.bidTurn = 0; st.startBidder = 0;
  check(G.bid(st, 1, 150).ok === false, 'cannot bid out of turn');
  check(G.bid(st, 0, 175).ok === false, 'cannot open more than +20 over the minimum');
  check(G.bid(st, 0, 150).ok, 'open at 150');
  check(st.bidTurn === 1, 'turn advanced to seat 1');
  check(G.bid(st, 1, 175).ok === false, 'cannot raise more than +20 (150→175)');
  check(G.bid(st, 1, 170).ok, 'raise +20 to 170');
  check(G.bid(st, 2, 170).ok === false, 'must beat the current bid');
  check(G.bid(st, 2, 175).ok, 'raise to 175');
}

// Targeted: forced last bidder cannot pass.
{
  const st = G.createGame(mulberry32(9), 4, 1);
  // Make seats 0,1,2 pass in turn; seat 3 must be forced to bid.
  const order = [];
  let guard = 0;
  while (st.phase === 'bidding' && guard++ < 20) {
    const seat = st.bidTurn;
    const forced = G.activeSeats(st).length === 1 && st.highBid === null;
    if (forced) {
      check(G.passBid(st, seat).ok === false, 'forced player cannot pass');
      check(G.bid(st, seat, 150).ok, 'forced player bids minimum');
    } else {
      G.passBid(st, seat);
    }
    order.push(seat);
  }
  check(st.phase === 'declaring' && st.declarer != null, 'forced auction resolves to a declarer');
  check(st.contract === 150, 'forced contract is the minimum');
}

// Targeted: trump beats lead; higher trump wins; ties go to the earlier card.
{
  const C = (suit, value) => ({ suit, value });
  check(G.beats(C('H', 2), C('S', 14), 'S', 'H') === true, 'low trump beats Ace of lead');
  check(G.beats(C('S', 14), C('H', 2), 'S', 'H') === false, 'Ace of lead loses to trump');
  check(G.beats(C('H', 13), C('H', 12), 'S', 'H') === true, 'higher trump wins');
  check(G.beats(C('S', 14), C('S', 14), 'S', 'H') === false, 'equal cards: earlier (first) wins');
  const trick = [
    { seat: 0, card: C('S', 13) }, { seat: 1, card: C('H', 2) }, // H trump
    { seat: 2, card: C('S', 14) }, { seat: 3, card: C('D', 9) },
  ];
  check(G.trickWinner(trick, 'S', 'H') === 1, 'the trump (2♥) takes the trick');
}

// Targeted: partner reveal — playing a called card joins the declarer's team; calling
// your own card means that slot is consumed by you (smaller team).
{
  const st = {
    phase: 'playing', numPlayers: 4, decks: 1, tricksPerHand: 1,
    hands: [[{ suit: 'H', value: 14, points: 10, id: 'AH', uid: 'AH' }],
            [{ suit: 'C', value: 13, points: 10, id: 'KC', uid: 'KC' }],
            [{ suit: 'D', value: 12, points: 10, id: 'QD', uid: 'QD' }],
            [{ suit: 'S', value: 11, points: 10, id: 'JS', uid: 'JS' }]],
    bidMin: 150, bidMax: 250, declarer: 0, contract: 150, trump: 'S',
    partnerCards: ['QD'], remainingCalls: ['QD'], revealed: [false, false, false, false],
    leader: 0, turn: 0, leadSuit: null, currentTrick: [], trickNumber: 0,
    pointsBySeat: [0, 0, 0, 0], lastTrick: null, result: null,
  };
  G.playCard(st, 0, 'AH');
  G.playCard(st, 1, 'KC');
  check(st.revealed[2] === false, 'partner not revealed before playing the called card');
  G.playCard(st, 2, 'QD'); // QD is the called card → seat 2 revealed as partner
  check(st.revealed[2] === true, 'seat 2 revealed as partner when QD is played');
  G.playCard(st, 3, 'JS');
  check(st.phase === 'finished', 'single-trick deal finished');
  check(st.result.team0.includes(2), 'partner (seat 2) on the declarer team');
  check(st.result.team0.length === 2 && st.result.team1.length === 2, '2 v 2 teams');
}

if (failures === 0) console.log('ALL CHECKS PASSED (6000 fuzzed Kali Tiri games + targeted rule tests)');
else { console.error(`${failures} CHECK(S) FAILED`); process.exit(1); }
