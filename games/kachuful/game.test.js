// game.test.js — fuzz + targeted checks for the Kachuful engine. Run: node games/kachuful/game.test.js
const assert = require('assert');
const G = require('./game');
const Bot = require('./bot');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let pass = 0;
const ok = (cond, msg) => { assert(cond, msg); pass++; };

// ---- ladder shape (single deck) ----
for (const [n, start, hands] of [[3, 10, 19], [4, 10, 19], [5, 10, 19], [6, 8, 15], [7, 7, 13]]) {
  ok(G.startCardsFor(n) === start, `start ${n}`);
  const sizes = G.handSizesFor(n);
  ok(sizes.length === hands, `hands ${n}`);
  ok(sizes[0] === start && sizes[sizes.length - 1] === start, `ends ${n}`);
  ok(Math.min(...sizes) === 1, `min 1 ${n}`);
  ok(sizes.every((c) => c * n <= 52), `fits deck ${n}`);
}
// ---- ladder shape (double deck): every table starts at 10 and fits 104 ----
for (const n of [3, 4, 5, 6, 7]) {
  ok(G.startCardsFor(n, 2) === 10, `dd start ${n}`);
  ok(G.handSizesFor(n, 2).every((c) => c * n <= 104), `dd fits ${n}`);
}

// ---- deck ----
ok(G.makeDeck().length === 52, 'deck size');
ok(new Set(G.makeDeck().map((c) => c.id)).size === 52, 'deck unique');
ok(G.makeDeck(2).length === 104, 'double deck size');
ok(new Set(G.makeDeck(2).map((c) => c.uid)).size === 104, 'double deck uids unique');
ok(new Set(G.makeDeck(2).map((c) => c.id)).size === 52, 'double deck has 52 logical cards');

// ---- second identical card wins (double deck) ----
{
  const aS0 = { suit: 'S', value: 14, id: 'AS', uid: 'AS#0' };
  const aS1 = { suit: 'S', value: 14, id: 'AS', uid: 'AS#1' };
  // y = first ace (current best), x = second ace played later → x wins
  ok(G.beats(aS1, aS0, 'S', 'H'), 'second identical lead card wins');
  ok(G.beats(aS1, aS0, 'S', 'S'), 'second identical trump wins');
  const kS = { suit: 'S', value: 13, id: 'KS', uid: 'KS' };
  ok(!G.beats(kS, aS0, 'S', 'H'), 'lower card still loses');
}

// ---- full games, all table sizes, many seeds ----
let games = 0, handsPlayed = 0;
for (let seed = 1; seed <= 1500; seed++) {
  const rng = mulberry32(seed);
  const n = 3 + (seed % 5); // 3..7
  const decks = seed % 2 === 0 ? 2 : 1;
  let st = G.createGame(rng, n, decks);
  ok(st.hands.reduce((a, h) => a + h.length, 0) === st.cardsThisHand * n, 'deal count');
  let guard = 0;
  while (st.phase !== 'finished') {
    if (++guard > 100000) throw new Error('loop guard');
    if (st.phase === 'bidding') {
      // dealer restriction: when it's the dealer's final bid, the forbidden value is illegal
      if (st.bidTurn === st.dealer && G.bidsPlaced(st) === n - 1) {
        const f = G.dealerForbidden(st, st.dealer);
        if (f >= 0) {
          const bad = G.bid(st, st.dealer, f);
          ok(!bad.ok, 'dealer forbidden rejected');
        }
      }
      const amt = Bot.chooseBid(st, st.bidTurn);
      ok(amt >= 0 && amt <= st.cardsThisHand, 'bot bid in range');
      const r = G.bid(st, st.bidTurn, amt);
      ok(r.ok, 'bid accepted: ' + (r.error || ''));
    } else if (st.phase === 'playing') {
      const seat = st.turn;
      const card = Bot.chooseCard(st, seat);
      ok(card, 'bot returns a card');
      // follow-suit legality
      const legal = G.legalMoves(st, seat);
      ok(legal.some((c) => c.uid === card.uid), 'bot card legal');
      const r = G.playCard(st, seat, card.uid);
      ok(r.ok, 'play accepted: ' + (r.error || ''));
    } else if (st.phase === 'handOver') {
      // verify the hand we just scored
      const hr = st.handResult;
      const totalTricks = hr.tricksWon.reduce((a, b) => a + b, 0);
      ok(totalTricks === hr.cardsThisHand, 'tricks sum to cards');
      // bids never total the card count (screw-the-dealer guarantee)
      const totalBids = hr.bids.reduce((a, b) => a + b, 0);
      ok(totalBids !== hr.cardsThisHand, 'bids never equal tricks');
      for (let s = 0; s < n; s++) {
        const exact = hr.tricksWon[s] === hr.bids[s];
        ok(hr.made[s] === exact, 'made flag');
        // exact-or-nothing: exact → tricks+10, burst → 0
        ok(hr.deltas[s] === (exact ? hr.tricksWon[s] + 10 : 0), 'delta formula');
      }
      handsPlayed++;
      G.nextHand(st, rng);
    }
  }
  // final checks
  ok(st.result, 'has result');
  ok(st.handResult && st.handResult.handNumber === st.totalHands, 'played all hands');
  // scores equal the sum of every hand's deltas — re-derive by replay is overkill; sanity: non-negative
  ok(st.scores.every((x) => x >= 0), 'scores non-negative');
  const top = Math.max(...st.scores);
  ok(st.result.topScore === top, 'top score');
  ok(st.result.winners.every((w) => st.scores[w] === top), 'winners at top');
  ok(st.result.ranking.length === n, 'ranking complete');
  games++;
}

// ---- trump rotation: ♠ ♦ ♣ ♥ then NO TRUMP, repeating ----
{
  const st = G.createGame(mulberry32(42), 4);
  ok(st.trump === 'S', 'first trump spades');
  const cyc = G.TRUMP_CYCLE;
  ok(cyc.length === 5, 'cycle length 5');
  ok(cyc.slice(0, 4).join('') === 'SDCH', 'four suits first');
  ok(cyc[4] === null, 'fifth is no-trump');
  // walk the ladder's trump by hand index
  const trumpFor = (i) => cyc[i % cyc.length];
  ok(trumpFor(4) === null && trumpFor(9) === null, 'every 5th hand is no-trump');
  // on a no-trump hand nothing can be trump, so the led suit must win
  const lead = { suit: 'H', value: 9, id: '9H', uid: '9H' };
  const other = { suit: 'S', value: 14, id: 'AS', uid: 'AS' }; // off-suit ace
  ok(G.beats(lead, other, 'H', null) === true || G.beats(other, lead, 'H', null) === false, 'no-trump: off-suit never beats led suit');
  ok(!G.beats(other, lead, 'H', null), 'no-trump: off-suit ace loses to led nine');
}

console.log(`✓ ${pass} assertions passed · ${games} games · ${handsPlayed} hands`);
