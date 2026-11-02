// game.js — Pure Kachuful (Kachu Phool / Judgement / "Oh Hell") rules engine. No I/O.
//
// A SOLO (no partnerships) trick-PREDICTION game played over a ladder of hands.
//   • The deal shrinks by one card each hand down to a single-card hand, then grows
//     back up to the start size — so a start of S gives 2S-1 hands.
//   • The trump suit rotates every hand: Spades → Diamonds → Clubs → Hearts → …
//   • Each hand: every player predicts (bids) how many tricks they will take. The
//     dealer bids last and may NOT bid the value that would make the bids total the
//     number of tricks ("screw the dealer"), so someone is always off.
//   • Play is normal trick-taking (follow suit; highest trump, else highest lead suit).
//   • Scoring (gamerules.com "most common" method): 1 point per trick won, plus a
//     10-point bonus for taking EXACTLY your bid. Scores accumulate across every hand;
//     highest total after the last hand wins.
//
// Phases: bidding → playing → (handOver → bidding)* → finished.

const SUITS = ['S', 'H', 'D', 'C'];               // Spades, Hearts, Diamonds, Clubs
const TRUMP_CYCLE = ['S', 'D', 'C', 'H'];         // rotates each hand, per the rules
const RANKS = [
  { label: '2', value: 2 }, { label: '3', value: 3 }, { label: '4', value: 4 },
  { label: '5', value: 5 }, { label: '6', value: 6 }, { label: '7', value: 7 },
  { label: '8', value: 8 }, { label: '9', value: 9 }, { label: '10', value: 10 },
  { label: 'J', value: 11 }, { label: 'Q', value: 12 }, { label: 'K', value: 13 },
  { label: 'A', value: 14 }, // Ace high
];

const nextSeat = (seat, n) => (seat + 1) % n;
const decksFor = (decks) => (decks === 2 ? 2 : 1);

// Largest opening deal that still fits the deck, capped at 10. One deck: 3-5p→10, 6p→8,
// 7p→7. Two decks (104 cards) comfortably start every table at 10.
function startCardsFor(numPlayers, decks = 1) {
  return Math.min(10, Math.floor((52 * decksFor(decks)) / numPlayers));
}

// The full ladder of hand sizes: S, S-1, … , 1, 2, … , S  (length 2S-1).
function handSizesFor(numPlayers, decks = 1) {
  const s = startCardsFor(numPlayers, decks);
  const sizes = [];
  for (let k = s; k >= 1; k--) sizes.push(k);
  for (let k = 2; k <= s; k++) sizes.push(k);
  return sizes;
}

// One or two 52-card decks. With two decks every card exists twice; `uid` (e.g. "AS#1")
// tells the physical copies apart while `id` ("AS") stays the logical card.
function makeDeck(decks = 1) {
  decks = decksFor(decks);
  const deck = [];
  for (let d = 0; d < decks; d++) {
    for (const suit of SUITS) {
      for (const r of RANKS) {
        const id = r.label + suit;
        deck.push({ suit, label: r.label, value: r.value, id, uid: decks > 1 ? `${id}#${d}` : id });
      }
    }
  }
  return deck;
}

function shuffle(deck, rng = Math.random) {
  const a = deck.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const sortCards = (a, b) =>
  a.suit === b.suit ? a.value - b.value : SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);

// ---- create / deal ----------------------------------------------------------

function createGame(rng = Math.random, numPlayers = 4, decks = 1) {
  numPlayers = Math.max(3, Math.min(7, numPlayers | 0));
  decks = decksFor(decks);
  const handSizes = handSizesFor(numPlayers, decks);
  const state = {
    phase: 'bidding',
    numPlayers, decks,
    startCards: startCardsFor(numPlayers, decks),
    handSizes,
    totalHands: handSizes.length,
    handIndex: 0,
    cardsThisHand: handSizes[0],
    trump: TRUMP_CYCLE[0],
    firstDealer: Math.floor(rng() * numPlayers),
    dealer: null,
    // per-hand (filled by dealHand)
    hands: [], bids: [], bidTurn: null, tricksWon: [],
    leader: null, turn: null, leadSuit: null,
    currentTrick: [], trickNumber: 0, lastTrick: null,
    // accumulating across the whole game
    scores: Array(numPlayers).fill(0),
    handResult: null,
    result: null,
  };
  state.dealer = state.firstDealer;
  dealHand(state, rng);
  return state;
}

