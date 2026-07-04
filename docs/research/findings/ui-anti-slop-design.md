# UI/UX Research: Escaping the "AI Slop" Aesthetic

**Project:** the-last-aibender — local macOS harness / mission control for AI agents
**Stage:** 1 (discovery research — no code)
**Date:** 2026-07-03
**Status:** Findings — permanent research record

---

## TL;DR

1. The generic "AI app" look is now a documented, enumerable phenomenon ("AI slop") with a known cause: LLMs emit the statistical median of Tailwind/shadcn training data, seeded by Tailwind's old `bg-indigo-500` default.
2. This matters doubly here: **this harness will largely be built BY coding agents** — the exact systems that produce slop when unconstrained. The countermeasure the entire anti-slop literature converges on is a locked token file (DESIGN.md) with explicit negative constraints.
3. A complete DO-NOT marker list is below (colors, type, layout, components, icons, motion, copy). Purple→blue gradients, glassmorphism, Inter-everywhere, ✨ sparkles, bento grids, icon-card triplets, chat bubbles are all on it.
4. Three fleshed-out directions were developed: **A. Instrument Grade** (Braun/Rams × teenage engineering flight-deck), **B. Paper Terminal** (monospace-web × Swiss editorial), **C. Phosphor Ops** (CRT mission-control).
5. **Recommendation: Direction A as the base system**, borrowing B's character-grid discipline for data surfaces and C's single phosphor-amber accent. Dark-room instrument panel, mono-forward type, hairline rules instead of cards, mechanical sub-200 ms motion, zero gradients, zero glass.
6. Key benchmark lesson (Linear/Warp/Raycast): **speed and keyboard flow ARE the aesthetic**; visual style is downstream of latency discipline.
7. Public-repo constraint: paid fonts (Berkeley Mono) must NOT be committed — license-clean free fallbacks are specified.

---

## Current landscape

### 1. What "AI slop" is and why it happens

