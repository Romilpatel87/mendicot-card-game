// test.js — sanity checks for the rules engine.
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

// 1) Fuzz: play many full games with random legal moves, verify invariants.
function fuzz(numPlayers, decks, seedBase, count) {
  decks = G.decksFor(numPlayers, decks);
  const deckSize = G.makeDeck(numPlayers, decks).length;
  const cardsEach = deckSize / numPlayers;
  const totalMendis = 4 * decks; // four tens per deck
  const half = totalMendis / 2;
  for (let s = 0; s < count; s++) {
    const seed = seedBase + s;
    const rng = mulberry32(seed);
    const state = G.createGame(rng, numPlayers, decks);
    const tag = `${numPlayers}p×${decks} seed ${seed}`;

    check(state.numPlayers === numPlayers, `${tag}: numPlayers set`);
    check(state.hands.length === numPlayers, `${tag}: ${numPlayers} hands`);
    check(state.hands.every((h) => h.length === cardsEach), `${tag}: ${cardsEach} cards each`);
    const allIds = new Set(state.hands.flat().map((c) => c.uid));
    check(allIds.size === deckSize, `${tag}: ${deckSize} unique cards dealt`);
    if (numPlayers === 6 && decks === 1) {
      check(!state.hands.flat().some((c) => c.value === 2), `${tag}: no 2s in 6p single deck`);
    }
    if (numPlayers === 6 && decks === 2) {
      check(!state.hands.flat().some((c) => c.value < 6), `${tag}: no 2–5 in 6p double deck`);
    }
    if (decks === 2) {
      // Two decks: exactly two physical copies of every logical card.
      const counts = {};
      for (const c of state.hands.flat()) counts[c.id] = (counts[c.id] || 0) + 1;
      check(Object.keys(counts).length === deckSize / 2, `${tag}: ${deckSize / 2} distinct card faces`);
      check(Object.values(counts).every((n) => n === 2), `${tag}: every card appears twice`);
    }

    let guard = 0;
    while (state.phase === 'playing') {
      if (guard++ > 2000) { check(false, `${tag}: game did not terminate`); break; }
      const seat = state.turn;
      const legal = G.legalMoves(state, seat);
      check(legal.length > 0, `${tag}: player ${seat} has a legal move`);
      if (state.currentTrick.length > 0) {
        const hasLead = state.hands[seat].some((c) => c.suit === state.leadSuit);
        if (hasLead) check(legal.every((c) => c.suit === state.leadSuit),
          `${tag}: player ${seat} forced to follow ${state.leadSuit}`);
      }
      const pick = legal[Math.floor(rng() * legal.length)];
      const res = G.playCard(state, seat, pick.uid);
      check(res.ok, `${tag}: play ${pick.uid} ok (${res.error || ''})`);
    }

    const t = state.tricksWon;
    check(t[0] + t[1] === cardsEach, `${tag}: ${cardsEach} tricks total (got ${t})`);
    const captured = state.mendis[0].length + state.mendis[1].length;
    check(captured === totalMendis, `${tag}: ${totalMendis} mendis captured (got ${captured})`);
    check(state.hands.every((h) => h.length === 0), `${tag}: all hands empty`);
    check(state.result, `${tag}: result produced`);

    const r = state.result;
    const m0 = state.mendis[0].length, m1 = state.mendis[1].length;
    if (m0 === totalMendis) check(r.winningTeam === 0 && r.cot, `${tag}: team0 cot`);
    else if (m1 === totalMendis) check(r.winningTeam === 1 && r.cot, `${tag}: team1 cot`);
    else if (m0 > half) check(r.winningTeam === 0 && !r.cot, `${tag}: team0 mendi-majority win`);
    else if (m1 > half) check(r.winningTeam === 1 && !r.cot, `${tag}: team1 mendi-majority win`);
    else {
      check(m0 === half && m1 === half, `${tag}: even mendi split`);
      if (t[0] > t[1]) check(r.winningTeam === 0 && !r.draw, `${tag}: even split, team0 more tricks`);
      else if (t[1] > t[0]) check(r.winningTeam === 1 && !r.draw, `${tag}: even split, team1 more tricks`);
      else check(r.draw && r.winningTeam === null, `${tag}: even split, equal tricks is a draw`);
    }
  }
}

fuzz(4, 1, 1, 3000);
fuzz(6, 1, 100000, 3000);
fuzz(6, 2, 150000, 3000);
fuzz(8, 2, 200000, 3000);

// 2) Targeted: trump beats higher lead-suit card.
{
  // Build a trick manually via beats()
  const Ace = { suit: 'S', value: 14 };
  const trump2 = { suit: 'H', value: 2 };
  check(G.beats(trump2, Ace, 'S', 'H') === true, 'low trump beats Ace of lead suit');
  check(G.beats(Ace, trump2, 'S', 'H') === false, 'Ace of lead does not beat trump');
}

// 3) Targeted: off-suit non-trump cannot win.
{
  const lead7 = { suit: 'S', value: 7 };
  const offK = { suit: 'D', value: 13 }; // not trump, not lead
  check(G.beats(offK, lead7, 'S', 'H') === false, 'off-suit non-trump cannot beat lead');
}

// 4) Targeted: two trumps compared by value.
{
  const tHi = { suit: 'H', value: 10 };
  const tLo = { suit: 'H', value: 9 };
  check(G.beats(tHi, tLo, 'S', 'H') === true, 'higher trump wins');
  check(G.beats(tLo, tHi, 'S', 'H') === false, 'lower trump loses');
}

