// game.js — Pure Kali Tiri (Kaali Teeri / "3 of Spades") rules engine. No I/O.
//
// A bidding + trick-taking POINT game. Phases: bidding → declaring → playing → finished.
//   1. bidding   — players bid a point target (or pass, which is final). Highest bid wins.
//   2. declaring — the bid winner picks the trump suit (announced) and names partner card(s),
//                  which stay secret until the holder plays them.
//   3. playing   — trick-taking; the trick winner collects its point cards.
//   4. finished  — the bidding team wins iff it captured at least its bid.
//
// Points: 3♠ = 30; A/10/J/Q/K = 10 each; 5 = 5; everything else 0. Total = 250 (single
// deck) / 500 (two decks). The minimum bid (150 / 300) is above half, so a deal is never
// a tie — one side always wins.
//
// Players/teams: 4 (2v2), 6 (3v3, single OR double deck), 8 (4v4, double deck). The
// bidding team is the declarer + the named partners; partners = numPlayers/2 - 1.

const SUITS = ['S', 'H', 'D', 'C']; // Spades, Hearts, Diamonds, Clubs
const RANKS = [
  { label: '2', value: 2 }, { label: '3', value: 3 }, { label: '4', value: 4 },
  { label: '5', value: 5 }, { label: '6', value: 6 }, { label: '7', value: 7 },
  { label: '8', value: 8 }, { label: '9', value: 9 }, { label: '10', value: 10 },
  { label: 'J', value: 11 }, { label: 'Q', value: 12 }, { label: 'K', value: 13 },
  { label: 'A', value: 14 },
];

const nextSeat = (seat, n) => (seat + 1) % n;
const requiredPartners = (numPlayers) => numPlayers / 2 - 1; // 4→1, 6→2, 8→3

// 8-player always uses two decks; 6-player is one or two by choice; otherwise one.
function decksFor(numPlayers, decks) {
  if (numPlayers === 8) return 2;
  if (numPlayers === 6) return decks === 2 ? 2 : 1;
  return 1;
}

// Card point value. The black three (3♠) is the prize at 30.
function pointsOf(value, suit) {
  if (value === 3 && suit === 'S') return 30;
  if (value >= 10) return 10; // 10, J, Q, K, A
  if (value === 5) return 5;
  return 0;
}

// Build the deck. 6-player drops the four/eight 2s (0-point cards) so 48 / 96 cards deal
// evenly; 4-player (52) and 8-player (104) already divide. Point totals stay 250 / 500.
function makeDeck(numPlayers = 4, decks) {
  decks = decksFor(numPlayers, decks);
  const ranks = numPlayers === 6 ? RANKS.filter((r) => r.value !== 2) : RANKS;
  const deck = [];
  for (let d = 0; d < decks; d++) {
    for (const suit of SUITS) {
      for (const r of ranks) {
        const id = r.label + suit;
        deck.push({
          suit, label: r.label, value: r.value, points: pointsOf(r.value, suit),
          id, uid: decks > 1 ? `${id}#${d}` : id,
        });
      }
    }
  }
  return deck;
}

