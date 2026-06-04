# Mendicot Online (Dehla Pakad)

A real-time online version of **Mendicot** you can host yourself and play with
friends. Choose **4, 6, or 8 players**, create a table, share the 4-letter room
code, and play. Empty seats can be filled with smart bots, so you can play with
any number of friends (or solo against bots).

- Three table sizes: **4** (2 v 2), **6** (3 v 3), or **8** (4 v 4). Alternate seats are partners.
- 6-player tables can use a **single deck** or a **double deck** (your choice); 8-player always uses two decks.
- Authoritative Node server — the rules are enforced server-side, so nobody can cheat.
- Real-time over WebSockets (Socket.IO).
- Reconnect-friendly: refresh or lose signal and you rejoin your seat automatically.
- Built-in heuristic bots fill any empty seats.
- Works on phones and desktops.

## How the game works

Win the **10s** ("mendis"). Win **all** of them → you take the **cot** (the true win).
A **majority** of mendis wins the deal; an even split is decided by who took more tricks.
Alternate seats are partners — the players who don't sit next to you are your teammates.

**Choosing the trump.** The first trick in which a player can't follow the led suit
decides the trump. Each player in that trick who can't follow may play any suit, and
each one *overrides* the previous choice — so the **last** player who can't follow sets
the trump. Once that trick ends, the trump is **fixed for the rest of the deal**.

**Decks & sizes.**

| Table | Deck | Cards | Tricks | Tens (mendis) |
|---|---|---|---|---|
| 4 players | single | 52 | 13 | 4 (3+ wins, 4 = cot) |
| 6 players | single (2s removed) | 48 | 8 | 4 (3+ wins, 4 = cot) |
| 6 players | double (2–5 removed) | 72 | 12 | 8 (5+ wins, 8 = cot) |
| 8 players | double (full) | 104 | 13 | 8 (5+ wins, 8 = cot) |

In **double-deck** games every card exists twice, so if the same card is played
again the **second one wins** (e.g. an opponent's Ace of Clubs is beaten by the
other Ace of Clubs played after it). Full rules are on the in-app "How to play" panel.

---

## Run it locally (1 minute)

You need [Node.js](https://nodejs.org) 18+ installed.

```bash
npm install
npm start
```

Open http://localhost:3000 . To check the rules engine: `npm test`.

Everyone on the **same Wi-Fi/LAN** can join at `http://<your-computer-ip>:3000`.
To play with friends **anywhere**, either deploy it (below) or expose your local
server with a tunnel:

```bash
# one option, no install needed if you have a Cloudflare account:
npx cloudflared tunnel --url http://localhost:3000
# or:  ngrok http 3000
```

Share the public URL the tunnel prints, plus your room code.

---

## Deploy so friends can always reach it

Any host that supports Node **and WebSockets** works. Easiest free-ish options:

### Render.com (recommended, easiest)
1. Push this folder to a GitHub repo (or use Render's "deploy from local" / upload).
2. New → **Web Service** → pick the repo.
3. Runtime **Node**, Build command `npm install`, Start command `npm start`.
4. Deploy. Render gives you a `https://yourapp.onrender.com` URL — share it.

Render sets the `PORT` environment variable automatically; the server already reads it.

### Railway.app
New Project → Deploy from repo. It auto-detects Node and runs `npm start`. Done.

### Fly.io (uses the included Dockerfile)
```bash
fly launch        # accept defaults; it detects the Dockerfile
fly deploy
```

### Glitch / Replit
Import the repo. They run `npm install` and `npm start` automatically.

> Note: avoid hosts that don't support persistent WebSocket connections. Plain
> "static site" hosting (e.g. GitHub Pages, Netlify static) will **not** work —
> this needs the running Node server.

---

## How to play (in the app)

1. Enter your name → **Create a table**. You get a room code.
2. Send the code to friends; they open the same site and **Join** with it.
3. Fill any empty seats with **+ add bot**.
4. When all four seats are full, hit **Deal the cards**.
5. On your turn, tap a card (legal cards lift; illegal ones are dimmed) and **Play card**.
6. After the round, **Play again** keeps the same table and reshuffles.

---

## Project layout

| File | What it does |
|------|--------------|
| `game.js` | Pure rules engine: dealing, legal moves, trump setting, trick resolution, win/cot logic. |
| `bot.js` | Heuristic AI that fills empty seats. |
| `server.js` | Express + Socket.IO: rooms, seats, reconnection, drives bots, broadcasts state. |
| `public/` | The browser client (`index.html`, `style.css`, `client.js`). |
| `test.js` | 3,000 randomized full games + targeted rule checks. Run with `npm test`. |

Configurable: `PORT` (env var) and `BOT_DELAY_MS` at the top of `server.js`.
