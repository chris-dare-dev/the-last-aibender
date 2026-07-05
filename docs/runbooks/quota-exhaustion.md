# Runbook — quota exhaustion: 5-hour and weekly limits

**Status:** live (the cockpit surfaces + operator moves below are real) ·
**re-provisioning / adding an account is owner-run**
**Sources of record:** blueprint §6.1 (quota row: statusline tee primary,
OAuth poll fallback) + §3 ([X1] fallback ladder),
[ws-protocol.md](../contracts/ws-protocol.md) §11 (the `quota` channel),
`packages/protocol/src/quota.ts` (the frozen `QuotaSnapshot` shape),
[hooks-telemetry.md](hooks-telemetry.md) (the statusline quota tee),
[login-bootstrap.md](login-bootstrap.md) (per-account isolation),
[recovery.md](recovery.md) (session resume — a limited session is not a crashed
session).

Subscription accounts (MAX_A, MAX_B, ENT) enforce **two rolling windows**:

- **5-hour window** (`5h`) — the short session-usage limit that throttles a
  burst of activity; it refills continuously and resets ~5 h after it filled.
- **weekly window** (`7d`, and a separate `7d_sonnet` sub-limit) — the longer
  budget; hitting this benches an account for up to a week.

This runbook is about what the cockpit shows when an account approaches or hits
these limits, and what the operator does. It does **not** try to raise a limit
(you cannot) — the harness's whole reason to exist is to spread work across
accounts so one exhausted account never stops you.

---

## 1. What the cockpit shows

The observability deck's quota instrument renders one gauge per
`(account, window)` from the `quota` channel (`QuotaSnapshot`: `account`,
`window` ∈ `5h|7d|7d_sonnet`, `usedPct` 0–100, `resetsAt` epoch-ms countdown,
`source` ∈ `statusline|oauth-poll`). It is a plain instrument, not an alarm —
DESIGN.md forbids the error-toast / red-banner reflex.

| What you see | What it means |
|---|---|
| Gauge climbing toward 100% on `5h` | The account is burning its short window; near 100% it will start refusing/slowing requests until `resetsAt`. |
| Gauge at/over 100% (clamped to 100) | Window exhausted. New requests on that account will be rejected until the countdown to `resetsAt` elapses. |
| `7d` (or `7d_sonnet`) gauge high | The weekly budget is the binding constraint — this benches the account far longer than a 5 h wait; treat it as "out for the week." |
| **NO SIGNAL** on a gauge (not an error) | The quota feed for that account is *stale* — the statusline tee hasn't updated (that account has been idle, so the CLI hasn't emitted a statusline). This is a freshness state, never a fabricated 0% or 100%. The OAuth-poll fallback (≤1 poll / 10–15 min) fills idle accounts; until it lands, the gauge honestly reads NO SIGNAL. |
| `source: oauth-poll` on the gauge | The number came from the idle-account fallback poll, not a live session's statusline — slightly staler, still authoritative. |

**A limit is NOT an error.** A session that hits its window is not crashed and
does not need recovery ([recovery.md](recovery.md)); it is throttled by
Anthropic and will resume when the window resets. The cockpit reflects that as
a full gauge + a countdown, not a fault.

### Reading the countdown

`resetsAt` is the authoritative reset instant from the feed. A value in the
**past** is legal and the gauge renders "reset due" — the window has refilled
and the next request should succeed. Do not act on a past-due reset as if the
account were still limited; send a request and let the fresh statusline update
the gauge.

---

## 2. Operator actions when an account hits a limit

The playbook is **route around it**, in this order:

### 2.1 Let the router shift new work (default; nothing to do)

The harness runs three subscription accounts precisely so a limited one is not
a stop. When you launch new sessions or pipeline steps, prefer an account whose
gauges are green:

- In the **launch composer**, pick a different account for the next session.
- In a **pipeline**, per-step account routing (M5) means a step pinned to a
  hot account can be re-pinned to a cooler one before the run; the run monitor
  shows each step's account and the per-step cost/quota context.

Sessions **already running** on the limited account are not killed — they pause
against the limit and continue when it resets. Do not force-restart them.

### 2.2 Wait out a 5-hour window (short benches)

For a `5h` exhaustion with no cooler account free: the countdown to `resetsAt`
is usually well under 5 h (windows refill continuously). Note the reset time
from the gauge, move to another account meanwhile, and the limited one rejoins
automatically when the statusline reports the window open again.

### 2.3 Bench an account for the week (weekly exhaustion)

A high `7d`/`7d_sonnet` gauge means the account is out for days, not hours.
Treat it as offline for planning: route all new work to the other two accounts,
and if throughput on two accounts is not enough, this is the signal to consider
the fallback ladder (§2.4). Do **not** try to "reset" the weekly window — there
is no operator lever for it.

### 2.4 Fallback ladder (blueprint §3) — when subscription capacity runs out

If subscription accounts are collectively saturated, the documented capacity
fallbacks, in rung order:

1. **AWS_DEV via Bedrock (OpenCode).** The AWS inference profile is metered
   per-request (real cost, not subscription quota). Its cost attribution IaC is
   owner-gated — see [bedrock-iac.md](bedrock-iac.md). Route overflow steps to
   AWS_DEV/OpenCode when subscription accounts are benched; the run monitor
   shows the real per-step cost so you see what you are spending.
2. **LOCAL via LM Studio.** Zero marginal cost, lower capability — good for the
   mechanical/high-volume steps (summaries, classification) so subscription
   quota is spent on reasoning, not volume. LM Studio being down is a
   first-class NO SIGNAL state ([hooks-telemetry.md](hooks-telemetry.md)); it
   never blocks the harness, it just isn't available as a fallback while down.
3. **A new subscription account** (adding a fourth) is owner-run provisioning,
   not a runtime lever — one interactive login per account, per-account config
   dir + Keychain isolation ([login-bootstrap.md](login-bootstrap.md)). Never
   share one credential store across accounts.

> The `ant` `user_oauth` profile path is **not** a subscription-quota fallback:
> spike-e (docs/spikes/spike-e-signing-ant.md) verified it is Console/API-billed,
> not Max-subscription-backed. It stays at the blueprint §3 "watch" rung.

---

## 3. Prevention — spend quota on reasoning, not volume

The supervision + routing features exist so you rarely reach a hard limit:

- **Offload volume to LOCAL/qwen.** Mechanical steps (summarize, classify,
  reformat, first-draft) belong on LM Studio; keep subscription quota for
  reasoning-critical work.
- **Watch the gauges before a big pipeline run.** The run monitor's per-step
  account view lets you rebalance a run off a hot account before you launch it,
  not after it half-fails.
- **The five gauges are cheap situational awareness.** A `5h` gauge trending
  past ~75% is the cue to start routing new sessions elsewhere, well before the
  hard stop.

---

## 4. What NOT to do

- **Do not re-login or re-provision an account to "reset" a limit** — the limit
  is server-side per subscription; a fresh login is the same account, same
  window, and needlessly burns the one-login-per-account discipline
  ([login-bootstrap.md](login-bootstrap.md)).
- **Do not kill a running session because its account is limited** — it is
  throttled, not broken; it resumes on reset. Killing it forfeits its context.
- **Do not treat NO SIGNAL as 0% "free" capacity** — a stale gauge is unknown
  usage, not zero usage. Prefer an account with a *fresh* green gauge.
- **Do not hand-edit the quota tee files** (`~/.aibender/quota/<LABEL>.json`) to
  make a gauge look better — the store dedupes on capture identity and the FE
  renders the honest number; a doctored file is either ignored or misleads you.
