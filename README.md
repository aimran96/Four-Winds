# Four Winds

A crash game where a migrating bird flies south and **the season sets the risk**. Built for ThunderHacks II (Main Track "Version 2.0", CBN crash-game track, Game Jam "Four Seasons").

Virtual credits only. No real money.

## The "Version 2.0" idea

**Broken:** classic crash games hide their risk. Every round looks the same, the player cannot see what they are signing up for, and "provably fair" is a hash nobody checks.

**Next version:** the world shows the risk, and the player can check the fairness themselves.

| Season | Risk | Instant-crash chance | Max multiplier | Hazards (cosmetic) |
|--------|------|----------------------|----------------|--------------------|
| Spring | Low | 0% | 10x | lightning, rain, kite |
| Summer | Medium | 10% | 50x | hawk, heat, drone |
| Autumn | High | 20% | 200x | gusts, leaf storm, flock |
| Winter | Extreme | 35% | 1000x | frost, whiteout, icicles, gusts |

Seasons change automatically, each lasting a random 4-9 seconds (`seasonMs` in `game.json`), and the next season is random. There is no countdown on screen, and a flight always finishes in the season it started in. Winter is the highest risk (35% of flights go down instantly) and the highest reward (up to 1000x). Overall return stays about the same in every season: the survivors' payouts are lifted to pay for the extra busts.

## CBN MVP checklist

- Bet and Cash Out controls
- Balance, wager and live multiplier display
- Balance tracking (integer cents, server side)
- Random crash point per round, with the outcome shown

## How it works

