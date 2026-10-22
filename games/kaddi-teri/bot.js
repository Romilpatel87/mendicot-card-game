// bot.js — a heuristic Kali Tiri player: bids conservatively, declares trump in its
// longest suit and names strong off-trump partners, and plays point-aware (grabs point
// tricks cheaply, feeds points to a known partner, never hands points to opponents).
const G = require('./game');

// What the bot can know about teams: it knows its OWN side (it's the declarer, or it
// holds/was-dealt a called card), and any partner already revealed by play. Other
// unrevealed seats are unknown and treated as opponents for safety.
function onDeclarerTeam(state, seat) {
  if (seat === state.declarer) return true;
  if (state.revealed[seat]) return true;
  return state.hands[seat].some((c) => state.remainingCalls.includes(c.id));
}
function knownPartner(state, seat, me) {
  if (seat === me) return false;
  const meT0 = onDeclarerTeam(state, me);
  if (seat === state.declarer || state.revealed[seat]) return meT0; // seat is team0
  return false; // unknown
}
function knownOpponent(state, seat, me) {
  const meT0 = onDeclarerTeam(state, me);
  if (seat === state.declarer || state.revealed[seat]) return !meT0;
  return false; // unknown
}

// ---- bidding ----------------------------------------------------------------

function chooseBid(state, seat) {
  const hand = state.hands[seat];
  const handPts = hand.reduce((s, c) => s + c.points, 0);
  const highs = hand.filter((c) => c.value >= 12).length;       // Q, K, A
  const bySuit = {};
  for (const c of hand) bySuit[c.suit] = (bySuit[c.suit] || 0) + 1;
  const longest = Math.max(0, ...Object.values(bySuit));
  // Crude willingness: minimum + control bonuses + a slice of our own points.
  const willing = Math.min(
    state.bidMax,
    state.bidMin + highs * 10 + Math.max(0, longest - 3) * 10 + Math.floor(handPts / 3)
  );
  const forced = G.activeSeats(state).length === 1 && state.highBid === null;
  if (forced) return { action: 'bid', amount: state.bidMin };
  const floor = state.highBid === null ? state.bidMin : state.highBid + 5;
  if (floor > state.bidMax || floor > willing) return { action: 'pass' };
  return { action: 'bid', amount: Math.min(state.bidMax, floor) }; // smallest legal raise
}

// ---- declaring --------------------------------------------------------------

function chooseDeclare(state, seat) {
  const hand = state.hands[seat];
  const bySuit = {};
  for (const c of hand) (bySuit[c.suit] = bySuit[c.suit] || []).push(c);
  let trump = G.SUITS[0], best = -1;
  for (const s of G.SUITS) {
    const cards = bySuit[s] || [];
    const score = cards.length * 10 + cards.reduce((a, c) => a + c.points, 0);
    if (score > best) { best = score; trump = s; }
  }
  const need = G.requiredPartners(state.numPlayers);
  const myIds = new Set(hand.map((c) => c.id));
  const deckIds = G.makeDeck(state.numPlayers, state.decks).map((c) => c.id);
  const deckSet = new Set(deckIds);
  const picks = [];
  // Prefer high cards we DON'T hold, off the trump suit (keep trump control ourselves).
  for (const r of ['A', 'K', 'Q', 'J', '10']) {
    for (const s of G.SUITS) {
      if (picks.length >= need) break;
      const id = r + s;
      if (s === trump) continue;
      if (deckSet.has(id) && !myIds.has(id) && !picks.includes(id)) picks.push(id);
    }
  }
  for (const id of deckIds) { // fallback: any card we don't hold
    if (picks.length >= need) break;
    if (!myIds.has(id) && !picks.includes(id)) picks.push(id);
  }
  while (picks.length < need) picks.push(deckIds.find((id) => !picks.includes(id)) || deckIds[0]);
  return { trump, partnerCards: picks.slice(0, need) };
}

// ---- playing ----------------------------------------------------------------

function currentWinner(state) {
  const t = state.currentTrick;
  if (!t.length) return null;
  let best = t[0];
  for (let i = 1; i < t.length; i++) {
    if (G.beats(t[i].card, best.card, state.leadSuit, state.trump)) best = t[i];
  }
  return best;
}

const byLowPoint = (a, b) => a.points - b.points || a.value - b.value;
const lowPoint = (arr) => arr.slice().sort(byLowPoint)[0];
const lowCard = (arr) => arr.slice().sort((a, b) => a.value - b.value)[0];
const highCard = (arr) => arr.slice().sort((a, b) => b.value - a.value)[0];

function chooseCard(state, seat) {
  const legal = G.legalMoves(state, seat);
  if (legal.length <= 1) return legal[0];
  const trump = state.trump;

  // Leading: cash an Ace if we have one; otherwise probe with a low 0-point card and
  // never lead the 3♠ away (don't gift 30 points).
  if (state.currentTrick.length === 0) {
    const aces = legal.filter((c) => c.value === 14);
    if (aces.length) return aces[0];
    const junk = legal.filter((c) => c.points === 0 && !(c.value === 3 && c.suit === 'S'));
    return lowCard(junk.length ? junk : legal);
  }

  const winner = currentWinner(state);
  const best = winner.card;
  const trickPts = state.currentTrick.reduce((s, p) => s + p.card.points, 0);
  const isLast = state.currentTrick.length === state.numPlayers - 1;
  const winners = legal.filter((c) => G.beats(c, best, state.leadSuit, trump));

  if (knownPartner(state, winner.seat, seat)) {
    // Partner is winning — pile points onto our trick when it's safely ours (we're last),
    // otherwise keep our low junk.
    if (isLast) {
      const pointers = legal.filter((c) => c.points > 0);
      if (pointers.length) return highCard(pointers);
    }
    return lowPoint(legal);
  }

  // Opponent or unknown winning. Grab the points if there are any and we can — as
  // cheaply as possible; if it's our last chance (last to play) take any winner.
  if (winners.length && (trickPts > 0 || isLast)) {
    return lowCard(winners.length ? winners : legal);
  }
  // Can't (or not worth it to) win: throw our lowest-point card so opponents get nothing.
  return lowPoint(legal);
}

module.exports = { chooseBid, chooseDeclare, chooseCard };
