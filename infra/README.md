# infra/ — server-side configuration & infrastructure (SI department)

Everything committable in here is **placeholders only** — MAX_A / MAX_B / ENT /
AWS_DEV_ACCOUNT_ID [X2]. Real values live machine-locally under `~/.aibender/`
or in the Keychain, never in the tree.

| Directory | Lane | Purpose (plan §2/§6) |
|---|---|---|
| `profiles/` | SI-B | Account profile manifests — labels and machine-local path *conventions* only, no real identity (SI-2). |
| `scripts/` | SI-B | Provisioning, keychain probes (never `-w`), version-gate, doctor, demo scripts (SI-2); currently also hosts SI-1's hygiene-gate scripts. |
| `launchd/` | SI-B | Aqua **gui-domain** LaunchAgent plist templates — broker (v1-ready, not flipped) and `lms` server; Background/user-domain forbidden (SI-3). |
| `hooks/` | SI-B | Per-account Claude hook settings templates: statusline quota tee, `type:"http"` event hooks, OTel env blocks, X4 brief-automation hooks (SI-3). |
| `aws/` | SI-C | Bedrock application-inference-profile + read-only telemetry IAM IaC. **`terraform apply` is HARD-GATED on the owner's explicit verbal OK** (SI-4). |
| `colima/` | SI-C | Colima/k3s demotion: right-size config, version pins, pod→host loopback probe, upgrade gate. Never a dependency of the harness core [X3] (SI-5). |
| `ci/` | SI-A | Live-check runner definitions (T3 milestone-gate suite) and CI helper config (SI-6). |

Standing rule: `core/` imports **nothing** from `infra/` — enforced by an
architectural test once BE code lands (plan §9.2, SI-5 row).