function totalPoints(numPlayers = 4, decks) {
  return makeDeck(numPlayers, decks).reduce((s, c) => s + c.points, 0);
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

// ---- create -----------------------------------------------------------------

function createGame(rng = Math.random, numPlayers = 4, decks) {
  if (![4, 6, 8].includes(numPlayers)) numPlayers = 4;
  decks = decksFor(numPlayers, decks);
  const deck = shuffle(makeDeck(numPlayers, decks), rng);
  const hands = Array.from({ length: numPlayers }, () => []);
  for (let i = 0; i < deck.length; i++) hands[i % numPlayers].push(deck[i]);
  for (const h of hands) h.sort(sortCards);

  const startBidder = Math.floor(rng() * numPlayers);
  return {
    phase: 'bidding',
    numPlayers, decks,
    hands,
    tricksPerHand: deck.length / numPlayers,

    // bidding
    bidMin: decks === 2 ? 300 : 150,
    bidMax: decks === 2 ? 500 : 250,
    startBidder,
    bidTurn: startBidder,
    bids: Array(numPlayers).fill(null),
    passed: Array(numPlayers).fill(false),
    highBid: null,
    highBidder: null,
    forcedBid: false, // true when the lone remaining bidder must bid (can't pass)

    // contract (set at declare time)
    declarer: null,
    contract: null,
    trump: null,
    partnerCards: [],   // the public partner calls (card ids, may repeat in two-deck)
    remainingCalls: [], // calls not yet consumed by a play
    revealed: Array(numPlayers).fill(false), // partners revealed by play

    // play
    leader: null,
    turn: null,
    leadSuit: null,
    currentTrick: [], // [{ seat, card }]
    trickNumber: 0,
    pointsBySeat: Array(numPlayers).fill(0),
    lastTrick: null,  // { plays, winner, points }
    result: null,
  };
}

// ---- bidding ----------------------------------------------------------------

const activeSeats = (state) =>
  state.passed.map((p, s) => (p ? -1 : s)).filter((s) => s >= 0);

function nextActiveSeat(state, from) {
  for (let i = 1; i <= state.numPlayers; i++) {
    const s = (from + i) % state.numPlayers;
    if (!state.passed[s]) return s;
  }
  return from;
}

function advanceBidding(state) {
  const active = activeSeats(state);
  if (active.length <= 1) {
    if (state.highBidder !== null) return finalizeAuction(state); // everyone else passed
    // Lone player and nobody has bid — they are forced to open (can't pass).
    state.bidTurn = active[0];
    state.forcedBid = true;
    return;
  }
  state.bidTurn = nextActiveSeat(state, state.bidTurn);
  state.forcedBid = false;
}

function finalizeAuction(state) {
  state.phase = 'declaring';
  state.declarer = state.highBidder;
  state.contract = state.highBid;
  state.bidTurn = null;
  state.forcedBid = false;
}

// Place a bid. Must beat the current high by 5–20 and stay within [bidMin, bidMax].
function bid(state, seat, amount) {
  if (state.phase !== 'bidding') return { ok: false, error: 'Bidding is over.' };
  if (seat !== state.bidTurn) return { ok: false, error: 'Not your turn to bid.' };
  if (state.passed[seat]) return { ok: false, error: 'You already passed.' };
  amount = Number(amount);
  if (!Number.isInteger(amount) || amount % 5 !== 0) return { ok: false, error: 'Bid must be a multiple of 5.' };
  if (amount < state.bidMin || amount > state.bidMax)
    return { ok: false, error: `Bid must be ${state.bidMin}–${state.bidMax}.` };
  if (state.highBid === null) {
    if (amount - state.bidMin > 20) return { ok: false, error: 'Open at most +20 over the minimum.' };
  } else {
    if (amount <= state.highBid) return { ok: false, error: 'Bid must beat the current bid.' };
    if (amount - state.highBid > 20) return { ok: false, error: 'Raise at most +20.' };
  }
  state.highBid = amount;
  state.highBidder = seat;
  state.bids[seat] = amount;
  advanceBidding(state);
  return { ok: true };
}

// Pass — final (you're out). Illegal if you are the last bidder with no bid yet.
function passBid(state, seat) {
  if (state.phase !== 'bidding') return { ok: false, error: 'Bidding is over.' };
  if (seat !== state.bidTurn) return { ok: false, error: 'Not your turn to bid.' };
  if (state.passed[seat]) return { ok: false, error: 'You already passed.' };
  if (activeSeats(state).length === 1 && state.highBid === null)
    return { ok: false, error: 'You must bid.' };
  state.passed[seat] = true;
  advanceBidding(state);
  return { ok: true };
}

// ---- declaring --------------------------------------------------------------

// The bid winner names the trump suit and the partner card(s).
function declare(state, seat, trump, partnerCards) {
  if (state.phase !== 'declaring') return { ok: false, error: 'Not the declaring step.' };
  if (seat !== state.declarer) return { ok: false, error: 'Only the bid winner declares.' };
  if (!SUITS.includes(trump)) return { ok: false, error: 'Pick a trump suit.' };
  const need = requiredPartners(state.numPlayers);
  if (!Array.isArray(partnerCards) || partnerCards.length !== need)
    return { ok: false, error: `Name exactly ${need} partner card(s).` };
  const valid = new Set(makeDeck(state.numPlayers, state.decks).map((c) => c.id));
  for (const id of partnerCards) if (!valid.has(id)) return { ok: false, error: `No such card: ${id}` };

  state.trump = trump;
  state.partnerCards = partnerCards.slice();
  state.remainingCalls = partnerCards.slice();
  state.revealed = Array(state.numPlayers).fill(false);
  state.phase = 'playing';
  state.leader = state.declarer;
  state.turn = state.declarer;
  state.leadSuit = null;
  state.currentTrick = [];
  state.trickNumber = 0;
  state.pointsBySeat = Array(state.numPlayers).fill(0);
  state.lastTrick = null;
  return { ok: true };
}

// ---- playing ----------------------------------------------------------------

function legalMoves(state, seat) {
  if (state.phase !== 'playing' || seat !== state.turn) return [];
  const hand = state.hands[seat];
  if (state.currentTrick.length === 0) return hand.slice();
  const inSuit = hand.filter((c) => c.suit === state.leadSuit);
  return inSuit.length ? inSuit : hand.slice();
}

// Does card x (played later) beat the current best y? Trump beats non-trump; otherwise
// only lead-suit cards can win; ties go to the EARLIER card (first played wins).
function beats(x, y, leadSuit, trump) {
  const xT = x.suit === trump, yT = y.suit === trump;
  if (xT && !yT) return true;
  if (!xT && yT) return false;
  if (xT && yT) return x.value > y.value;
  const xL = x.suit === leadSuit, yL = y.suit === leadSuit;
  if (xL && !yL) return true;
  if (!xL && yL) return false;
  if (xL && yL) return x.value > y.value;
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

  // Partner reveal: playing a still-unclaimed called card joins the declarer's team.
  const ci = state.remainingCalls.indexOf(picked.id);
  if (ci >= 0) {
    state.remainingCalls.splice(ci, 1);
    if (seat !== state.declarer) state.revealed[seat] = true;
  }

  if (state.currentTrick.length < state.numPlayers) {
    state.turn = nextSeat(seat, state.numPlayers);
    return { ok: true };
  }

  // Trick complete — award its points to the winner's seat.
  const winner = trickWinner(state.currentTrick, state.leadSuit, state.trump);
  const pts = state.currentTrick.reduce((s, p) => s + p.card.points, 0);
  state.pointsBySeat[winner] += pts;
  state.lastTrick = { plays: state.currentTrick.slice(), winner, points: pts };
  state.trickNumber += 1;
  state.currentTrick = [];
  state.leadSuit = null;
  state.turn = winner;
  state.leader = winner;
  if (state.trickNumber === state.tricksPerHand) finishGame(state);
  return { ok: true };
}

function finishGame(state) {
  state.phase = 'finished';
  const team0 = [], team1 = []; // team0 = declarer's side
  for (let s = 0; s < state.numPlayers; s++) {
    if (s === state.declarer || state.revealed[s]) team0.push(s); else team1.push(s);
  }
  const sum = (seats) => seats.reduce((a, s) => a + state.pointsBySeat[s], 0);
  const declarerPoints = sum(team0);
  const opponentPoints = sum(team1);
  const made = declarerPoints >= state.contract;
  state.result = {
    declarer: state.declarer,
    contract: state.contract,
    trump: state.trump,
    partnerCards: state.partnerCards.slice(),
    team0, team1,
    declarerPoints, opponentPoints,
    made,
    winningTeam: made ? 0 : 1, // 0 = bidding team, 1 = opponents
    pointsBySeat: state.pointsBySeat.slice(),
  };
}

module.exports = {
  SUITS, RANKS, nextSeat, requiredPartners, decksFor, pointsOf, makeDeck, totalPoints,
  shuffle, sortCards, createGame, activeSeats, bid, passBid, declare,
  legalMoves, beats, trickWinner, playCard, finishGame,
};
