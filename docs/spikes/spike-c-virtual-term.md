# SPIKE-C — react-virtual end-anchored mid-stream resize (v) + Bun.Terminal parity (x)

- **Harness:** `spikes/virtual-term/` (quarantined; run `pnpm test` there)
- **Date:** 2026-07-04 · **Host:** macOS 26.x (Darwin 25.6.0), Apple Silicon, node v25.8.0, pnpm 11.9
- **Versions measured:** `@tanstack/react-virtual` 3.14.5 (virtual-core **3.17.3**), react 19.2.7,
  vite 8.1.3, Playwright 1.61.1 (chromium-1223, webkit-2311), node-pty 1.1.0,
  system bun 1.2.23, spike-local bun 1.3.14 (npm package)

---

## Spike (v) — TanStack react-virtual `anchorTo:'end'` under mid-stream resize

### Question

Plan §FE-3 requires the transcript island to be **stream-safe**: no autoscroll
jank mid-stream, anchor retained across a mid-stream viewport resize, anchor
released on user scroll-up (with zero drift while reading scrollback), and
"jump to live" restoring follow. Does react-virtual 3.14.5's end-anchored mode
(`anchorTo:'end'` + `followOnAppend`, virtual-core ≥ 3.16) deliver that
as-shipped — and if not, what does?

### Method

- React 19 harness app: `useVirtualizer` with `anchorTo:'end'`,
  `followOnAppend:'instant'`, dynamic `measureElement` row sizing; fed by a
  deterministic synthetic token stream (mulberry32-seeded; 55% grow-the-tail-line
  "extend-last", 35% new line, 10% five-line tool burst; every 30 ms) — the
  extend-last shape is exactly how a real token stream mutates a transcript.
- Playwright drives Chromium and WebKit headless. **WebKit here is a proxy for
  WKWebView** (same engine family, not the Tauri embed — see T3). Page served
  over loopback HTTP (ES modules are CORS-blocked over `file://`).
- Per-rAF instrumentation in-page: scrollTop / scrollHeight / clientHeight,
  bottom deviation, library `isAtEnd()`, per-phase max/median/jank-frame counts.
  "Settled deviation" is min/median over 16 frames (an instantaneous read can
  legitimately catch the moment between an append and the next pin).
- Two passes per browser: **raw** (library as-shipped, measurement-first) and
  **shim** (the FE-3 fallback design implemented in the harness, hard-asserted:
  anchored stream → four mid-stream resizes → wheel scroll-up release + drift
  check + resize-while-released → jump-to-live).
- Resize set (mid-stream, from 800×600): 800×400 shrink-h, 800×750 grow-h,
  500×750 narrow-w (full text rewrap → all visible items re-measure),
  1000×500 widen+shrink-h.
- Headless limitations: no real window-manager resize (Playwright viewport
  resize approximates it), no trackpad inertial scrolling (wheel events only),
  60 Hz-ish headless frame cadence.

### Result

**Raw library behavior (as-shipped) is NOT stream-safe.** Two distinct defects
measured, both reproduced in Chromium and WebKit:

1. **Spontaneous follow drop during plain streaming — no resize involved.**
   `followOnAppend` only re-engages if `isAtEnd()` (virtual distance ≤
   `scrollEndThreshold`, default **1 px**) at the moment of a count-append.
   A tail-item re-measure (extend-last wraps to a new visual line) can leave
   deviation past the threshold between appends; from then on follow is
   permanently dead and scrollTop freezes while content grows. Observed drops:
   Chromium at t=1750 ms (58 lines), WebKit at t=500 ms (24 lines); occurrence
   varies run-to-run (some runs survive the 2.5 s observation window) — i.e.
   it is a race you WILL hit in production, not a deterministic bug you can
   pattern around.
2. **No resize retention path exists.** virtual-core 3.17.3's rect observer
   just stores the new rect (`this.scrollRect = rect; maybeNotify()`); nothing
   re-anchors. From a freshly re-anchored state, post-resize settled deviation
   (min/median/max px, representative full run):

   | resize | chromium | webkit | retained? |
   |---|---|---|---|
   | 800×400 shrink-h | 244/426/556 | 225/288/452 | **no** (both) |
   | 800×750 grow-h | 0/15/216 | 15/59/405 | **no** (isAtEnd false; occasionally survives via browser clamp) |
   | 500×750 narrow-w rewrap | 412/476/579 | 619/683/709 | **no** (both) |
   | 1000×500 widen+shrink-h | 0/0/15 | 0/15/41 | shape-dependent, unreliable |

   Retention is shape- and run-dependent (browser scrollTop clamping sometimes
   masks the loss when content shrinks); it must be treated as absent.

