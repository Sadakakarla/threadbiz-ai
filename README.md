# ThreadBiz AI

**A social media agent for a small home business that learns from the owner's feedback, and keeps that learning as verifiable knowledge on the OriginTrail DKG.**

Track: **Track 2 — Livepeer Agent + OriginTrail DKG**

- 🎬 **Demo video:** https://youtu.be/vAfjPORPN3Y
- 🔎 **Pipeline replay (in your browser):** https://sadakakarla.github.io/threadbiz-ai/ — every real run step by step: what was read from the DKG, the caption, the image, each judge's verdict, the owner's decision and what was written back.

---

## The idea

A neighbor selling a weekly batch of home-cooked food needs to post every week, but has no time to write prompts, and generic AI content quickly starts inventing things: "grandma's recipe", "sweet garden tomatoes", "a dish many of you asked for".

ThreadBiz AI keeps the business's memory in the DKG and uses Livepeer AI models to write, illustrate and check each week's post. **The owner never writes a prompt.** They do one thing: approve the post, or reject it with a one-line reason.

That reason is the product. It is stored, word for word, as a confirmed **lesson** in an Improvement Memory Knowledge Asset. Every later post is written with all lessons in force and checked against each one by a dedicated judge. **Nothing becomes memory until the owner confirms it.**

Demo business: **The Neighborhood Table** (`neighborhood-table-001`), a home cook's weekly pre-order meal drop, followed over three weeks.

## What actually happened: three weeks, four lessons

Every row below is a real pipeline run. The full record, including every rejected caption, is in the DKG and in this repo's snapshot (`data/dkg-export/`).

| Week | What the writer invented | Judges | Owner | Knowledge written to the DKG |
|---|---|---|---|---|
| 1 | "a recipe passed down through generations" | passed it | rejected | **lesson-001** → `improvement-memory-v1` |
| 1 | "just like my grandmother… in our family for generations" | passed it | rejected (same rule) | lesson-001 seen 2× → `v2` |
| 1 | "the last **sweet** tomatoes" (lesson-001 now followed ✅) | passed it | rejected | **lesson-002** → `v3` |
| 1 | nothing: both lessons followed and cited | pass, first try | **approved** | `journey-entry-009` (replaces the hand-made R&D entry-001) |
| 2 | "a dish **many of you** have been asking for… **a favorite of Maria's**… tender carrots" | passed it | rejected | **lesson-003** → `v4` |
| 2 | "we're **bringing back**… Maria asked if we could bring back our roast chicken" (never served before) | passed it | rejected | **lesson-004** → `v5` |
| 2 | nothing: all four lessons followed and cited | pass, first try | **approved** | `journey-entry-010` |
| 3 | "a truly **nourishing** start to the colder weather" | passed it | rejected (same as lesson-002, wider wording) | lesson-002 seen 2× → `v6` |
| 3 | nothing invented; judges raised false alarms (an ingredient not in the dish, a coincidental 4-word match) | fail (false positives) | **approved, overriding the judges** | `journey-entry-011`, then swapped by the owner for the better image of the same run → `journey-entry-012` (replaces 011) |

The pattern is the point: **the judges let invented claims through six times; the owner caught each one; each became a lesson; and that exact mistake did not come back.** Each week brought new facts (customers, a supplier), new ways to go wrong, and the system learned each one.

The approved posts:

| Week 1 (`journey-entry-009`) | Week 2 (`journey-entry-010`) | Week 3 (`journey-entry-012`) |
|---|---|---|
| ![Week 1](https://agent.livepeer.org/a/aHR0cHM6Ly83eTRmbHpwdWxndjRjbzZyLnB1YmxpYy5ibG9iLnZlcmNlbC1zdG9yYWdlLmNvbS91cGxvYWRzLzE3OTAyMzY2MjMxODEtaXMwOTR6LmpwZWc.630e58a78cb776b8/1790236623181-is094z.jpeg) | ![Week 2](https://agent.livepeer.org/a/aHR0cHM6Ly83eTRmbHpwdWxndjRjbzZyLnB1YmxpYy5ibG9iLnZlcmNlbC1zdG9yYWdlLmNvbS91cGxvYWRzLzE3OTAyMzgxNjI0NTktbDVldDNjLmpwZWc.e24907e4308f565b/1790238162459-l5et3c.jpeg) | ![Week 3](https://agent.livepeer.org/a/aHR0cHM6Ly83eTRmbHpwdWxndjRjbzZyLnB1YmxpYy5ibG9iLnZlcmNlbC1zdG9yYWdlLmNvbS91cGxvYWRzLzE3OTAyMzk4NTc3NTQtNXRvZHk4LmpwZWc.ecc4f6bba5091f88/1790239857754-5tody8.jpeg) |
| *"This week, we're bringing you a comforting vegetable and herb soup, made with the last of the season's tomatoes. It's a perfect taste of home as the seasons change. Pre-order your soup today!"* | *"This week, we're making a bigger batch of slow-roasted chicken with carrots, potatoes, and red onion wedges. After last week's soup sold out quickly, Maria asked for roast chicken, and Dave, who learned about us from Maria, wanted something heartier as the weather changes. This is a comforting meal perfect for the season. Please pre-order soon!"* | *"This week's menu brings together a few cherished connections and ingredients! We're making dumplings in a broth crafted from last week's saved chicken bones, with carrots and fresh parsley from Rosa's farm stand. It's all seasoned with dried basil from Week One, and we're so glad Dave's daughter asked for dumplings! Please pre-order for this week's drop."* |

Copies of all four confirmed post images are in `data/media/journey-entry-009…012.jpg`; each file's sha256 matches the `imageSha256` stored in its DKG journey entry (`shasum -a 256 data/media/journey-entry-*.jpg`).

Memory compounds across the weeks: Week 1's soup sold out → Week 2 is a bigger batch requested by a returning customer (Maria), who referred a new one (Dave) → Week 3's supplier (Rosa) came through Dave, the broth uses Week 2's chicken bones and the seasoning is basil saved from Week 1.

**Tracing improvement to knowledge, not scores.** Each run file records which Improvement Memory version and which lessons were given to the writer and the judge, and which lessons the writer says it applied (it must cite each one). The lesson occurrences in the DKG link every rule back to the exact rejected caption and run that produced it.

## How it works

```
DKG (Shared Working Memory)                      Livepeer Agent (run_capability)
  Business Memory vN ─┐                           ┌─ gemini-text: writer (caption + scene)
  Journey entry      ─┼─► brief ─► writer ────────┤─ flux-dev: image (persisted URL)
  Improvement Memory ─┘            │              ├─ nemotron-omni-vision: image judge
     (owner lessons)               ▼              └─ gemini-text: caption judge
                         judges + code checks          + one dedicated check PER owner lesson
                                   │
                    FAIL → one targeted revision (only the failed part is redone)
                                   │
              candidate draft journey-entry-NNN created in Working Memory (private)
                                   │
                     OWNER: approve ──► confirmed entry shared to SWM, read back, verified
                            reject  ──► draft discarded; reason → next improvement-memory-vN
```

1. **Read memory from the DKG.** One exact Business Memory version, one Journey entry and the latest Improvement Memory, each from its own named graph (versions share a subject IRI, so an unscoped query would mix them).
2. **Write.** `gemini-text` gets a brief built from memory, including a "LESSONS FROM THE OWNER (must follow)" section, and must cite each lesson it applied. **Private entries** (`canBeUsedPublicly: false`, e.g. voice-note transcripts) are never sent to a model; only their owner-approved summary is.
3. **Image.** `flux-dev`, with a fixed "ordinary phone photo" style appended by code and rules for a real small home business: the owner at work (chest down, face never shown, same grey apron every week) packing the batch into takeout containers. The image is persisted and its sha256 recorded.
4. **Judge.** Separate calls for image and caption with itemized findings (code enforces verdicts from the item lists), a code-level privacy check, and **one dedicated yes/no check per owner lesson** that must quote the offending words. If a lesson judge says "no violation" while quoting words that really are in the caption, code overrides it. Image checks include "is the owner at work without a face showing" and "is the batch visibly being packed for pickup".
5. **Revise once** on failure: only the failed part is regenerated, code locks everything that passed, everything is re-judged.
6. **Owner decides.** Approve, or reject with a reason (and say whether it is the same rule as an existing lesson). The owner can override the judges either way; that is recorded.

## DKG usage: what is private, shared, published

| Data | Knowledge Asset(s) | Memory layer |
|---|---|---|
| Business Memory (tone, facts, people, strategy), versioned | `business-memory-v1…v3` in `threadbiz-main` | Shared Working Memory (SWM) |
| Journey Ledger (weekly events, voice notes) | `journey-001…003` in `threadbiz-journey` | SWM; entries marked private are never sent to any model |
| A post waiting for the owner | `journey-entry-NNN`, status `candidate` | **Working Memory (WM)**: private, sealed draft |
| An approved post | `journey-entry-NNN`, status `confirmed` | SWM, after discard + `create --share` and a read-back check |
| Owner lessons | `improvement-memory-v1…v6`, each a cumulative snapshot | SWM |
| Verifiable Memory (on-chain) | — | **Not used.** Assets have reserved UALs on Base Sepolia (chain 84532); VM publish is a possible next step. |

The create / retrieve / verify path (`src/dkg.ts`):
- **Create:** `dkg ka create <name> --context-graph-id <cg> --input-file <file.ttl> [--share]`. Turtle is written by code, and the node's "Parsed N quad(s)" is checked against what was written.
- **Retrieve:** `dkg ka status` → KA number → named graph `…/_shared_memory/<agent>/<kaNumber>` → SPARQL `GRAPH <g> { ?s ?p ?o }`.
- **Verify:** after every write, the asset is read back from SWM and compared triple by triple.
- **Never edit:** rejected or stale drafts are discarded; sealed assets are never changed. A newer entry carries `replaces` instead (009 replaces 001, 012 replaces 011).

## Livepeer usage

All model calls go through the Livepeer Agent MCP endpoint `https://agent.livepeer.org/api/mcp` (tool `run_capability`, plain HTTP JSON-RPC, the same endpoint the official reference example uses). The creative MCP (`/api/mcp/creative`) is also configured in `.mcp.json` for development in Claude Code.

| Role | Capability | Notes |
|---|---|---|
| Writer (caption + scene description) | `gemini-text` | must cite every owner lesson it applied |
| Image | `flux-dev` | `persist: true` → durable `agent.livepeer.org/a/…` URL; the model that actually ran is recorded |
| Image judge | `nemotron-omni-vision` | lists each ingredient's visibility; checks realism, owner-at-work, packing for pickup |
| Caption judge + one check per lesson | `gemini-text` | itemized claims; per-lesson checks must quote words |

A typical run costs **about $0.04–0.08**.

## Clean-start setup (for judges)

The whole knowledge base is in the repo as an exact snapshot (`data/dkg-export/`, 16 Knowledge Assets with a sha256 manifest), and one command loads it into a fresh node.

**1. Run a DKG V10 Edge Node in Docker.** We used DKG **10.0.14** in a `node:22-alpine` container named `threadbiz-dkg-node`, port 9200, with its state in a Docker volume mounted at `/dkg-home`. Set it up with the official DKG instructions (`npm install -g @origintrail-official/dkg`, `dkg init`, `dkg start`; see https://github.com/OriginTrail/dkg). The pipeline talks to the node with `docker exec <container> dkg …`, so the `dkg` CLI must work inside the container.

**2. Create two context graphs and point the config at them.**
```bash
docker exec <your-container> dkg context-graph create threadbiz-main
docker exec <your-container> dkg context-graph create threadbiz-journey
docker exec <your-container> dkg context-graph list      # ids are auto-prefixed: <your agent address>/threadbiz-…
```
In `config/threadbiz.json`, set `dkg.container` to your container name and `dkg.memoryContextGraph` / `dkg.journeyContextGraph` to those two ids.

**3. Install and seed.**
```bash
npm install
npm run typecheck
npm run seed        # loads all 16 assets, shares them to SWM, verifies each triple by triple
npm run lessons     # should show improvement-memory-v6 with 4 lessons
```
`npm run seed` is safe to run twice: assets that already exist are verified, not rewritten. (`npm run export-dkg` regenerates the snapshot from a node.)

**4. Run a week.**
```bash
npm run week -- --memory business-memory-v3 --journey journey-003 --entry entry-006 \
  --note "This week's drop: dumplings in a broth made from last week's saved chicken bones, with carrots and parsley from Rosa's farm stand a few blocks over, seasoned with dried basil saved from week one's soup. Dave's daughter asked for dumplings, and Dave is the one who introduced us to Rosa." \
  --title "Week 3: Savory Filled Dumplings in Broth" --no-dkg-write
```
`--no-dkg-write` keeps a test run read-only. Without it, approving writes a new journey entry and rejecting writes a new lesson. No API key is needed: the Livepeer endpoint is keyless.

**Before/after in one command pair:** add `--improvement none` to run the same week with no lessons, then run it again without that flag.

### All commands and flags

```
npm run week -- --memory <business-memory-vN> --journey <journey-00N> --entry <entry-NNN> --note "<owner note>"
    [--title "..."] [--replaces entry-NNN]
    [--improvement latest|none|improvement-memory-vN]   lessons: latest (default), switched off, or pinned
    [--no-dkg-write]                                     fully read-only
    [--stop-after memory|brief] [--no-retry]
    [--decision approve|reject --reason "..." [--same-as lesson-00N]]   non-interactive owner decision
    [--caption "..."] [--image-url https://agent.livepeer.org/...]      reuse a caption / image from an earlier run (still judged)
npm run lessons                                     read-only view of the owner's lessons + next journey entry id
npm run writeback -- lesson|entry --from-run <runId>   recover a decision whose DKG write failed
npm run export-dkg / npm run seed                    snapshot the knowledge base / load it into a node
npm run viewer                                       rebuild docs/index.html (the pipeline replay page) from runs/ + the DKG snapshot
```

Each run writes `runs/<runId>.json` (inputs incl. the Improvement Memory version and lessons, both rounds, judging, owner decision, DKG writes, cost, timings). `runs/` is gitignored because raw logs contain private text.

## Repository layout

```
threadbiz-ai/
├── README.md
├── LICENSE                      MIT
├── package.json                 npm scripts: week, lessons, writeback, export-dkg, seed, viewer, typecheck
├── package-lock.json
├── tsconfig.json
├── .gitignore                   keeps runs/, node_modules/ and local node state out of git
├── .mcp.json                    Livepeer MCP servers for development in Claude Code
│
├── docs/
│   └── index.html               pipeline replay page (GitHub Pages), built by `npm run viewer`
│
├── config/
│   ├── threadbiz.json           business id, DKG container + context graph ids, Livepeer models
│   └── visual-style.json        photo style, image rules, banned words, image judge rubric
│
├── src/
│   ├── run.ts                   the pipeline: read → write → image → judge → revise → owner → DKG write
│   ├── brief.ts                 writer prompt, owner lessons, lesson citations, code checks
│   ├── judge.ts                 image judge, caption judge, per-lesson checks, privacy check
│   ├── improvement.ts           Improvement Memory: load latest, record a lesson as the next version
│   ├── journey.ts               journey entry lifecycle (WM candidate → SWM confirmed)
│   ├── memory.ts                load a Business Memory version and a journey entry
│   ├── dkg.ts                   DKG CLI: status, query, create, discard, read-back verification
│   ├── snapshot.ts              export the knowledge base / seed a fresh node
│   ├── viewer.ts                builds the pipeline replay page (docs/index.html)
│   ├── livepeer.ts              Livepeer MCP client (run_capability, job polling, image download)
│   ├── ttl.ts                   dependency-free Turtle writer
│   ├── config.ts                settings loader, tolerant JSON parsing, phrase matching
│   ├── writeback.ts             record or recover owner decisions from saved run files
│   └── lessons.ts               read-only view of Improvement Memory
│
├── data/
│   ├── dkg-export/              exact snapshot of all 16 Knowledge Assets (loaded by `npm run seed`)
│   │   ├── manifest.json        asset list, load order, triple counts, sha256 per file
│   │   ├── main/                business-memory-v1…v3, improvement-memory-v1…v6
│   │   └── journey/             journey-001…003, journey-entry-009…012
│   ├── business-memory/         original hand-authored Business Memory sources (v1–v3, Turtle)
│   ├── journey-ledger/          original hand-authored Journey Ledger sources (weeks 1–3, Turtle)
│   └── media/
│       ├── journey-entry-009.jpg   Week 1 approved post image  ┐
│       ├── journey-entry-010.jpg   Week 2 approved post image  │ sha256 = imageSha256
│       ├── journey-entry-011.jpg   Week 3 first approved image │ in the DKG entry
│       ├── journey-entry-012.jpg   Week 3 final post image     ┘
│       └── week1-soup.jpg          hand-made R&D image (entry-001, replaced by 009)
│
└── runs/                        created locally by each run, NOT committed (gitignored)
    ├── <runId>.json             full run record: inputs, lessons used, judging, owner decision, DKG writes
    ├── images/                  local backup of every generated image
    └── raw/                     raw Livepeer responses (may contain private text)
```

## Known limitations (honest)

- **Small judges are unreliable in both directions.** They missed invented claims six times, and in Week 3 they raised false alarms (an ingredient not in the dish, "we're making" read as "made before", a coincidental 4-word privacy match). The owner's final say, the dedicated per-lesson checks and code-level overrides are the mitigations. The caption judge is the same model family as the writer (self-grading bias).
- **Lessons come only from the owner.** Judge-suggested lessons are a possible next step; we chose not to let a model write memory without owner confirmation.
- **Business Memory versions v1–v3 were authored from the owner's voice notes** (journey entries 003 and 006) and stored as confirmed versions; the pipeline reads them but does not yet propose Business Memory updates itself. That is the natural next step (propose an update from a voice note → owner confirms → new version).
- **Customer names appear in public captions** because the owner marked the entries that name them as public. There is no per-person consent flag yet.
- **Compressed timeline.** The three "weeks" are dated 21–24 September 2026 for the hackathon.
- **Images still look slightly styled** at times despite the phone-photo rules, and the image model does not always follow instructions (the judges catch most of it).
- **The original Week 1 image** (`data/media/week1-soup.jpg`, recorded in `entry-001`) was made by hand during R&D, before the pipeline existed. The pipeline's Week 1 post (`journey-entry-009`) replaces it without editing the sealed original.
- **No Verifiable Memory publish.** Data lives in Working and Shared Working Memory only.
- **Docker required.** The DKG client runs `dkg` inside the node's container via `docker exec`.
- **Testing:** the happy paths ran on a real node; failure paths (write failures, lazy or unreadable judges, missing citations, tampered snapshots) were tested against a fake DKG node and a fake Livepeer server. Seeding was verified on our real node (all 16 assets identical) and into an empty node in simulation, not yet on a second real node.
- **Single business, CLI only.** There is no UI; the owner reviews in the terminal.

## Privacy and safety

- Private journey entries are never sent to a model; only an owner-approved summary is. A code check blocks captions that repeat 4+ words of private text.
- Prompts are stored in run files with private text replaced by a hash.
- No keys, tokens or raw private prompts are committed; `runs/` is gitignored. The demo business and its people are fictional.

## License

MIT — see `LICENSE`.