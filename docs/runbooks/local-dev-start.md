# Runbook — local dev start: run the harness end-to-end on this machine

**Status:** live (Stage-3, DOC-1) · **Audience:** a new engineer / build agent
who wants to *see the cockpit render* and drive it against a broker, without
doing the owner-gated real logins first.

This is the single cold-start guide. `README.md` covers install + tests;
[HANDOFF.md](../HANDOFF.md) covers the project + the hard gates;
[login-bootstrap.md](login-bootstrap.md) covers the **real** owner-run logins.
None of those answer "how do I actually start a broker and the app locally and
watch it come up?" — this does.

> **[X2]** Everything here is placeholder-clean and synthetic-friendly. The
> dev loop below needs **no** real account, no keychain, no network, no cost —
> the real logins are a separate, owner-gated step ([login-bootstrap.md](login-bootstrap.md)),
> and the app renders its panels in their honest NO-SIGNAL state without them.

---

## 0. The topology in one breath (why the steps are what they are)

The app never talks to the broker over Tauri IPC. It discovers **one
multiplexed WebSocket** on `ws://127.0.0.1:<port>` by reading a
**bootstrap file** the broker writes at boot
([bootstrap-file.md](../contracts/bootstrap-file.md)):

```
aibender-core (broker)  ──writes──▶  $AIBENDER_HOME/bootstrap/gateway.json
                                     { port, token, pid, startedAt, claudeAccounts? }
        ▲                                            │
        │  ws://127.0.0.1:<port>  (token-authed)     │ read once at boot
        └──────────────  Tauri app / vite SPA  ◀─────┘
```

So a working local loop is: **(1) install → (2) boot a broker that writes the
bootstrap file → (3) start the app, which discovers it → (4) verify the WS
connects.** Steps 2 and 3 are independent processes; the file is the only
coupling.

`$AIBENDER_HOME` resolves to `$AIBENDER_HOME` if set, else `~/.aibender`
(`resolveAibenderHome`) — the same rule the whole machine-local layout uses.
For dev, point it at a throwaway dir so you never touch real state.

---

## 1. Install (once)

Requires **Node ≥ 22** and **pnpm 11** (`npm i -g pnpm` if absent).

```bash
cd ~/Personal/SourceCode/the-last-aibender
pnpm install
pnpm -r typecheck          # optional sanity: strict TS across the workspace
```

---

## 2. Start a broker

There is **no turnkey `pnpm -F aibender-core start` daemon in v0.** That entry
point (`core/src/main/index.ts` `main()`) deliberately prints one line and
exits 0 — wiring operator config so direct execution boots a broker against
`~/.aibender` under launchd is the **v1 slice** (SI-3; see
[launchd.md](launchd.md) and [release-packaging.md](release-packaging.md)).
Until then, a broker is composed programmatically via `composeBroker()`.

Pick the mode that fits what you want to see:

### 2a. Fastest render (NO broker): the dev bootstrap shim

If you only want to see the **chrome / layout / navigation** render (panels in
their NO-SIGNAL state), you do not need a broker at all. The vite SPA reads a
dev shim instead of a bootstrap file — jump to §3b and skip the broker. This is
the "fallback without logins" path in HANDOFF §9.1b.

### 2b. A real listening broker (synthetic, recommended): `demo:m1`

The authoritative, copy-pasteable example of a **full broker that binds a WS
port and writes the bootstrap file** is the M1 demo. It boots
`composeBroker()` (kernel → gateway) with three **synthetic** account profiles
in a **throwaway `$AIBENDER_HOME`**, substituting `@aibender/testkit`'s
`FakeQueryRunner` for the live SDK spawn path (which stays owner-gated —
[kernel-live-spawn.md](kernel-live-spawn.md)). It runs a scripted client, prints
`ok N - …` per assertion, retracts the bootstrap file on teardown, and exits:

```bash
pnpm -F aibender-core demo:m1
```

Use it as the pattern for a hand-rolled dev broker: `composeBroker({ … })` →
`startGateway({ … })` (binds `127.0.0.1:0`, OS-assigned port) →
`writeBootstrapFile(...)`. Both `core/scripts/demo-m1.ts` and the M2 soak
(`core/scripts/m2-soak/run.ts`, `pnpm -F aibender-core soak:m2`) show the exact
composition; the soak drives the *production composed path* end-to-end.

> To keep a broker **up** while you poke at the app (rather than
> run-and-exit), copy `demo-m1.ts`'s compose+`startGateway`+`writeBootstrapFile`
> prologue into a scratch script, point `AIBENDER_HOME` at a throwaway dir, and
> omit the teardown so the socket stays open. Keep the FakeQueryRunner
> substitution — the live spawn path is owner-gated.

### 2c. A live broker against real accounts (owner-gated — NOT this runbook)

Booting a broker against real `~/.aibender` accounts requires the one-time
logins in [login-bootstrap.md](login-bootstrap.md) (T3, owner-run) and, for the
daemon form, the launchd slice ([launchd.md](launchd.md)). That is the live
path; it is out of scope here and gated per HANDOFF §6.

---

## 3. Start the app

### 3a. The Tauri shell (native window)

```bash
pnpm -F aibender-app tauri dev
```