**The working design (measured green): app-owned follow discipline
("follow-guard"), with the virtualizer used purely for windowing.**
While follow-intent holds, pin `scrollTop = scrollHeight - clientHeight` once
per rAF (idempotent DOM write); release ONLY on user intent (wheel-up; produc-
tion adds touch/PageUp/Home); re-engage on jump-to-live or after the user sits
at the live edge for ≥10 consecutive frames. Shim-pass numbers, both browsers:

- anchored streaming (2.5 s, 316/229 frames): max deviation **0.0 px**, jank
  frames (dev > 8 px) **0**;
- all four mid-stream resizes: follow retained, settled deviation
  **0/0/0 px** (min/median/max), zero jank frames;
- wheel scroll-up: released; **0.00 px drift** over 1.5 s of continued
  streaming; resize while released does NOT yank the reader;
- jump-to-live: re-anchors to 0/0/0 px and follow resumes.

**Dead-end designs measured out (do not resurrect them in FE-3):**

- *ResizeObserver + naive isAtEnd memory* — races frame ordering (rAF →
  layout → RO): the per-frame memory is clobbered with the post-resize
  `false` before the RO callback reads it.
- *Single `scrollToEnd()` on resize* — computes against the mid-resize
  internal rect, parks mid-list (trace: scrollTop pinned at the stale
  internal offset 376 while max-scroll was 1314), and follow never resumes.
- *Threshold-based follow with library `followOnAppend`* — extend-only tick
  runs can accumulate ~30 px/tick of tail growth between appends, so any
  threshold small enough to release on a gentle wheel notch is too small to
  survive streaming.
- *Library `isAtEnd()` as the "live" indicator* — under per-frame pinning the
  library's internal scrollOffset lags the DOM by a frame and `isAtEnd()`
  flickers (internal distance oscillated 0↔130 px while DOM deviation was 0).
  The UI's LIVE/jump-to-live indicator must be driven by the app's own
  follow-intent state.

### Confidence

**Medium-high** for the behavioral findings (deterministic stream, two
engines, library source read to confirm the mechanism: no rect re-anchor path;
`followOnAppend` gated on `isAtEnd(scrollEndThreshold=1)`). **Medium** for
WKWebView transfer: Playwright WebKit is the same engine family but not the
Tauri embed, and headless viewport resize approximates window resize.

### Verdict

**GO for react-virtual 3.14.5 in FE-3 — but only as the windowing engine, with
the follow discipline owned by the app** (per plan: fallback consequence for
spike v is a hand-rolled anchoring wrapper rather than a library swap; no
alternative virtualizer is warranted). Normative for FE-3:

1. Keep `anchorTo:'end'` (its item-growth compensation while at end is useful)
   but do NOT rely on `followOnAppend`/`isAtEnd()` for follow.
2. Implement the follow-guard exactly as measured: per-rAF bottom pin while
   follow-intent holds; release only on user input (wheel-up, touch, keys);
   re-engage via jump-to-live or sustained at-bottom (~10 frames — an instant
   re-engage races the releasing wheel scroll and un-releases it);
   drive the LIVE indicator from follow-intent, not `isAtEnd()`.
3. Runtime-detection safety: keep the raw-pass expectations as a canary test —
   if a future virtual-core release makes raw mode stream-safe, the guard can
   be thinned, and the test will say so.

### What remains for live-host (T3) confirmation

- Re-run the (v) suite inside the real Tauri WKWebView on macOS 26.x (window-
  manager resize, ProMotion cadence, trackpad inertial scroll for the release
  gesture).
- 10k-line memory-flatness soak (plan §9.2 FE-3 edge) — out of scope here.
- Reduced-motion audit of the pin write (it is behavior, not animation, but
  verify no smooth-scroll interaction).

---

## Spike (x) — Bun.Terminal parity check vs node-pty

### Question

Findings doc open question: is `Bun.Terminal` (bun ≥ 1.3.5, Dec 2025) stable
enough to replace node-pty for the daemon's attended-TUI surface, or does the
kernel stay on Node LTS + node-pty?

### Method

