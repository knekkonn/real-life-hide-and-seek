# Gameplay balance

The shared rules in `js/skills.js` are used by the client, Worker and training mode. Settings cover 50–2000 m fields and 5–30 minute rounds. Prices scale with field size, round duration and ability strength; relocation prices also reflect target count. Catch distance stays capped at 8 m; ordinary task arrival distance stays at 10 m.

## Tasks

| Task | Reward | Requirement |
| --- | --- | --- |
| Tresorcode | 25 credits | Three guesses within 150 seconds |
| Destination | 30 credits | Automatically verified within 10 m |
| Hold position | 20 credits | 60 seconds within 10 m |
| Hiding photo | 45 credits | Upload, then 180 verified seconds within 10 m |
| Mutprobe | 1 score point/second, up to 60 | One attempt per round, within 15 m of an active, unfrozen Seeker |
| Seeker cache scan | 25 credits | Verified within 10 m |
| Seeker proximity | 30 credits | Verified within 10 m of a Hider |

Mutprobe is absent from shops, random skill rewards and inventories. Its attempt is consumed only after a valid start. Leaving range or losing fresh GPS ends the attempt; points already earned remain. Both players must supply fresh evidence. Repeated samples and simultaneous requests do not multiply rewards. A new round restores the attempt.

Photo upload alone gives no reward. Proven movement outside the hiding area or explicit cancellation deducts 15 score points once and applies the normal two-minute failure cooldown. Scores may become negative. Inaccurate or missing GPS resets the hold without a score penalty; measurement uncertainty alone cannot prove a violation. The server completes a successful hold automatically. Photos remain available only to Seekers in the current round and are removed at round end. Uploading another photo cannot reset the hold.

## Tactical abilities

At 500 m / 20 minutes: random relocation costs 25 points, selected relocation 40, all Hiders 65 plus 15 per additional target. This ordering holds for every supported setting, including one remaining Hider. Movement distance and deadline scale with the field.

Restricted zones default to 30% of the field radius, adjustable from 10% (at least 10 m) to 45%. The default costs 90 points at 500 m / 20 minutes, with size and settings affecting the quote. Each Seeker can place one zone, with three total per round. Zones last until the match ends, including when time trading shortens the match. Existing occupants get 45 seconds to leave. New zones require at least that much round time remaining.

Tracker base duration is 25 seconds. Skill durations scale with field size and round time, with bounded scaling. Sweep and decoy ranges remain inside even the smallest fields. A Frostimpuls grants its target 20 seconds of immunity after the freeze ends to prevent chained freezes. Catch rewards scale with round settings and remaining targets; Hider survival still grants exactly one score point per full minute.

## Validation

`npm test` covers authoritative rewards, duplicate GPS, expired evidence, photo hold and penalty, privacy, permanent zones, time trades, freeze immunity, price ordering across settings, role rules and the local task sandbox. Real-world GPS accuracy and outdoor play balance still require device playtesting.