Boots **vite on :5173** *and* the Tauri v2 shell around it. The shell reads the
bootstrap file in Rust (`read_bootstrap`) from `$AIBENDER_HOME/bootstrap/gateway.json`
and hands it to the SPA. Point the shell at the same `AIBENDER_HOME` your §2b
broker used. Requires the Rust toolchain (cargo/rustc — see HANDOFF §10).

### 3b. The vite SPA in a browser (Chrome-as-frontend — no Rust, no Tauri)

```bash
pnpm -F aibender-app dev          # vite SPA on http://localhost:5173
```

A plain browser has no Rust `read_bootstrap`, so the SPA reads two dev-shim
globals instead ([bootstrap.ts](../../app/src/lib/native/tauriBridge.ts),
[main.tsx](../../app/src/main.tsx)):

- **`window.__AIBENDER_BOOTSTRAP__`** — the parsed bootstrap object (the broker
  discovery half). Set it to point the SPA at a running §2b broker:

  ```js
  // paste the gateway.json your broker wrote (or its port+token) into the console
  window.__AIBENDER_BOOTSTRAP__ = {
    port: 49731, token: "…the per-boot token…",
    pid: 12345, startedAt: new Date().toISOString(),
    claudeAccounts: ["MAX_A", "MAX_B", "ENT"]   // placeholder labels ONLY [X2]
  };
  // then reload — the WS client connects to ws://127.0.0.1:<port>
  ```

  Absent/unset ⇒ "no broker advertised" (the honest NO-SIGNAL state), never an
  error dialog (bootstrap-file.md §4).

- **`window.AIBENDER_CLAUDE_ACCOUNTS`** — a `string[]` of sanctioned placeholder
  labels used ONLY to seed the account picker / channel panels for a
  broker-less render (`configureAccountRegistry` fallback #2). Placeholder
  labels only (`MAX_<X>` / `ENT`), never a real email/name [X2]:

  ```js
  window.AIBENDER_CLAUDE_ACCOUNTS = ["MAX_A", "MAX_B", "MAX_C", "ENT"];
  ```

  When the bootstrap carrier is present its `claudeAccounts` wins; this shim is
  the fallback for a no-carrier browser render.

---

## 4. Verify it rendered and connected

1. **It renders:** the cockpit chrome (three zones, the fixed channel panels,
   the ⌘K palette, the approval inbox) is on screen. With no broker, panels sit
   in NO-SIGNAL — that is correct, not a failure.
2. **WS connected (with a §2b broker):** the connection indicator goes live;
   the account picker enumerates the accounts from `claudeAccounts` (or the
   shim). Confirm from the served page:
   - browser devtools ▸ Network ▸ WS shows one open socket to
     `ws://127.0.0.1:<port>`;
   - no repeated connect storm (a missing/dead broker is one quiet
     "no broker advertised", never a retry loop).
3. **Headless boot proof (no window, gates use this):**

   ```bash
   pnpm -F aibender-app smoke-test    # cargo run -- --smoke-test; always exits 0
   ```

   Reads `$AIBENDER_HOME/bootstrap/gateway.json` if present; absent/unreadable/
   malformed = "no broker advertised" and still exit 0 (bootstrap contract §4).

---

## 5. Common dev-mode failures

| Symptom | Cause | Fix |
|---|---|---|
| App renders but every panel is NO-SIGNAL | No broker, or the app's `AIBENDER_HOME` ≠ the broker's | Boot a §2b broker; point both at the same throwaway `AIBENDER_HOME`; in a browser set `window.__AIBENDER_BOOTSTRAP__` (§3b) |
| `pnpm -F aibender-core start` "does nothing" | Expected — the v0 `start` entry is a stub that prints one line and exits 0 (§2) | Use `demo:m1` / a scratch compose script for a listening broker |
| Browser SPA never connects even with a broker up | The browser can't read the bootstrap FILE (no Rust bridge) | Set `window.__AIBENDER_BOOTSTRAP__` to the broker's port+token in the console, then reload (§3b) |
| Picker shows the wrong / a hardcoded account set | No `claudeAccounts` carrier and no shim ⇒ the baked seed set | Set `window.AIBENDER_CLAUDE_ACCOUNTS` (browser) or let the §2b broker advertise `claudeAccounts` |
| `tauri dev` fails to build | Missing Rust toolchain | Install cargo/rustc (HANDOFF §10), or use the browser SPA (§3b) — no Rust needed |
| WS connects then drops on every broker restart | Correct behavior — a changed boot identity invalidates reconnect watermarks (bootstrap-file.md §2) | None; the client re-discovers and reconnects |
| Real account data expected but panels stay synthetic | You are on the synthetic dev loop; live data needs the owner-gated logins | Out of scope here — [login-bootstrap.md](login-bootstrap.md) (T3) |

---

## See also

- [bootstrap-file.md](../contracts/bootstrap-file.md) — the port/token/accounts
  discovery contract (the coupling between broker and app).
- [app/README.md](../../app/README.md) + [app/src-tauri/README.md](../../app/src-tauri/README.md)
  — the FE run modes in reference form.
- [login-bootstrap.md](login-bootstrap.md) — the owner-gated real logins (T3).
- [kernel-live-spawn.md](kernel-live-spawn.md) — why the live SDK spawn path is
  gated (the dev loop uses the FakeQueryRunner).
- [recovery.md](recovery.md) / [launchd.md](launchd.md) — v1 daemonization + ops.
