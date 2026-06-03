// bot.js — a smart heuristic Mendicot player. It plays legally, follows suit,
// hunts mendis (the tens), and crucially reads the table before committing a card:
//
//  • If our side is already winning the trick, it conserves — dumps its lowest junk
//    and saves high cards for later (e.g. partner led the Ace, so it sheds the 7 and
//    keeps the King). It hands a ten to a partner who is safely winning.
//  • If an opponent is winning, it tries to take the trick as cheaply as possible —
//    especially when a ten is on the table — and otherwise ducks instead of wasting
//    a high card it can't cash.
//  • When void in the lead suit it decides whether to ruff (or over-ruff) or simply
//    discard, and if no trump is set yet it sets one in its longest suit, keeping the
//    ten of that suit back.
//  • In the two-deck (8-player) game it will happily beat an opponent's Ace with the
//    matching second Ace — `beats` already treats the later duplicate as the winner.
//
// It is not a perfect player, but it times its cards sensibly.
const { legalMoves, beats, teamOf, isMendi } = require('./game');

const byValue = (arr) => arr.slice().sort((a, b) => a.value - b.value);
const lowest = (arr) => (arr.length ? byValue(arr)[0] : undefined);
const highest = (arr) => (arr.length ? byValue(arr)[arr.length - 1] : undefined);
const non10 = (arr) => arr.filter((c) => !isMendi(c));

function currentWinner(state) {
  const t = state.currentTrick;
  if (t.length === 0) return null;
  let best = t[0];
  for (let i = 1; i < t.length; i++) {
    if (beats(t[i].card, best.card, state.leadSuit, state.trump)) best = t[i];
  }
  return best;
}

function chooseCard(state, seat) {
  const legal = legalMoves(state, seat);
  if (legal.length <= 1) return legal[0];
  const trump = state.trump;
  const N = state.numPlayers;
  // Am I the last seat to act in this trick? If so, what I see is final.
  const isLast = state.currentTrick.length === N - 1;

  // --- Leading -------------------------------------------------------------
  if (state.currentTrick.length === 0) {
    // Lead an Ace (off-trump) to pull out the suit and fish for a ten; otherwise
    // probe with a low non-trump card rather than bleeding strength.
    const aces = legal.filter((c) => c.value === 14 && c.suit !== trump);
    if (aces.length) return aces[0];
    const nonTrump = legal.filter((c) => c.suit !== trump);
    return lowest(nonTrump.length ? nonTrump : legal);
  }

  // --- Following -----------------------------------------------------------
  const winner = currentWinner(state);
  const partnerWinning = teamOf(winner.seat) === teamOf(seat);
  const bestCard = winner.card;
  const mendiOnTable = state.currentTrick.some((p) => isMendi(p.card));
  const canFollow = state.hands[seat].some((c) => c.suit === state.leadSuit);
  // Our side is "safely" ahead when nobody can act after me, or the lead is held by
  // an Ace (the top card of its suit — barring a ruff we can't foresee).
  const partnerSecure = partnerWinning && (isLast || bestCard.value === 14);

  if (canFollow) {
    // Every legal card here is a lead-suit card.
    const winners = legal.filter((c) => beats(c, bestCard, state.leadSuit, trump));

    if (partnerWinning) {
      // Hand the ten to a partner who is safely winning; else conserve — shed the
      // lowest non-ten and keep the high cards (this is the "keep the King" case).
      if (partnerSecure) {
        const ourMendi = legal.find((c) => isMendi(c));
        if (ourMendi) return ourMendi;
      }
      return lowest(non10(legal).length ? non10(legal) : legal);
    }

    // An opponent is winning.
    if (winners.length) {
      if (mendiOnTable || isLast) {
        // A ten is at stake, or this is our last chance — grab it as cheaply as we
        // can, preferring not to spend one of our own tens to do it.
        const cheap = non10(winners);
        return lowest(cheap.length ? cheap : winners);
      }
      // Mid-trick with nothing big at stake: only take it if it's cheap, else duck
      // and keep our high cards for a trick that matters.
      const cheap = lowest(non10(winners));
      if (cheap && cheap.value <= 11) return cheap;
    }
    // Can't (or won't) win: throw the lowest non-ten; never feed a ten to opponents.
    return lowest(non10(legal).length ? non10(legal) : legal);
  }

  // --- Void in the lead suit: ruff, set trump, or discard ------------------
  if (partnerSecure) {
    // Partner has it locked — sluff our lowest junk, never a ten or a high card.
    return lowest(non10(legal).length ? non10(legal) : legal);
  }

  if (trump) {
    const myTrumps = legal.filter((c) => c.suit === trump);
    const winningTrumps = myTrumps.filter((c) => beats(c, bestCard, state.leadSuit, trump));
    // Ruff in (or over-ruff) when a ten is on the table or an opponent leads — use
    // the cheapest trump that still wins, and avoid burning a trump ten if we can.
    if (winningTrumps.length && (mendiOnTable || !partnerWinning)) {
      const cheap = non10(winningTrumps);
      return lowest(cheap.length ? cheap : winningTrumps);
    }
    // Not worth trumping: discard the lowest off-suit non-ten.
    const offJunk = non10(legal.filter((c) => c.suit !== trump));
    if (offJunk.length) return lowest(offJunk);
    return lowest(non10(legal).length ? non10(legal) : legal);
  }

  // No trump set yet, and we're void: an off-suit card now SETS the trump and
  // (absent any other trump) wins the trick. Worth doing when a ten is at stake or
  // an opponent leads — set it in our longest suit for future control, keeping that
  // suit's ten back.
  if (mendiOnTable || !partnerWinning) {
    const bySuit = {};
    for (const c of legal) (bySuit[c.suit] ||= []).push(c);
    let bestSuit = null, bestScore = -1;
    for (const s of Object.keys(bySuit)) {
      const cards = bySuit[s];
      const score = cards.length + (cards.some(isMendi) ? 0.5 : 0); // long suit, bonus if we hold its ten
      if (score > bestScore) { bestScore = score; bestSuit = s; }
    }
    const cards = bySuit[bestSuit];
    const keep = non10(cards);
    return lowest(keep.length ? keep : cards);
  }

  // Partner leads but isn't locked, nothing big at stake: conserve.
  return lowest(non10(legal).length ? non10(legal) : legal);
}

module.exports = { chooseCard };
