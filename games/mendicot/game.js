// game.js — Pure Mendicot (Dehla Pakad) rules engine. No I/O, no networking.
// Supports 4 players (teams {0,2} vs {1,3}, 52 cards, 13 tricks),
// 6 players (teams {0,2,4} vs {1,3,5}) in two flavours:
//   • single deck — the four 2s removed, 48 cards, 8 tricks;
//   • double deck — two 7→A decks with one ten per suit, 60 cards, 10 tricks;
// and 8 players (teams {0,2,4,6} vs {1,3,5,7}, two decks with one ten & one 2 per suit,
// 96 cards, 12 tricks).
// In every mode each player sits between two opponents: even seats are team 0,
// odd seats are team 1. There are always exactly 4 mendis — one ten per suit.
//
// Two-deck note: most cards exist twice, so a trick can hold two identical cards.
// The rule is "the later-played duplicate wins" — e.g. if an opponent plays the Ace
// of Clubs and a teammate later plays the other Ace of Clubs, the second one takes
// the trick (trickWinner walks the trick in play order and `beats` breaks ties in
// favour of the challenger). Tens are kept single, so a suit's mendi is never split.
//
// Trump rule: trump is broken the first time a player can't follow the lead suit.
// Within that ESTABLISHING trick every void player's off-suit card overrides the
// trump, so the last void player decides it; once that trick ends the trump LOCKS
// and never changes for the rest of the deal (see `trumpLocked`).

const SUITS = ['S', 'H', 'D', 'C']; // Spades, Hearts, Diamonds, Clubs
const RANKS = [
  { label: '2', value: 2 },
  { label: '3', value: 3 },
  { label: '4', value: 4 },
  { label: '5', value: 5 },
  { label: '6', value: 6 },
  { label: '7', value: 7 },
  { label: '8', value: 8 },
  { label: '9', value: 9 },
  { label: '10', value: 10 }, // mendi
  { label: 'J', value: 11 },
  { label: 'Q', value: 12 },
  { label: 'K', value: 13 },
  { label: 'A', value: 14 },
];

const teamOf = (seat) => seat % 2;
const nextSeat = (seat, numPlayers = 4) => (seat + 1) % numPlayers;
const cardId = (c) => c.label + c.suit;          // e.g. "10H", "AS"
const isMendi = (c) => c.value === 10;

// How many decks a table uses: 8-player is always two decks; 6-player can be one
// (48 cards) or two (72 cards) by request; everyone else is a single deck.
function decksFor(numPlayers, decks) {
  if (numPlayers === 8) return 2;
  if (numPlayers === 6) return decks === 2 ? 2 : 1;
  return 1;
}

// Build the deck for a table. 6-player single deck drops the four 2s (48 cards);
// 6-player double deck drops 2–5 from each deck so two decks make 72 cards (6→A,
// 12 each over 12 tricks); 8-player is two full decks (104); otherwise one full 52.
// `id` is the logical card ("AS"); `uid` is unique per physical card so duplicates
// in a two-deck game can be told apart by the UI and when removing one from a hand.
function makeDeck(numPlayers = 4, decks) {
  decks = decksFor(numPlayers, decks);
  let ranks = RANKS;
  if (numPlayers === 6) {
    // single deck: strip 2s (48 cards). double deck: strip 2–6 so that, with only one
    // ten per suit (below), 60 cards deal evenly to 6 players (10 each, 10 tricks).
    ranks = decks === 2 ? RANKS.filter((r) => r.value >= 7) : RANKS.filter((r) => r.value !== 2);
  }
  // Two-deck games keep just ONE ten per suit → 4 mendis, not 8. The 8-player deck
  // also keeps a single 2 per suit so 96 cards still deal evenly (8 × 12). These ranks
  // are dealt from the first deck only; the second deck skips them.
  const singleCopyValues = decks === 2 ? (numPlayers === 8 ? [10, 2] : [10]) : [];
  const deck = [];
  for (let d = 0; d < decks; d++) {
    for (const suit of SUITS) {
      for (const r of ranks) {
        if (d > 0 && singleCopyValues.includes(r.value)) continue; // skip the duplicate copy
        const id = r.label + suit;
        deck.push({ suit, label: r.label, value: r.value, id, uid: decks > 1 ? `${id}#${d}` : id });
      }
    }
  }
  return deck;
}