Between 2024 and 2026 the design community converged on a name for the default output of AI coding agents: "AI slop" — "the generic look every AI coding agent reaches for by default: purple→blue gradients, a gray 1px border on every card, Inter headlines, three feature cards in a row, dark mode you never asked for" ([vibecodekit.dev](https://vibecodekit.dev/ai-slop-design)).

The mechanism is well understood and worth internalizing because it predicts how our own build agents will misbehave:

- LLMs are statistical pattern matchers. "When you ask Claude or GPT-5 to 'build a landing page' without specific constraints, you're not getting design. You're getting the median of every Tailwind CSS tutorial" ([prg.sh](https://prg.sh/ramblings/Why-Your-AI-Keeps-Building-the-Same-Purple-Gradient-Website)).
- The purple specifically traces to Tailwind CSS choosing `bg-indigo-500` as its demo/default component color years ago; that choice saturated tutorials, scraped repos, and therefore training data ([prg.sh](https://prg.sh/ramblings/Why-Your-AI-Keeps-Building-the-Same-Purple-Gradient-Website)).
- shadcn/ui + Tailwind + Material-adjacent cards are the most common patterns on the scraped web, so "a thousand AI-built apps land on the same shadcn-gray cards and the same Tailwind-blue button" ([vibecodekit.dev](https://vibecodekit.dev/ai-slop-design)).
- The convergent remedy across every guide surveyed ([impeccable.style](https://impeccable.style/slop/), [vibecodekit](https://vibecodekit.dev/ai-slop-design), [techbytes](https://techbytes.app/posts/escape-ai-slop-frontend-design-guide/), [MindStudio](https://www.mindstudio.ai/blog/claude-design-avoid-ai-slop-design-system), [dev.to](https://dev.to/_46ea277e677b888e0cd13/why-every-ai-generated-landing-page-looks-the-same-and-how-to-fix-it-1kmo)): **specify the design system before generating anything** — lock tokens in a DESIGN.md, cap the palette, name the fonts, and maintain explicit negation lists ("no purple gradients," "no glassmorphism"). The model can execute; you have to direct.

### 2. The DO-NOT list (explicit slop markers)

Compiled primarily from [impeccable.style/slop](https://impeccable.style/slop/) (the most exhaustive catalogue found), [prg.sh](https://prg.sh/ramblings/Why-Your-AI-Keeps-Building-the-Same-Purple-Gradient-Website), [NN/g](https://www.nngroup.com/articles/ai-sparkles-icon-problem/), and trend-fatigue coverage. **Every item below is banned in this project's UI unless explicitly waived in the future design spec.**

**Color & surface**
- Purple/violet/indigo gradients, and purple→blue CTAs — "the most recognizable tells of AI-generated UIs."
- Cyan-on-dark neon; colored `box-shadow` glows as the default "cool" look.
- Dark navy hero backgrounds with radial purple "orbs" / blurred gradient blobs.
- Glassmorphism: frosted translucent cards, `backdrop-filter: blur()` as decoration.
- Warm cream/beige as the reflexive "tasteful" alternative surface (now itself a tell).
- Gradient text used decoratively.

**Cards & borders**
- Thick colored border on one side of a rounded card — "the single most recognizable tell of AI-generated UI."
- Hairline border + wide diffuse shadow on every card; cards inside cards; a gray 1 px border on everything.
- Rounded-corner inflation (12–24 px radii everywhere).

**Typography**
- Inter (or Roboto/Geist/Space Grotesk) as the headline face — "used on so many sites they no longer feel distinctive."
- Instrument Serif / italic-serif hero headlines — "the universal AI-startup landing page hero."
- Single font family for the whole page; weak size hierarchy; tiny uppercase letter-spaced kicker labels above every heading.

**Layout**
- Three same-sized icon+heading+text feature cards in a row; the icon-in-rounded-square container above a heading.
- Bento grids used reflexively — 67% of top SaaS homepages now use them, and identical-size bento cells are "a traditional grid with rounded corners" ([SaaSFrame](https://www.saasframe.io/blog/designing-bento-grids-that-actually-work-a-2026-practical-guide), [studiomeyer reality-check](https://studiomeyer.io/en/blog/webdesign-trends-2026-reality-check)).
- "Big number, small label, three supporting stats, gradient accent" metric blocks.
- Identical centered-hero chat-bubble layouts for anything AI-conversational.

**Iconography**
- The ✨ sparkles icon for anything AI. NN/g documents that it is now ambiguous, non-specific, and confusing in isolation; Google formalized it in 2023 and it has since been "co-opted by marketing" ([NN/g](https://www.nngroup.com/articles/ai-sparkles-icon-problem/), [Google Design](https://design.google/library/ai-sparkle-icon-research-pozos-schmidt), [CSS-Tricks](https://css-tricks.com/the-proliferation-and-problem-of-the-sparkles-icon/)).
- Magic wands, robots, brains, lightning bolts as AI signifiers.

**Motion**
- Bounce/elastic/spring-overshoot easing ("dated and tacky" per impeccable.style).
- Scale/rotate image on hover; scroll-triggered fade-up on every section.

**Copy** (matters for empty states, tooltips, marketing README)
- "Streamline, empower, supercharge, world-class, enterprise-grade"; em-dash-heavy cadence; manufactured-contrast aphorisms ("It's not X. It's Y.").

**Meta-rule:** the counter-trend is itself becoming a trend. "Deliberately broken layouts, raw HTML aesthetics, brutalist typography, monospace everything" is now the fashionable reaction ([studiomeyer](https://studiomeyer.io/en/blog/webdesign-trends-2026-reality-check)) — and sci-fi HUD kits (e.g. arwes.dev cyberpunk styling) are the emerging next cliché. Distinctiveness must come from a coherent system, not from adopting the anti-trend uniform.

### 3. Craft benchmarks — what praised tools actually do

- **Linear** — the most-cited craft benchmark. What earns the praise is not the purple accent (which spawned a thousand "Linear-clone" landing pages — LogRocket calls the diluted copy "linear design, boring and bettering UI") but: no loading states, keyboard-first flows that map to natural language (C creates, S sets status), dark mode as the carefully considered default, and restrained motion with feedback on every interaction ([LogRocket](https://blog.logrocket.com/ux-design/linear-design/), [Linear redesign notes](https://linear.app/now/how-we-redesigned-the-linear-ui), [Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/linear)). **Lesson: the flow state is the brand; copy the discipline, not the palette.**
- **Warp** — distinctiveness through a structural idea: every command+output is a discrete block that scrolls/copies/shares as a unit ([Warp design analysis](https://getdesign.md/warp/design-md)). **Lesson: one strong interaction primitive beats ten visual flourishes.** Our analogue: the session/workstream as a first-class visual block.
- **Raycast** — single-hotkey command palette, fuzzy search that learns, "noticeably faster than Spotlight" ([guptadeepak.com](https://guptadeepak.com/tools/top-5-developer-productivity-tools-2026/)). **Lesson: launch-anything-in-two-keystrokes is a UX identity in itself** — directly applicable to "launch a one-off prompt against MAX_A."
- **Zed** — GPU-rendered, Rust, performance-as-identity. **Lesson: perceived latency is a design token.**
- **Family (family.co)** — "simplicity, fluidity, delight"; praised for spending motion budget on a few meaningful moments (wallet creation ceremony) rather than everywhere: "mastering delight is mastering selective emphasis" ([benji.org/family-values](https://benji.org/family-values)). **Lesson: one or two ceremonial animations (e.g. session merge in the workstream tree), near-zero motion elsewhere.**
- **Perplexity** — early product used Berkeley Mono heavily ("brings joy to the brand experience" per the [usgraphics testimonials](https://usgraphics.com/products/berkeley-mono)); the 2023 Smith & Diction rebrand drew from "80s and 90s Apple ads that had plenty of grit and texture," later maturing into custom Grilli Type faces (Perplexity Sans/Mono) ([standards.site](https://live.standards.site/perplexity/type), [brandarchive](https://brandarchive.xyz/identity/perplexity)). **Lesson: mono-forward + texture reads as "research instrument," and it aged into a real brand.**
- **teenage engineering / Braun-Rams lineage** — TE's OP-1/TP-7 are the modern continuation of Rams' ten principles: functional beauty, honest materials, every control labeled, nothing decorative ([onlyonceshop](https://onlyonceshop.com/blog/from-braun-to-teenage-engineering), [Awwwards on Rams](https://www.awwwards.com/less-but-better-dieter-rams-s-influence-on-today-s-ui-design.html), [HN thread](https://news.ycombinator.com/item?id=40219598)). **Lesson: instrument-panel semantics — controls look like controls, readouts look like readouts, one accent color means "signal."**
- **NASA / mission control UX** — the actual research says high-stakes UI is about "trust, clarity, and human resilience," stripped displays (Apollo DSKY), consistent placement, and user-arrangeable dashboards (NextGen MCS) — *not* about sci-fi chrome ([Medium: UX lessons from NASA](https://medium.com/@blessingokpala/ux-lessons-from-nasa-designing-interfaces-for-high-stakes-environments-362b3a7b20b1), [topsoftwarecompanies.co](https://topsoftwarecompanies.co/web-design/how-nasa-uses-web-design-to-optimize-user-experience-in-space-control)). **Lesson: "mission control" means calm density and glanceable state, not Hollywood HUDs.**

### 4. Live typographic/texture counter-currents worth borrowing

- **The monospace web** — Oskar Wickström's exploration: character-sized grid, responsive "in character-sized steps," semantic HTML "rendered as if we were back in the 70s," ASCII diagrams and aligned tables as first-class layout ([owickstrom.github.io/the-monospace-web](https://owickstrom.github.io/the-monospace-web/)). Monospace has escaped the code block: "in 2026 it's being used for editorial layouts, magazine covers, indie product branding… to signal craft, precision, or analog computing nostalgia" ([madegooddesigns font trends](https://madegooddesigns.com/font-trends-2026/)).
- **Berkeley Mono (TX-02, U.S. Graphics Company)** — "the objectivity of machine-readable typefaces of the 70's while retaining humanist sans-serif qualities"; the most-coveted paid programming font ([usgraphics.com](https://usgraphics.com/products/berkeley-mono), [HN](https://news.ycombinator.com/item?id=38322793)). Free near-alternatives: Commit Mono, Martian Mono, Iosevka (incl. a Berkeley-mimicking config, [IoskeleyMono](https://github.com/ahatem/IoskeleyMono)), IBM Plex Mono ("underused" per the trend report — a plus).
- **Phosphor/CRT revival** — green `#00FF41` reads "1980s hacker"; amber `#FFB000` is "warmer and slightly less aggressive but still unmistakably terminal"; effects toolkit = scanlines, bloom, barrel distortion ([dev.to CRT build](https://dev.to/remojansen/building-a-retro-crt-terminal-website-with-webgl-and-github-copilot-claude-opus-35-3jfd), [cool-retro-term](https://github.com/Swordfish90/cool-retro-term), [terminal design system](https://uidesignprompts.com/prompts/terminal-design)). Terminal design systems "pick green or amber consistently and use it as the brand color for anything interactive."
- **Grain/noise/patina** — subtle CSS/SVG noise overlays are the 2025–26 reaction to "the sterile, too-perfect look associated with AI-generated graphics"; cheap to implement, adds warmth without skeuomorphism ([solmadestudio](https://www.solmadestudio.com/blog/exploring-textural-design-trends), [It's Nice That 2026 trends](https://www.itsnicethat.com/features/forward-thinking-graphic-trends-2026-graphic-design-120126)).
- **Swiss/editorial systems** — grid rigor, ratio-based type scales, whitespace as structure; "the same grid systems that organized magazines now structure responsive layouts" ([swissthemes](https://swissthemes.design/insights/swiss-design-for-web-designers), [pixeldarts](https://www.pixeldarts.com/en/post/swiss-style-web-design-a-comprehensive-guide)). GT Pressura and ink-bleed faces bring print physicality to screens ([Creative Boom 2026 fonts](https://www.creativeboom.com/resources/top-50-fonts-in-2026/)).
- **Motion identity as brand** — codify easing curves and durations in the design system exactly like color tokens; "a speed-driven startup embraces bold, rapid transitions"; motion guidelines cover UI transitions, loading states, and the few ceremonial moments ([wings.design](https://wings.design/insights/how-motion-design-shapes-brand-identity-in-a-digital-first-world), [octopusmarketing](https://www.octopusmarketing.agency/the-language-of-brand-motion-conveying-stories-through-movement/), [everything.design](https://www.everything.design/faq/motion-identity-brand-need)).

### 5. Competitive set (agent-orchestration UIs)

- **Conductor** (conductor.build, Melty Labs) — native macOS, parallel worktree agents, diff review panel, GitHub/Linear integration; "polished, clean, relatively straightforward" ([conductor.build](https://www.conductor.build/), [madewithlove review](https://madewithlove.com/blog/conductor-running-multiple-ai-coding-agents-in-parallel/)). Aesthetically it sits in tasteful-default territory — competent, not distinctive.
- **Crystal** — Electron parallel-session manager, deprecated Feb 2026 toward a closed successor ([agentsroom comparison](https://agentsroom.dev/blog/best-multi-agent-coding-tools)). Generic Electron-app styling.
- Open-source orchestrators surveyed by [Augment Code](https://www.augmentcode.com/tools/open-source-agent-orchestrators) are overwhelmingly CLI-first or default-shadcn web UIs.
- **Gap: nobody in this category owns a visual identity.** A harness that looks like a calibrated instrument rather than a SaaS dashboard has clear air.

### 6. Observability & graph surfaces (the two hardest screens)

- **Dashboard fatigue** is a known failure mode: metric overload, redundant panels, alert floods. Best practice: RED-style framing, most-important KPI where the eye lands first, semantic color only (state, not decoration), normalized axes to cut cognitive load ([Grafana best practices](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/best-practices/), [groundcover](https://www.groundcover.com/learn/observability/grafana-dashboards), [skedler](https://www.skedler.com/blog/10-must-have-grafana-dashboards-kubernetes-prometheus/)).
- **Force-directed graphs**: Obsidian's canvas/WebGL graph is the reference users know; node size ∝ inbound references; theming bridged from CSS variables into WebGL. Known failure: "the hairball" past ~200 nodes, where physics collapses clusters into noise — and a well-known critique says the graph is "beautiful and almost completely useless" without filtering/grouping ([Obsidian help](https://obsidian.md/help/plugins/graph), [customization guide](https://publish.obsidian.md/hub/04+-+Guides,+Workflows,+&+Courses/Guides/Graph+view+customization), [codeculture critique](https://codeculture.store/blogs/developer-culture/obsidian-graph-view-useful), [forum physics thread](https://forum.obsidian.md/t/graph-view-physics-and-force-directed-graphs/72586)). A 3D Three.js "galaxy" renderer exists as prior art ([darcynorman.net](https://darcynorman.net/2026/04/10/experimental-obsidian-3d-graph-renderer/)) — visually spectacular, legibility-questionable.
- Design consequence: the graph needs filtering, clustering, and dimming-by-default from day one; the aesthetic must survive 500+ nodes. (Note: the owner is an active Obsidian user, so graph-view conventions are familiar vocabulary.)

### 7. Machine ground truth relevant to design

Verified read-only on this machine: Apple M4 Max, macOS 26.6, and a **three-display setup** — built-in Liquid Retina XDR (3456×2234), an ultrawide 3440×1440, and a QHD 2560×1440. Design consequences: (a) an ultrawide-friendly multi-column mission-control layout is not hypothetical, it is the actual deployment target; (b) XDR + P3 means true blacks and high-brightness accents render beautifully — a dark-room instrument palette will look better here than on average hardware; (c) GPU headroom for WebGL graph rendering is ample.

---

## Options considered

### Direction A — "Instrument Grade" (Braun/Rams × teenage engineering × flight deck)

**Concept:** The harness is a calibrated instrument, not a website. Every screen is a panel; every value is a readout; every control is labeled like hardware. Rams' "as little design as possible" executed in a dark room.

- **Palette:** near-black warm charcoal surfaces (`#111110`, `#1A1917` panels — warm, not navy); bone/off-white primary text (`#E8E6E1`); ONE signal accent: instrument amber (`#FFB000` family) reserved for interactive/attention; semantic-only status hues (green = healthy, amber = degraded, red = fault) used exclusively for state, never decoration. Per-backend channel identification (MAX_A, MAX_B, ENT, Bedrock, LM Studio) via small engraved-style labels + a restrained per-channel index color used at low saturation. No gradients anywhere.
- **Type stack:** Berkeley Mono (TX-02) for data, readouts, labels, code (license permitting — see risks); free fallback: Commit Mono or IBM Plex Mono. Display/UI face: a characterful grotesque that is NOT on the slop list — paid: Söhne or Suisse Int'l; free: Cabinet Grotesk or General Sans (Fontshare). Numerals always tabular. Type scale ratio ≥ 1.25.
- **Layout system:** fixed-density panel grid (flight-deck logic: consistent placement so state is glanceable); hairline 1 px rules and spacing to divide — **no cards, no shadows, no nesting**; corner radius 0–2 px; tick marks, scale rulings, and unit labels as chrome. Ultrawide: three-zone cockpit layout (left: fleet/workstreams; center: active session; right: instruments/quota).
- **Texture:** 2–3% SVG noise on the base surface only; subtle engraved/debossed label treatment; no glass, no blur.
- **Motion language:** mechanical and fast — 120–180 ms, `ease-out` only, transform/opacity only; state changes snap like a relay; ONE ceremonial moment (workstream merge / session branch animates its lineage edge). Latency budget is a token: interactions must respond < 100 ms.
- **Context graph in this direction:** deep charcoal canvas; nodes as precise instrument dots with amber glow ONLY for the actively-read artifact (live session pulse); inactive nodes dimmed bone; edges hairline; clusters labeled in mono smallcaps; hairball control via type-based filtering (CLAUDE.md / memory / agents / refs as switchable layers, like avionics display modes).
- **Observability in this direction:** aviation-gauge semantics — big tabular-mono numerals, sparklines not area charts, quota as a horizontal fuel gauge per account, cost as an odometer-style counter; red only when a threshold is breached.
- **Pros:** perfectly on-theme for "mission control"; extremely durable (Rams aesthetics don't date); high glanceability for a monitoring tool; strongly differentiated from both slop AND the brutalist counter-uniform; token-lockable, so agents can build it reliably.
- **Cons:** demands real discipline (a half-executed instrument panel is just a boring gray app); one-accent austerity can feel severe; needs excellent type to carry it.
- **Risks:** Berkeley Mono licensing in a public repo (must self-host outside the tree or buy an appropriate license — font files must never be committed); drifting into cosplay if tick-marks/dials get decorative.

### Direction B — "Paper Terminal" (the monospace web × Swiss editorial)

**Concept:** the harness as a live engineering document — a lab notebook that computes. Character-grid layout, print physicality, ink-on-paper.

- **Palette:** warm paper white (`#F4F1EA`) or light bone; near-black ink text; ONE Swiss red (`#D93025`-adjacent) accent; status via ink-weight and small filled/unfilled glyphs more than color. Optional inverted "night print" mode.
- **Type stack:** monospace-first per the monospace web (Iosevka or IBM Plex Mono for everything structural); editorial grotesque (GT Pressura-style ink-bleed face, or free: Familjen Grotesk) for headings. NO italic serif heroes (slop marker).
- **Layout:** strict character-sized grid; responsive in character steps; tables, box-drawing characters and ASCII rules as legitimate layout; section numbering (1.0, 1.1) like a spec document; footnote-style metadata.
- **Texture:** paper grain noise; slight ink-spread on text via subtle contrast tuning; hairline rules like a printed form.
- **Motion:** near-none — instant state swaps, blinking block cursor as the only idle animation; motion identity = the absence of motion.
- **Graph:** blueprint / schematic style — ink nodes on paper, edges like circuit traces, cluster labels as marginalia. Dashboards: dense printed-table aesthetics, mini bar charts like a broadsheet finance page.
- **Pros:** deeply distinctive; cheap to execute consistently (the grid does the design); ages beautifully; exceptional for text-dense session transcripts.
- **Cons:** light-first is wrong for an always-open monitoring tool in a dev's dark-mode world; "monospace everything" is explicitly flagged as the rising counter-cliché; long-session eye strain; hard to make live telemetry feel alive without motion.
- **Risks:** reads as a static document rather than a control surface; the 2026 indie-hacker wave is already crowding this look.

### Direction C — "Phosphor Ops" (CRT mission control / dark-room terminal)

**Concept:** full command-bunker: single phosphor hue on black, the room-at-night aesthetic of NORAD consoles and cool-retro-term.

- **Palette:** true black / very dark green-black; amber phosphor `#FFB000` as the single hue (warmer, less "hacker cosplay" than green `#00FF41`); brightness levels of the phosphor encode hierarchy; alerts flip locally to red phosphor.
- **Type:** one mono only (Berkeley Mono or Martian Mono), sized on a terminal cell grid; box-drawing chrome.
- **Layout:** terminal-cell grid; panes like tmux with visible frame characters; status line always present.
- **Texture/effects:** restrained bloom on the accent; optional scanlines ≤ 4% opacity; NO barrel distortion or RGB-shift in the working UI (demo-mode only).
- **Motion:** phosphor decay as the motion identity — elements brighten instantly, fade out with a short decay tail; typing/streaming text is the hero animation.
- **Graph:** radar/oscilloscope framing — nodes as phosphor blips, sweep-style refresh, range-ring background. Dashboards: waveform sparklines, seven-segment-style numerals.
- **Pros:** maximal atmosphere; thematically dead-on for a terminal-agent orchestrator; the phosphor-decay motion identity is genuinely ownable; users would screenshot it constantly.
- **Cons:** kitsch half-life — novelty wears off in a daily-driver; single-hue limits information design (color can't encode channel identity); accessibility/contrast strain; sci-fi HUD styling is the next cliché in formation (arwes.dev cyberpunk kits).
- **Risks:** becomes a toy; effects tax GPU during long sessions; hard to render dense USD/cost tables legibly in one hue.

---

## Recommendation (opinionated)

**Adopt Direction A — "Instrument Grade" — as the base system, with two deliberate imports:** B's character-grid discipline for all data-dense surfaces (transcripts, cost tables, quota readouts), and C's phosphor-amber as the single signal accent plus the phosphor-decay fade as the motion signature for live telemetry. Mnemonic for every future design decision: **"flight instrument, not spaceship cosplay."**

Concretely, lock the following as the seed of `DESIGN.md` (the anti-slop literature is unanimous that a token lock is the only thing that keeps coding agents on-brand):

```
surface:      #111110 (base) / #1A1917 (panel) / #242220 (raised)   — warm charcoal, never navy
text:         #E8E6E1 (primary) / #8A867E (muted)                    — bone, never pure white
accent:       #FFB000 (interactive/attention ONLY)                   — instrument amber
status:       #3FB950 ok / #D29922 degraded / #F85149 fault          — semantic use ONLY
channels:     MAX_A / MAX_B / ENT / BEDROCK / LMSTUDIO               — low-sat index hues + engraved mono labels
type:         Berkeley Mono TX-02 (data/labels/code; fallback: Commit Mono or IBM Plex Mono)
              Söhne or Cabinet Grotesk (UI/display)                  — numerals ALWAYS tabular
radius:       0–2px          shadows: none          gradients: none  glass: none
rules:        1px hairline dividers instead of cards; no nested containers
motion:       120–180ms ease-out, transform/opacity only; phosphor-decay fade on live data;
              ONE ceremonial animation (workstream branch/merge lineage)
FORBIDDEN:    purple/indigo anything, gradients, glassmorphism, Inter/Geist/Space-Grotesk headlines,
              italic-serif heroes, ✨/wand/robot icons, bento grids, icon-card triplets,
              bounce easing, colored glows, uppercase-tracked kicker labels, "cards"
```

Why A and not B or C outright: this is a **monitoring instrument used all day** — it must be dark, calm, and glanceable (B fails dark/alive; C fails calm/durable). Direction A also has the strongest benchmark backing: it is precisely the Linear lesson (discipline + speed as brand) fused with the Rams/TE lineage that dev-tool audiences already revere, and it is the direction least likely to be assimilated by either the slop uniform or the brutalist counter-uniform. The imports from B and C supply the two things pure Rams-austerity lacks — density rhythm for data and an ownable motion identity.

Equally important, the non-visual half of the recommendation: **latency and keyboard flow are part of the design system.** Sub-100 ms interaction budget, a Raycast-style command palette as the primary verb surface ("launch prompt on MAX_B" in two keystrokes), Warp-style session blocks as the structural primitive, and Family-style selective delight (exactly one ceremony: workstream lineage events).

---

## Implications for the harness

1. **DESIGN.md is a Stage-2 deliverable, before any UI code.** Every build agent gets it in context; it contains the token block above plus the FORBIDDEN list as literal negative prompts. This is the only empirically supported way to keep agent-generated UI on-brand.
2. **Font licensing is an [X2]-class concern.** Berkeley Mono is a paid license; font binaries must NEVER be committed to the public repo (license violation + repo hygiene). Ship with free fallbacks (Commit Mono / IBM Plex Mono, Cabinet Grotesk via Fontshare — verify each license's self-hosting terms) and load paid faces from an untracked local directory (env-configured path), mirroring the secrets pattern.
3. **The channel system is the visual backbone.** MAX_A / MAX_B / ENT / Bedrock / LM Studio each get a fixed panel position, engraved label, and low-saturation index hue — the flight-deck "consistent placement" principle means the user learns where to glance for each account's quota/health. LM Studio's down-state ([X3] tolerance) renders as a dimmed instrument with a "NO SIGNAL" readout, not an error toast.
4. **Workstreams [X4] map naturally to the lineage graph.** Branch/continue/merge is drawn as a rail/track diagram (train-timetable aesthetics fit Direction A); the single ceremonial animation lives here.
5. **Context graph:** 2D WebGL force graph first (Obsidian-familiar), styled to tokens (amber pulse = artifact being read/written live; layer toggles per artifact type; cluster-dim by default to prevent hairball). Treat 3D as a later demo-mode toggle, not the default — the 3D galaxy prior art is spectacle over legibility.
6. **Dashboards:** RED-framed panels, one KPI per panel eye-line, tabular-mono numerals, fuel-gauge quota bars, odometer cost counter for Bedrock USD; color only for state. No pie charts, no gradient area fills.
7. **Ultrawide-first layout** is justified by verified hardware (3440×1440 external + XDR built-in): design the three-zone cockpit at ≥1440 px wide first, collapse to single-column for the laptop panel.
8. **Electron/web-tech note:** whatever the Stage-2 stack choice, the default OS-chrome/shadcn look must be stripped; the token file governs from the first component. Dark-room palette + P3/XDR means testing accent brightness on the actual display matters.

---

## Sources

**AI slop definition & mechanics**
- https://impeccable.style/slop/ — most exhaustive slop-marker catalogue
- https://prg.sh/ramblings/Why-Your-AI-Keeps-Building-the-Same-Purple-Gradient-Website — Tailwind indigo-500 root cause
- https://vibecodekit.dev/ai-slop-design
- https://techbytes.app/posts/escape-ai-slop-frontend-design-guide/
- https://www.mindstudio.ai/blog/claude-design-avoid-ai-slop-design-system
- https://dev.to/_46ea277e677b888e0cd13/why-every-ai-generated-landing-page-looks-the-same-and-how-to-fix-it-1kmo
- https://andrew.ooo/posts/taste-skill-anti-slop-ai-frontend-review/

**Sparkles / AI iconography**
- https://www.nngroup.com/articles/ai-sparkles-icon-problem/
- https://design.google/library/ai-sparkle-icon-research-pozos-schmidt
- https://css-tricks.com/the-proliferation-and-problem-of-the-sparkles-icon/
- https://geoffgraham.me/struggling-with-ai-iconography-for-ui-design/

**Bento & trend fatigue**
- https://www.saasframe.io/blog/designing-bento-grids-that-actually-work-a-2026-practical-guide
- https://studiomeyer.io/en/blog/webdesign-trends-2026-reality-check
- https://senorit.de/en/blog/bento-grid-design-trend-2025

**Craft benchmarks**
- https://blog.logrocket.com/ux-design/linear-design/
- https://linear.app/now/how-we-redesigned-the-linear-ui
- https://newsletter.pragmaticengineer.com/p/linear
- https://getdesign.md/warp/design-md
- https://guptadeepak.com/tools/top-5-developer-productivity-tools-2026/
- https://benji.org/family-values
- https://live.standards.site/perplexity/type and https://live.standards.site/perplexity/design
- https://brandarchive.xyz/identity/perplexity
- https://onlyonceshop.com/blog/from-braun-to-teenage-engineering
- https://www.awwwards.com/less-but-better-dieter-rams-s-influence-on-today-s-ui-design.html
- https://news.ycombinator.com/item?id=40219598

**Mission control / high-stakes UX**
- https://medium.com/@blessingokpala/ux-lessons-from-nasa-designing-interfaces-for-high-stakes-environments-362b3a7b20b1
- https://topsoftwarecompanies.co/web-design/how-nasa-uses-web-design-to-optimize-user-experience-in-space-control
- https://www.juancarlos.tech/blog/recreating-nasas-ui-for-their-mission-control-tech

**Typography / texture / motion currents**
- https://owickstrom.github.io/the-monospace-web/ (+ https://github.com/owickstrom/the-monospace-web)
- https://usgraphics.com/products/berkeley-mono
- https://news.ycombinator.com/item?id=38322793
- https://github.com/ahatem/IoskeleyMono
- https://madegooddesigns.com/font-trends-2026/ and https://madegooddesigns.com/best-programming-fonts-2026/
- https://www.creativeboom.com/resources/top-50-fonts-in-2026/
- https://www.itsnicethat.com/features/forward-thinking-graphic-trends-2026-graphic-design-120126
- https://swissthemes.design/insights/swiss-design-for-web-designers
- https://www.pixeldarts.com/en/post/swiss-style-web-design-a-comprehensive-guide
- https://www.solmadestudio.com/blog/exploring-textural-design-trends
- https://wings.design/insights/how-motion-design-shapes-brand-identity-in-a-digital-first-world
- https://www.octopusmarketing.agency/the-language-of-brand-motion-conveying-stories-through-movement/
- https://www.everything.design/faq/motion-identity-brand-need

**CRT / phosphor**
- https://dev.to/remojansen/building-a-retro-crt-terminal-website-with-webgl-and-github-copilot-claude-opus-35-3jfd
- https://github.com/Swordfish90/cool-retro-term
- https://github.com/takk8is/amber-monochrome-monitor-crt-phosphor-theme-for-zed
- https://uidesignprompts.com/prompts/terminal-design

**Competitive set**
- https://www.conductor.build/
- https://madewithlove.com/blog/conductor-running-multiple-ai-coding-agents-in-parallel/
- https://agentsroom.dev/blog/best-multi-agent-coding-tools
- https://www.augmentcode.com/tools/open-source-agent-orchestrators

**Observability & graphs**
- https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/best-practices/
- https://www.groundcover.com/learn/observability/grafana-dashboards
- https://www.skedler.com/blog/10-must-have-grafana-dashboards-kubernetes-prometheus/
- https://obsidian.md/help/plugins/graph
- https://publish.obsidian.md/hub/04+-+Guides,+Workflows,+&+Courses/Guides/Graph+view+customization
- https://codeculture.store/blogs/developer-culture/obsidian-graph-view-useful
- https://forum.obsidian.md/t/graph-view-physics-and-force-directed-graphs/72586
- https://darcynorman.net/2026/04/10/experimental-obsidian-3d-graph-renderer/

---

## Open questions

1. **Font budget & licensing:** buy Berkeley Mono TX-02 (per-seat/webfont terms need reading), or commit to free-only (Commit Mono + Cabinet Grotesk)? Either way the public-repo rule stands: no paid font binaries in the tree. Fontshare/OFL terms for self-hosting must be verified at Stage 2.
2. **Stack dependency:** is the frontend web-tech (Electron/Tauri/localhost web app) or native (SwiftUI)? Direction A is stack-agnostic, but the motion/latency budget and P3 color handling differ; Tauri would help the "instrument, not website" feel with lower RAM than Electron. Owned by the architecture research track.
3. **Light-mode variant:** is a "day cockpit" theme needed at all, or is dark-only an acceptable (and brand-strengthening) constraint for a personal tool?
4. **Graph 2D vs 3D:** recommendation says 2D-first; is the "live galaxy" 3D view worth building as a demo mode, and does it share the same token system?
5. **Naming the design system** (tokens need a namespace — e.g. `instrument-*`): pick a name that survives the public repo (no account-identifying references).
6. **Accessibility targets:** adopt APCA (as the anti-slop guides suggest) over WCAG 2 contrast ratios for the amber-on-charcoal pairs? Needs a decision before tokens freeze.
7. **How much C to import over time:** scanlines and decay-fades are dosage-sensitive — define the "cosplay line" empirically once real screens exist (user test: does it still feel professional after 8 hours?).