// Deal the current hand (state.handIndex / .dealer already set), open the bidding.
function dealHand(state, rng = Math.random) {
  const n = state.numPlayers;
  const cards = state.handSizes[state.handIndex];
  state.cardsThisHand = cards;
  state.trump = TRUMP_CYCLE[state.handIndex % TRUMP_CYCLE.length];
  const deck = shuffle(makeDeck(state.decks), rng);
  const hands = Array.from({ length: n }, () => []);
  for (let i = 0; i < cards * n; i++) hands[i % n].push(deck[i]);
  for (const h of hands) h.sort(sortCards);
  state.hands = hands;
  state.bids = Array(n).fill(null);
  state.tricksWon = Array(n).fill(0);
  state.bidTurn = nextSeat(state.dealer, n);   // left of dealer bids first
  state.leader = nextSeat(state.dealer, n);    // and leads the first trick
  state.turn = null;
  state.leadSuit = null;
  state.currentTrick = [];
  state.trickNumber = 0;
  state.lastTrick = null;
  state.handResult = null;
  state.phase = 'bidding';
}

// ---- bidding ----------------------------------------------------------------

const bidsPlaced = (state) => state.bids.filter((b) => b !== null).length;
const sumOtherBids = (state, seat) =>
  state.bids.reduce((s, b, i) => s + (i !== seat && b !== null ? b : 0), 0);

// The dealer (last bidder) may not make the bids total exactly the trick count.
// Returns that forbidden value, or -1 if none applies (not the dealer's final turn).
function dealerForbidden(state, seat) {
  if (seat !== state.dealer) return -1;
  if (bidsPlaced(state) !== state.numPlayers - 1) return -1; // not everyone else in yet
  const f = state.cardsThisHand - sumOtherBids(state, seat);
  return f >= 0 && f <= state.cardsThisHand ? f : -1;
}

function bid(state, seat, amount) {
  if (state.phase !== 'bidding') return { ok: false, error: 'Bidding is over.' };
  if (seat !== state.bidTurn) return { ok: false, error: 'Not your turn to bid.' };
  amount = Number(amount);
  if (!Number.isInteger(amount) || amount < 0 || amount > state.cardsThisHand)
    return { ok: false, error: `Bid 0–${state.cardsThisHand}.` };
  if (amount === dealerForbidden(state, seat))
    return { ok: false, error: `As dealer you can't bid ${amount} (bids can't total ${state.cardsThisHand}).` };
  state.bids[seat] = amount;
  if (bidsPlaced(state) === state.numPlayers) startPlay(state);
  else state.bidTurn = nextSeat(seat, state.numPlayers);
  return { ok: true };
}

function startPlay(state) {
  state.phase = 'playing';
  state.bidTurn = null;
  state.turn = state.leader;      // left of dealer leads first
  state.leadSuit = null;
  state.currentTrick = [];
  state.trickNumber = 0;
}

// ---- playing ----------------------------------------------------------------

function legalMoves(state, seat) {
  if (state.phase !== 'playing' || seat !== state.turn) return [];
  const hand = state.hands[seat];
  if (state.currentTrick.length === 0) return hand.slice();
  const inSuit = hand.filter((c) => c.suit === state.leadSuit);
  return inSuit.length ? inSuit : hand.slice();
}

// Does card x (played LATER) beat current best y? Trump beats non-trump; else only
// lead-suit cards win. The tiebreak uses `>=`, so when two IDENTICAL cards meet (only
// possible with two decks) the one played second wins — "the second card is higher".
// With one deck there are no duplicates, so `>=` behaves exactly like `>`.
function beats(x, y, leadSuit, trump) {
  const xT = x.suit === trump, yT = y.suit === trump;
  if (xT && !yT) return true;
  if (!xT && yT) return false;
  if (xT && yT) return x.value >= y.value;
  const xL = x.suit === leadSuit, yL = y.suit === leadSuit;
  if (xL && !yL) return true;
  if (!xL && yL) return false;
  if (xL && yL) return x.value >= y.value;
  return false;
}