// 5) Targeted: trump may shift during the establishing trick, then locks for good.
{
  const rng = mulberry32(42);
  const state = G.createGame(rng);
  let locked = null;
  while (state.phase === 'playing') {
    const legal = G.legalMoves(state, state.turn);
    G.playCard(state, state.turn, legal[0].uid);
    if (state.trumpLocked) {
      if (locked === null) locked = state.trump;
      check(state.trump === locked, 'trump never changes once locked');
    } else {
      check(!locked, 'trump does not lock and then unlock');
    }
  }
  check(state.trump === null || state.trumpLocked, 'a trump that was set ends up locked');
}

// 5b) Targeted: within the establishing trick the LAST void player sets the trump
//     and wins; the trump then locks.
{
  const c = (label, suit, value) => ({ label, suit, value, id: label + suit, uid: label + suit });
  const state = {
    phase: 'playing', numPlayers: 4, decks: 1, tricksPerHand: 13,
    trump: null, trumpLocked: false, leadSuit: null, leader: 0, turn: 0,
    currentTrick: [], trickNumber: 0, tricksWon: [0, 0], mendis: { 0: [], 1: [] },
    history: [], lastTrick: null, result: null,
    hands: [[c('A', 'C', 14)], [c('K', 'H', 13)], [c('Q', 'S', 12)], [c('9', 'D', 9)]],
  };
  G.playCard(state, 0, 'AC'); check(state.leadSuit === 'C', 'clubs led');
  G.playCard(state, 1, 'KH'); check(state.trump === 'H', 'first void sets trump = hearts');
  G.playCard(state, 2, 'QS'); check(state.trump === 'S', 'second void overrides to spades');
  G.playCard(state, 3, '9D'); check(state.trump === 'D', 'last void overrides to diamonds');
  check(state.lastTrick && state.lastTrick.winner === 3, 'last void player wins the trick');
  check(state.trumpLocked === true, 'trump locks at the end of the establishing trick');
}

// 6) Targeted: 6-player teams alternate and split 3/3.
{
  const t0 = [0, 2, 4].map(G.teamOf);
  const t1 = [1, 3, 5].map(G.teamOf);
  check(t0.every((x) => x === 0), 'seats 0,2,4 are team 0');
  check(t1.every((x) => x === 1), 'seats 1,3,5 are team 1');
  const deck6 = G.makeDeck(6);
  check(deck6.length === 48, '6-player single deck has 48 cards');
  check(deck6.filter((c) => c.value === 10).length === 4, '6-player single deck keeps all four mendis');
}

// 9) Targeted: 6-player double deck — 2–5 stripped, 72 cards (6→A), eight tens.
{
  const deck = G.makeDeck(6, 2);
  check(deck.length === 72, '6-player double deck has 72 cards');
  check(!deck.some((c) => c.value < 6), '6-player double deck drops 2,3,4,5');
  check(deck.filter((c) => c.value === 10).length === 8, '6-player double deck has eight mendis');
  check(new Set(deck.map((c) => c.uid)).size === 72, '6-player double deck has 72 unique uids');
  check(G.decksFor(6, 2) === 2 && G.decksFor(6, 1) === 1, 'decksFor honours the 6-player choice');
  check(G.decksFor(8, 1) === 2 && G.decksFor(4, 2) === 1, 'decksFor forces 8p→2 and 4p→1');
}

// 7) Targeted: two-deck "second identical card wins".
{
  const aceEarly = { suit: 'C', value: 14 };
  const aceLate = { suit: 'C', value: 14 };
  check(G.beats(aceLate, aceEarly, 'C', null) === true, 'later duplicate beats the earlier copy (lead suit)');
  check(G.beats(aceLate, aceEarly, 'C', 'H') === true, 'later duplicate beats earlier copy when neither is trump');
  // Full trick: an opponent's Ace of clubs is overtaken by the second Ace of clubs.
  const trick = [
    { seat: 0, card: { suit: 'C', value: 14 } }, // opponent's first Ace
    { seat: 1, card: { suit: 'C', value: 9 } },
    { seat: 2, card: { suit: 'C', value: 14 } }, // our second Ace, played later
    { seat: 3, card: { suit: 'C', value: 7 } },
  ];
  check(G.trickWinner(trick, 'C', null) === 2, 'second Ace of clubs takes the trick');
  // Two identical trumps: the later one wins too.
  const tEarly = { suit: 'H', value: 13 };
  const tLate = { suit: 'H', value: 13 };
  check(G.beats(tLate, tEarly, 'S', 'H') === true, 'later duplicate trump wins');
}

// 8) Targeted: 8-player deck and teams.
{
  const deck8 = G.makeDeck(8);
  check(deck8.length === 104, '8-player deck has 104 cards (two decks)');
  check(new Set(deck8.map((c) => c.uid)).size === 104, '8-player deck has 104 unique uids');
  check(deck8.filter((c) => c.value === 10).length === 8, '8-player deck has eight mendis');
  const t0 = [0, 2, 4, 6].map(G.teamOf), t1 = [1, 3, 5, 7].map(G.teamOf);
  check(t0.every((x) => x === 0), 'seats 0,2,4,6 are team 0');
  check(t1.every((x) => x === 1), 'seats 1,3,5,7 are team 1');
}

if (failures === 0) console.log('ALL CHECKS PASSED (3000 each: 4p, 6p single, 6p double, 8p fuzzed games + targeted rule tests)');
else console.error(`${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
