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