function trickWinner(trick, leadSuit, trump) {
  let best = trick[0];
  for (let i = 1; i < trick.length; i++) {
    if (beats(trick[i].card, best.card, leadSuit, trump)) best = trick[i];
  }
  return best.seat;
}

function playCard(state, seat, id) {
  if (state.phase !== 'playing') return { ok: false, error: 'No cards to play yet.' };
  if (seat !== state.turn) return { ok: false, error: 'Not your turn.' };
  const hand = state.hands[seat];
  const idx = hand.findIndex((c) => c.uid === id || c.id === id);
  if (idx === -1) return { ok: false, error: 'You do not have that card.' };
  const picked = hand[idx];
  if (!legalMoves(state, seat).some((c) => c.uid === picked.uid))
    return { ok: false, error: 'You must follow suit.' };

  hand.splice(idx, 1);
  if (state.currentTrick.length === 0) { state.leadSuit = picked.suit; state.leader = seat; }
  state.currentTrick.push({ seat, card: picked });

  if (state.currentTrick.length < state.numPlayers) {
    state.turn = nextSeat(seat, state.numPlayers);
    return { ok: true };
  }

  const winner = trickWinner(state.currentTrick, state.leadSuit, state.trump);
  state.tricksWon[winner] += 1;
  state.lastTrick = { plays: state.currentTrick.slice(), winner };
  state.trickNumber += 1;
  state.currentTrick = [];
  state.leadSuit = null;
  state.turn = winner;
  state.leader = winner;
  if (state.trickNumber === state.cardsThisHand) scoreHand(state);
  return { ok: true };
}

// ---- scoring / hand transitions ---------------------------------------------

function scoreHand(state) {
  const n = state.numPlayers;
  const deltas = Array(n).fill(0);
  const made = Array(n).fill(false);
  for (let s = 0; s < n; s++) {
    const exact = state.tricksWon[s] === state.bids[s];
    made[s] = exact;
    deltas[s] = state.tricksWon[s] + (exact ? 10 : 0); // 1 per trick + 10 bonus if exact
    state.scores[s] += deltas[s];
  }
  state.handResult = {
    handNumber: state.handIndex + 1,
    totalHands: state.totalHands,
    cardsThisHand: state.cardsThisHand,
    trump: state.trump,
    dealer: state.dealer,
    bids: state.bids.slice(),
    tricksWon: state.tricksWon.slice(),
    deltas, made,
    scores: state.scores.slice(),
  };
  if (state.handIndex >= state.totalHands - 1) finishGame(state);
  else state.phase = 'handOver';
}

// Advance to the next hand (called after the handOver pause). No-op unless waiting.
function nextHand(state, rng = Math.random) {
  if (state.phase !== 'handOver') return { ok: false };
  state.handIndex += 1;
  state.dealer = nextSeat(state.dealer, state.numPlayers);
  dealHand(state, rng);
  return { ok: true };
}

function finishGame(state) {
  state.phase = 'finished';
  const n = state.numPlayers;
  const ranking = Array.from({ length: n }, (_, s) => s)
    .sort((a, b) => state.scores[b] - state.scores[a]);
  const top = state.scores[ranking[0]];
  const winners = ranking.filter((s) => state.scores[s] === top);
  state.result = {
    scores: state.scores.slice(),
    ranking,
    winners,
    topScore: top,
  };
}

module.exports = {
  SUITS, RANKS, TRUMP_CYCLE, nextSeat, decksFor,
  startCardsFor, handSizesFor, makeDeck, shuffle, sortCards,
  createGame, dealHand, bidsPlaced, sumOtherBids, dealerForbidden, bid, startPlay,
  legalMoves, beats, trickWinner, playCard, scoreHand, nextHand, finishGame,
};