// Fisher–Yates using an injectable rng (defaults to Math.random) for testability.
function shuffle(deck, rng = Math.random) {
  const a = deck.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Rigged deal (host "stack the deck" cheat): give every Ace to `acesSeat` and every
// ten to `tensSeat`, then deal the remaining cards to fill all hands evenly.
function riggedDeal(fullDeck, numPlayers, acesSeat, tensSeat, rng) {
  const cardsEach = fullDeck.length / numPlayers;
  const aces = fullDeck.filter((c) => c.value === 14);
  const tens = fullDeck.filter((c) => c.value === 10);
  const rest = shuffle(fullDeck.filter((c) => c.value !== 14 && c.value !== 10), rng);
  const hands = Array.from({ length: numPlayers }, () => []);
  hands[acesSeat].push(...aces);
  hands[tensSeat].push(...tens);
  let ri = 0;
  for (let seat = 0; seat < numPlayers; seat++) {
    while (hands[seat].length < cardsEach && ri < rest.length) hands[seat].push(rest[ri++]);
  }
  return hands;
}

// Create a fresh game state. `rng` lets tests produce deterministic deals.
// `firstLeader` (optional seat index) forces who leads the first trick — the server
// uses it so the losing side starts the next deal (see the dealer/leader rules).
// `rig` (optional { acesSeat, tensSeat }) stacks the deck for the host cheat.
function createGame(rng = Math.random, numPlayers = 4, decks, firstLeader, rig) {
  if (![4, 6, 8].includes(numPlayers)) numPlayers = 4;
  decks = decksFor(numPlayers, decks);
  const fullDeck = makeDeck(numPlayers, decks);
  let hands;
  if (rig && Number.isInteger(rig.acesSeat) && Number.isInteger(rig.tensSeat)) {
    hands = riggedDeal(fullDeck, numPlayers, rig.acesSeat, rig.tensSeat, rng);
  } else {
    const deck = shuffle(fullDeck, rng);
    hands = Array.from({ length: numPlayers }, () => []);
    for (let i = 0; i < deck.length; i++) hands[i % numPlayers].push(deck[i]);
  }
  for (const h of hands) h.sort(sortCards);

  const tricksPerHand = fullDeck.length / numPlayers; // 13 (4p), 8 (6p×1), 12 (6p×2), 13 (8p)
  const leader = (Number.isInteger(firstLeader) && firstLeader >= 0 && firstLeader < numPlayers)
    ? firstLeader
    : nextSeat(Math.floor(rng() * numPlayers), numPlayers); // random otherwise
  const dealer = (leader - 1 + numPlayers) % numPlayers; // dealer sits to the leader's right

  return {
    phase: 'playing',
    numPlayers,
    decks,
    tricksPerHand,
    dealer,
    hands,
    trump: null,
    trumpLocked: false,   // once the establishing trick ends, the trump can't change
    leader,
    turn: leader,
    leadSuit: null,
    currentTrick: [],     // [{ seat, card }]
    trickNumber: 0,       // completed tricks
    tricksWon: [0, 0],    // by team
    // mendis captured per team, stored as suit letters: { 0: ['H'], 1: [] }
    mendis: { 0: [], 1: [] },
    history: [],          // completed tricks for review
    lastTrick: null,      // {plays, winner} of the previous trick (for UI)
    result: null,
  };
}

// Nice display ordering: group by suit, high rank first within suit.
function sortCards(a, b) {
  if (a.suit !== b.suit) return SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
  return b.value - a.value;
}

// Which cards may `seat` legally play right now?
function legalMoves(state, seat) {
  if (state.phase !== 'playing' || state.turn !== seat) return [];
  const hand = state.hands[seat];
  if (state.currentTrick.length === 0) return hand.slice(); // leader: anything
  const inSuit = hand.filter((c) => c.suit === state.leadSuit);
  return inSuit.length > 0 ? inSuit : hand.slice();
}

// Determine the winning seat of a completed trick.
function trickWinner(trick, leadSuit, trump) {
  let best = trick[0];
  for (let i = 1; i < trick.length; i++) {
    if (beats(trick[i].card, best.card, leadSuit, trump)) best = trick[i];
  }
  return best.seat;
}

// Does card `x` (played later) beat the current best `y` (played earlier)?
// Ties (equal value, same suit) go to `x`: in the two-deck game that means the
// second copy of an identical card wins — the "second duplicate takes it" rule.
// In single-deck modes two cards of one suit never share a value, so `>=` behaves
// exactly like `>` there.
function beats(x, y, leadSuit, trump) {
  const xT = trump && x.suit === trump;
  const yT = trump && y.suit === trump;
  if (xT && !yT) return true;
  if (!xT && yT) return false;
  if (xT && yT) return x.value >= y.value;
  // neither is trump: only lead-suit cards can win
  const xL = x.suit === leadSuit;
  const yL = y.suit === leadSuit;
  if (xL && !yL) return true;
  if (!xL && yL) return false;
  if (xL && yL) return x.value >= y.value;
  return false; // both off-suit junk: keeps the earlier one
}

// Play a card. Returns { ok, error?, events? }. Mutates `state` in place when ok.
function playCard(state, seat, id) {
  if (state.phase !== 'playing') return { ok: false, error: 'Game is not in progress.' };
  if (state.turn !== seat) return { ok: false, error: 'Not your turn.' };

  const hand = state.hands[seat];
  // Match on uid (unique per physical card) so the two-deck game removes the exact
  // card the player tapped; fall back to logical id for single-deck callers.
  const idx = hand.findIndex((c) => c.uid === id || c.id === id);
  if (idx === -1) return { ok: false, error: 'You do not have that card.' };

  const picked = hand[idx];
  const legal = legalMoves(state, seat);
  if (!legal.some((c) => c.uid === picked.uid)) {
    return { ok: false, error: `You must follow the lead suit (${state.leadSuit}).` };
  }

  const card = hand.splice(idx, 1)[0];
  const events = {};
  const N = state.numPlayers;

  // Leader sets the lead suit.
  if (state.currentTrick.length === 0) {
    state.leadSuit = card.suit;
    state.leader = seat;
  } else if (!state.trumpLocked && card.suit !== state.leadSuit) {
    // Until the trump locks, each off-suit discard (re)sets it — so the LAST void
    // player in the establishing trick decides the final trump.
    state.trump = card.suit;
    events.trumpSet = card.suit;
  }

  state.currentTrick.push({ seat, card });

  if (state.currentTrick.length < N) {
    state.turn = nextSeat(seat, N);
    return { ok: true, events };
  }

  // Trick complete — resolve it.
  const winner = trickWinner(state.currentTrick, state.leadSuit, state.trump);
  const winTeam = teamOf(winner);
  state.tricksWon[winTeam] += 1;

  const capturedMendis = [];
  for (const p of state.currentTrick) {
    if (isMendi(p.card)) {
      state.mendis[winTeam].push(p.card.suit);
      capturedMendis.push(p.card.suit);
    }
  }

  state.lastTrick = { plays: state.currentTrick.slice(), winner, capturedMendis };
  state.history.push(state.lastTrick);
  state.trickNumber += 1;

  events.trickWon = { winner, winTeam, capturedMendis };

  // The trump locks at the end of the trick in which it was first established;
  // from here on, void players can no longer change it.
  if (state.trump !== null) state.trumpLocked = true;

  state.currentTrick = [];
  state.leadSuit = null;
  state.turn = winner;
  state.leader = winner;

  if (state.trickNumber === state.tricksPerHand) finishGame(state, events);

  return { ok: true, events };
}

// Apply the scoring rules. Mendis are the tens: four in a single deck, eight in
// the two-deck (8-player) game. Whoever holds ALL of them takes the cot; a strict
// majority wins the deal; an even split is decided by tricks (a true tie draws).
function finishGame(state, events = {}) {
  state.phase = 'finished';
  const m0 = state.mendis[0].length;
  const m1 = state.mendis[1].length;
  const t0 = state.tricksWon[0];
  const t1 = state.tricksWon[1];

  const totalMendis = 4; // one ten per suit in every mode now (two-deck keeps a single 10)
  const half = totalMendis / 2;

  let winningTeam, cot, reason, draw = false;

  if (m0 === totalMendis) { winningTeam = 0; cot = true; reason = `won all ${totalMendis} mendis`; }
  else if (m1 === totalMendis) { winningTeam = 1; cot = true; reason = `won all ${totalMendis} mendis`; }
  else if (m0 > half) { winningTeam = 0; cot = false; reason = `took ${m0} of ${totalMendis} mendis`; }
  else if (m1 > half) { winningTeam = 1; cot = false; reason = `took ${m1} of ${totalMendis} mendis`; }
  else {
    // Even split on mendis (2–2, or 4–4 with two decks): more tricks wins. With an
    // even trick count (6-player has 8) an equal split is possible — a genuine draw.
    cot = false;
    if (t0 > t1) { winningTeam = 0; reason = 'tied on mendis but won more tricks'; }
    else if (t1 > t0) { winningTeam = 1; reason = 'tied on mendis but won more tricks'; }
    else { winningTeam = null; draw = true; reason = 'tied on both mendis and tricks'; }
  }

  state.result = {
    winningTeam,
    draw,
    cot,
    reason,
    totalMendis,
    mendis: { 0: state.mendis[0].slice(), 1: state.mendis[1].slice() },
    tricks: [t0, t1],
  };
  events.gameOver = state.result;
}

module.exports = {
  SUITS, RANKS, teamOf, nextSeat, cardId, isMendi,
  decksFor, makeDeck, shuffle, createGame, sortCards,
  legalMoves, trickWinner, beats, playCard, finishGame,
};