- **Server-authoritative.** The server owns the balance, the clock and the crash point. The client only draws.
- **Crash point:** `HMAC-SHA256(serverSeed, roundId)` gives a uniform `u`; if `u` is below the season's bust chance the flight crashes at 1.00x, otherwise the remaining range is rescaled and `crash = (1 - edge) / (1 - bust) / (1 - u')`, floored to 2 decimals. If it reaches the season maximum the bird **lands** and cashes out automatically at the max. Expected return is about `1 - edge` (3% edge, about 97% RTP) for any cash-out target.
- **Randomness is real.** The bird crashes when the server says so. Hazards and decoy near-misses are drawn on the client for atmosphere only and never decide the outcome.
- **Provably fair.** Before each flight the client gets `SHA-256(seed)`. After settlement the seed is revealed, and the "Verify round" button recomputes the commitment and crash point in the browser (needs `localhost` or HTTPS for Web Crypto).
- **Safe retries.** Bet and cash-out use idempotency keys, so a double click never double-charges.
- **Live stream.** Server-Sent Events send `tick` (multiplier only), `settled` and `state`. The crash point is never sent before settlement.
- **Responsible-play nudges.** Reality check every 10 rounds, loss-streak notice, and a notice when the wager more than doubles after a loss.
- **Accessibility and i18n.** English and French, reduced-motion toggle, keyboard (Space), risk shown by icon and text (not colour alone), live-region status, sound toggle.

## Visuals

A realistic 3D scene (three.js, vendored in `client/vendor/`, no install step): physically based sky, sun-lit terrain, lake, trees, fog, weather per season and an animated stork. The bird dies in a way that matches the cause: a lightning bolt and scorch, a hawk, drone, kite, flock or icicle strike, freezing solid, heat or rain sinking it, a whiteout or gust. It then tumbles or sinks to the ground or lake with feathers, splash or dust. If WebGL is unavailable it falls back to the 2D painted scene automatically (add `?2d` to the URL to force it).

Credits: three.js (MIT). Stork model from the three.js examples (`examples/models/gltf/Stork.glb`, by mirada).

Round states: `FLYING` -> `CASHED` | `CRASHED` | `LANDED`.

## Player protection and fraud monitoring

Each session keeps a behaviour profile (`server/engine/risk.js`): bets, wagers, timing, results and a **loss budget**, which is the most the player has said they can afford to lose (default 500 of the 1000 starting credits).

For the player (shown in the "Play safe" panel):
- A hard net-loss limit. A wager larger than what is left of the budget is refused (`limit_reached`). Lowering the limit always works; raising it is refused once the budget is used up or risk is high (`limit_locked`).
- Risk level (low / take care / high) with plain reasons: close to the limit, raising bets after losses, very fast play, long session, large wagers.
- A 30-second cool-off when risk reaches high (at most once every 2 minutes), on top of the existing reality checks.

For investigators (`/monitor.html`, API `GET /api/monitor`):
- Sessions ranked by concern, with player-risk and fraud scores and the evidence for each flag, plus an alert log.
- Fraud signals: bet spacing too regular for a human, repeated cash-outs within 250 ms of take-off, 15 identical bets in a row, more than 12 bets a minute, several live sessions from one client.
- Fraud flags never block a player and are never shown to them: a person decides. Only the player-protection rules act automatically.
- Access needs the `MONITOR_TOKEN` environment variable (sent as `x-monitor-token`). With no token set, only requests from the server machine itself are allowed.

### The Sentinel agent (real-time win-rate analysis)

`server/agent/sentinel.js` runs inside the server and reads every settled round as it happens. It asks one question: does this player win more often than the odds allow? Crash points come from a hidden seed, so no strategy beats the house on average, and a significant excess points to leaked information, an exploit or collusion.

- **Win test:** for rounds with a fixed auto cash-out, it compares wins with the exact win probability of each target (`0.97 / (target + 0.01)`, capped by the season's bust chance) and computes a z-score. A high win rate at a low target is normal (about 80% at 1.2x); the same rate at 2x is not.
- **Return test:** mean payout per credit wagered against the fair return of 97%.
- **Levels:** `watch` at z of 3, `review` at z of 4, with at least 100 rounds (`sentinel` in `game.json`). Each raise adds an alert with a plain-language explanation, e.g. "Won 70 of 100 fixed-target rounds; the odds predict 48.5 ± 5.0 (z = 4.3, chance by luck about 1e-5)".
- **Action:** alert only by default. Set `"onReview": "coolOff"` to also pause betting for 30 seconds.
- **Checked by simulation** against the real crash formula: 0 of 2000 honest players reached review in 300 rounds; a player with an extra 10% chance of winning was caught in about 20% of cases (median round 147), and with an extra 25% in about 60% (median round 103). Subtle cheating needs more rounds, and the agent only sees untouched auto cash-out rounds, so manual cash-outs are covered by the return test only.

### Accounts, login info and location

- **Accounts:** `POST /api/register` and `/api/login` (username 3-24 characters, password 8+). Passwords are salted with scrypt and never logged. Five wrong passwords lock an account for 15 minutes. Set `"auth": { "required": true }` in `game.json` to force sign-in; by default guests can still play. Accounts live in memory, so they reset when the server restarts.
- **Login info for monitors:** `/monitor.html` shows an account column and a login log (time, username, registered / login / bad_credentials / locked, client hash). Two clients live on one account raise a `sharedAccount` flag.
- **Location (opt-in only):** the player presses "Share my location" and the browser asks permission. The game sends a position every 15 seconds at most, and the server keeps it rounded to about 1 km, last 20 points only. A jump of more than 50 km at over 900 km/h raises an `impossibleTravel` alert. "Stop sharing and erase" deletes everything kept. Nothing is read before the player agrees.
- **Not covered:** no IP-to-country lookup, so a VPN is not detected, and a spoofed GPS position looks real. Combine with a GeoIP service before relying on location for licensing.

### "Sentinel live" drawer (for judges)

The tab on the right edge of the game opens a live view of what the agent is doing for this session: a status pill (Clear / Watching / Review), an evidence meter (z-score with the watch and review marks), running stats, and a feed that explains every settled round in plain words ("target 2x had a 48.5% chance and was reached; 3 wins vs 3.4 expected"). It also shows protection actions as they happen: flags, refused bets, cool-offs and location checks.

Honest play rarely trips the agent, so **Run cheater simulation** replays a synthetic player who always cashes out at 2x but secretly knows the outcome 40% of the time. The meter climbs live and the agent reaches REVIEW after about 100 rounds in roughly 8 seconds. Simulated lines are tagged SIM, and the simulation never touches the real player's balance or profile.

The feed is the player's own session only (no other players' data), and `"demo": { "agentView": false }` in `game.json` turns the tab and its endpoints off. Turn it off in production: showing fraud reasoning to players would help cheaters. Feed text is English only.

Privacy: profiles live in memory per session. The only personal data is the account name and, if the player opts in, a position rounded to about 1 km; the client id is a truncated hash of the IP address. The monitor shows only the first 8 characters of a session id, because the full id works like a password.

Limits: thresholds are rules of thumb, not tuned on real data. Behind a proxy the IP-based signal needs the real client address. There are no real deposits here, so the starting balance stands in for "what the player could feasibly spend".

## Run it

Needs Node 20+. No dependencies, no build step.

```bash
npm start        # http://localhost:3000  (set PORT to change)
npm test         # 21 tests: engine, wallet, API, idempotency, stream
npm run sim      # RTP simulation per season (200k rounds each)
```

## Layout

```
server/
  app.js            HTTP API, SSE stream, sessions
  config/           game.json, seasons.json (all tuning lives here)
  engine/           rng, round state machine, wallet, season rotation
client/             vanilla JS + canvas (scene/, ui/, i18n/)
tests/              node --test
tools/rtp-sim.js    RTP / volatility simulator
```

API: `GET /api/config`, `POST /api/session`, `GET /api/state`, `POST /api/bet`, `POST /api/cashout`, `GET /api/history`, `GET /api/verify/:roundId`, `GET /api/stream`.

## Known limits

- Sessions are in memory; a server restart resets everyone.
- No rate limiting or authentication (prototype).
- "Hold to max" RTP in the simulator is noisy for the high seasons because wins are rare and huge.
- Ghost birds are simulated cash-outs for atmosphere, not real players.
