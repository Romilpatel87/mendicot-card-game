// bot.js — Kachuful bot. Estimates its trick count to bid, then plays to hit that bid:
// chasing tricks when short, shedding safely when it has enough. Pure functions over state.
const G = require('./game');

// Rough probability a single card wins a trick, given the trump suit.
function winChance(card, trump, handSize) {
  if (card.suit === trump) {
    if (card.value === 14) return 0.95;
    if (card.value === 13) return 0.85;
    if (card.value === 12) return 0.65;
    if (card.value === 11) return 0.45;
    return 0.25; // low trumps still ruff side suits
  }
  if (card.value === 14) return 0.9;   // bare ace
  if (card.value === 13) return 0.55;  // king, often catchable
  if (card.value === 12) return 0.25;
  return 0.05;
}

function chooseBid(state, seat) {
  const hand = state.hands[seat];
  const expect = hand.reduce((s, c) => s + winChance(c, state.trump, state.cardsThisHand), 0);
  let b = Math.max(0, Math.min(state.cardsThisHand, Math.round(expect)));
  const forbidden = G.dealerForbidden(state, seat);
  if (b === forbidden) {
    // nudge toward the honest estimate while staying legal
    const down = b - 1, up = b + 1;
    if (up <= state.cardsThisHand && (expect >= b || down < 0)) b = up;
    else if (down >= 0) b = down;
    else b = up;
  }
  return Math.max(0, Math.min(state.cardsThisHand, b));
}

// Current best card in the trick (or null if leading).
function currentBest(state) {
  if (state.currentTrick.length === 0) return null;
  let best = state.currentTrick[0];
  for (const p of state.currentTrick) {
    if (p === best) continue;
    if (G.beats(p.card, best.card, state.leadSuit, state.trump)) best = p;
  }
  return best;
}

function chooseCard(state, seat) {
  const legal = G.legalMoves(state, seat);
  if (!legal.length) return null;
  const lo = legal.slice().sort((a, b) => a.value - b.value);
  const need = state.bids[seat] - state.tricksWon[seat]; // tricks still wanted
  const wantMore = need > 0;
  const best = currentBest(state);

  // leading the trick
  if (!best) {
    if (wantMore) {
      // lead something strong: prefer a high trump, else the highest side card
      const trumps = lo.filter((c) => c.suit === state.trump);
      const pool = trumps.length ? trumps : lo;
      return pool[pool.length - 1];
    }
    return lo[0]; // want no more — lead the lowest card
  }

  // following — would each legal card currently win?
  const winners = legal
    .filter((c) => G.beats(c, best.card, state.leadSuit, state.trump))
    .sort((a, b) => a.value - b.value);
  const losers = legal
    .filter((c) => !G.beats(c, best.card, state.leadSuit, state.trump))
    .sort((a, b) => a.value - b.value);

  if (wantMore) {
    if (winners.length) return winners[0]; // win as cheaply as possible
    return lo[0];                          // can't win → throw the lowest
  }
  // want no more tricks
  if (losers.length) return losers[losers.length - 1]; // dump the highest safe card
  return winners[0];                                    // forced to win → overshoot by the least
}

module.exports = { chooseBid, chooseCard, winChance };