- `bun --version` on PATH (with the spike's `node_modules/.bin` stripped):
  **1.2.23** — predates `Bun.Terminal` (shipped 1.3.5). Per the brief this
  alone would end at "document from docs, mark T3", but the `bun` npm package
  ships real binaries, so **bun 1.3.14 was installed spike-locally** and the
  parity probe ran for real. No system toolchain was touched.
- Both harnesses drive the same synthetic TUI child (`tui-sim.cjs`: reports
  TTY-ness and size, reports SIGWINCH, echoes raw-mode stdin, emits ANSI
  noise; exits on `q`). The real claude TUI is never spawned (no real
  accounts, no quota burn) — an honest proxy for "spawn a TUI, resize, kill".
- Round-trip per implementation: spawn 80×24 → child sees TTY + size →
  `resize(120, 40)` → expect SIGWINCH-driven report → write `x` → expect echo
  → `kill()` → expect exit event. Bounded waits everywhere; the Bun probe is
  resize-tolerant so the rest of the matrix still gets measured.

### Result

| check | node-pty 1.1.0 (node 25.8) | Bun.Terminal (bun 1.3.14) |
|---|---|---|
| API present | yes | yes (`new Bun.Terminal({cols,rows,data})` + `Bun.spawn({terminal})`) |
| child sees a TTY | yes | yes |
| initial size honored | 80×24 | 80×24 |
| data flow (PTY → host) | `onData` | `data(term, chunk)` constructor callback |
| write/echo (host → PTY) | yes | yes |
| **resize propagation** | **yes** — SIGWINCH in **0.5–0.7 ms** | **NO** — `resize(120,40)` accepted but inert: no SIGWINCH AND polled `process.stdout.columns` stays 80×24 forever |
| kill → exit event | yes, 1.1–1.6 ms (`{exitCode:0, signal:1}`) | yes, 2.4–3.5 ms (`{exitCode:143, signal:"SIGTERM"}`) |
| spawn → first byte | 71–293 ms | 47–49 ms |
| API surface | full pty: `resize/write/kill/pause/resume/cols/rows/pid/ptsName/onData/onExit…` | `close/closed/resize/setRawMode/write/ref/unref` + termios flag accessors (`controlFlags/inputFlags/localFlags/outputFlags`); no pid/onExit on the terminal (subprocess carries those) |

Signature notes (probed, undocumented): `resize(cols, rows)` positional —
object forms throw `resize() requires valid cols argument`; the subprocess's
`.terminal` is the same object passed to `Bun.spawn`.

**Blocking gap: resize does not reach the child on bun 1.3.14.** An attended
TUI in a resizable xterm pane (fit-addon → BE-2 resize propagation, plan §BE-2
"resize propagates") cannot reflow. Everything else (spawn/TTY/data/write/
kill/exit) is at parity, and spawn latency is actually better.

**Bonus landmine (node-pty, affects BE-2 directly):** the darwin-arm64
prebuild of node-pty 1.1.0 ships `prebuilds/darwin-arm64/spawn-helper`
**without the executable bit** when installed via pnpm — every spawn fails
`posix_spawnp failed` until `chmod +x`. The kernel's install/postinstall step
must assert/repair the exec bit (the spike's `run-parity.ts` shows the fix).

### Confidence

**High** for the machine-local facts (probed on real binaries, deterministic
child, timings measured). **Medium** on "Bun.Terminal is broken in general":
1.3.14 was the probe target; the gap may be fixed in a later 1.3.x — the
verdict does not depend on that.

### Verdict

**Stay on Node LTS + node-pty for the daemon (GO for the plan's existing
choice; no fallback consequence triggered).** `Bun.Terminal` is disqualified
today by the inert resize alone — it is the one operation an attended-TUI
kernel cannot fake. Revisit only if a future need arises AND a re-run of
`bun-parity/` on a newer bun shows the resize round-trip green; the probe is
runnable as-is (`pnpm run test:parity`). BE-2 must add the spawn-helper
exec-bit repair to its install path regardless.

### What remains for live-host (T3) confirmation

- Re-run the node-pty leg against the **real pinned SDK-bundled `claude`
  binary** (real TUI init, bracketed paste, alt-screen) once SI-2 account
  dirs exist — the synthetic child does not exercise those byte streams.
- 6-PTY flow-control soak is spike (vi), not this spike.
- If bun is ever upgraded machine-wide past 1.3.14, re-run
  `pnpm run test:parity` before letting any tooling assume PTY support.
