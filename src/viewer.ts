import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, settings } from "./config.ts";

/*
 * npm run viewer
 *   Builds docs/index.html: a self-contained web page that replays the real pipeline runs step by step
 *   (inputs → writer → image → judges → revision → owner → DKG write) and the owner's lessons over time.
 *
 * The list of runs comes from the DKG snapshot (data/dkg-export): every run that produced a lesson or an
 * approved post. Step details come from the local run files (runs/*.json, gitignored). Only public-safe fields
 * are embedded: no prompts, no raw model responses, no private voice-note text.
 */

const EXPORT_DIR = path.join(ROOT, "data", "dkg-export");
const RUNS_DIR = path.join(ROOT, "runs");
const OUT_DIR = path.join(ROOT, "docs");
const NS = "https://threadbiz.example/#";
const TB = "https://threadbiz.ai/ontology#";

// ---------- read the DKG snapshot (one triple per line, written by src/snapshot.ts) ----------

type Obj = Record<string, string[]>;
function readSnapshot(file: string): Map<string, Obj> {
  const token = /<[^>]*>|_:[A-Za-z0-9]+|"(?:[^"\\]|\\.)*"(?:@[A-Za-z0-9-]+|\^\^<[^>]*>)?/g;
  const subjects = new Map<string, Obj>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const parts = line.match(token);
    if (!parts || parts.length !== 3) continue;
    const [s, p, o] = parts;
    const key = p.slice(1, -1).split(/[#/]/).pop()!;
    const lit = /^"((?:[^"\\]|\\.)*)"/.exec(o);
    const value = lit ? JSON.parse(`"${lit[1]}"`) : o.replace(/^<|>$/g, "");
    if (!subjects.has(s)) subjects.set(s, {});
    (subjects.get(s)![key] ??= []).push(value);
  }
  return subjects;
}
const first = (o: Obj | undefined, k: string) => (o?.[k]?.[0] ?? "");

interface Manifest { assets: { name: string; graph: string; file: string; triples: number; sha256: string }[] }

function loadDkg() {
  const manifest = JSON.parse(readFileSync(path.join(EXPORT_DIR, "manifest.json"), "utf8")) as Manifest;
  const byName = new Map(manifest.assets.map((a) => [a.name, a]));

  const imVersions = manifest.assets
    .filter((a) => /^improvement-memory-v\d+$/.test(a.name))
    .map((a) => {
      const subj = readSnapshot(path.join(EXPORT_DIR, a.file));
      const root = subj.get(`<${NS}improvement-memory>`);
      return { name: a.name, version: Number(first(root, "version")), triples: a.triples, updatedAt: first(root, "updatedAt"), changeNote: first(root, "versionChangeNote"), subj };
    })
    .sort((a, b) => a.version - b.version);

  const latest = imVersions[imVersions.length - 1];
  const lessons = latest
    ? [...latest.subj.entries()]
        .filter(([, o]) => (o.type ?? []).some((t) => t.endsWith("OwnerLesson")) || o.lessonId)
        .map(([, o]) => ({
          id: first(o, "lessonId"),
          rule: first(o, "rule"),
          occurrenceCount: Number(first(o, "occurrenceCount") || 1),
          occurrences: (o.occurrence ?? [])
            .map((iri) => latest.subj.get(`<${iri}>`))
            .filter(Boolean)
            .map((oc) => ({
              runId: first(oc, "runId"),
              recordedAt: first(oc, "recordedAt"),
              ownerReason: first(oc, "ownerReason"),
              rejectedCaption: first(oc, "rejectedCaption"),
              rejectedImage: first(oc, "rejectedImage"),
            }))
            .sort((x, y) => x.recordedAt.localeCompare(y.recordedAt)),
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    : [];

  // which improvement-memory version each lesson-producing run created
  const versionByRun: Record<string, string> = {};
  for (const v of imVersions) {
    const m = /run ([\w-]+)/.exec(v.changeNote);
    if (m) versionByRun[m[1].replace(/[.,;)]+$/, "")] = v.name;
  }

  const entries = manifest.assets
    .filter((a) => /^journey-entry-\d+$/.test(a.name))
    .map((a) => {
      const subj = readSnapshot(path.join(EXPORT_DIR, a.file));
      const o = [...subj.values()].find((x) => x.entryId) ?? {};
      return {
        asset: a.name,
        triples: a.triples,
        entryId: first(o, "entryId"),
        title: first(o, "title"),
        caption: first(o, "caption"),
        image: first(o, "sourceReference"),
        imageSha256: first(o, "imageSha256"),
        status: first(o, "status"),
        memoryVersionUsed: first(o, "memoryVersionUsed"),
        runId: first(o, "runId"),
        judgeOutcome: first(o, "judgeOutcome"),
        replaces: first(o, "replaces"),
        explainability: first(o, "explainability"),
      };
    })
    .sort((a, b) => a.asset.localeCompare(b.asset));

  const replacedBy: Record<string, string> = {};
  for (const e of entries) if (e.replaces) replacedBy[e.replaces] = e.entryId;

  return {
    manifest: manifest.assets.map((a) => ({ name: a.name, graph: a.graph, triples: a.triples })),
    improvementVersions: imVersions.map(({ subj, ...rest }) => rest),
    lessons,
    versionByRun,
    entries: entries.map((e) => ({ ...e, replacedBy: replacedBy[e.entryId] ?? "" })),
    byName: [...byName.keys()],
  };
}

// ---------- read one run file, keeping only public-safe fields ----------

const WEEK_BY_ENTRY: Record<string, number> = { "entry-000": 1, "entry-003": 2, "entry-006": 3 };

function pickCriteria(report: any) {
  if (!report) return null;
  return {
    judge: String(report.judge ?? ""),
    status: String(report.status ?? ""),
    error: report.error ? String(report.error).slice(0, 200) : "",
    criteria: (Array.isArray(report.criteria) ? report.criteria : []).map((c: any) => ({
      id: String(c.id),
      verdict: String(c.verdict),
      reason: String(c.reason ?? ""),
      checkedBy: String(c.checkedBy ?? ""),
    })),
  };
}

function pickRound(r: any) {
  const b = r?.brief?.brief ?? r?.brief ?? {};
  const img = r?.image ?? {};
  return {
    round: r?.round ?? 1,
    trigger: (Array.isArray(r?.trigger) ? r.trigger : []).map((f: any) => ({ part: String(f.part), id: String(f.id), reason: String(f.reason) })),
    caption: String(b.caption ?? ""),
    scene: String(img.sceneFromWriter ?? b.imagePrompt ?? ""),
    memoryFactsUsed: (Array.isArray(b.memoryFactsUsed) ? b.memoryFactsUsed : []).map((f: any) => ({ field: String(f.field), how: String(f.how) })),
    lessonsCited: Array.isArray(r?.lessonsCitedByWriter) ? r.lessonsCitedByWriter.map(String) : [],
    ctaAddedByCode: r?.brief?.ctaAddedByCode === true,
    writerModel: String(r?.brief?.model ?? "gemini-text"),
    image: {
      url: String(img.url ?? ""),
      reused: img.reusedFromRound ? `kept from round ${img.reusedFromRound}` : /reused/.test(String(img.requestedCapability ?? "")) ? "kept from an earlier run" : "",
      ran: String(img.capabilityThatRan ?? ""),
      size: img.size ? `${img.size.width}×${img.size.height}` : "",
    },
    judging: r?.judging ? { overall: String(r.judging.overall), image: pickCriteria(r.judging.image), caption: pickCriteria(r.judging.caption) } : null,
  };
}

function loadRun(runId: string) {
  const file = path.join(RUNS_DIR, `${runId}.json`);
  if (!existsSync(file)) return null;
  const r = JSON.parse(readFileSync(file, "utf8"));
  const od = r.ownerDecision ?? {};
  return {
    createdAt: String(r.createdAt ?? ""),
    memory: String(r.inputs?.memory?.asset ?? ""),
    entry: String(r.inputs?.entry?.id ?? ""),
    entryPrivate: r.inputs?.entry?.isPrivate === true,
    ownerNote: String(r.inputs?.ownerNote ?? ""),
    improvement: r.inputs?.improvementMemory
      ? {
          asset: String(r.inputs.improvementMemory.asset?.name ?? ""),
          lessons: (r.inputs.improvementMemory.lessonsGivenToWriterAndJudge ?? []).map((l: any) => ({ id: String(l.id), rule: String(l.rule), count: Number(l.occurrenceCount ?? 1) })),
        }
      : null,
    captionKept: Boolean(r.inputs?.captionKeptByOwner),
    imageKept: Boolean(r.inputs?.imageKeptByOwner),
    rounds: (Array.isArray(r.rounds) ? r.rounds : []).map(pickRound),
    final: { verdict: String(r.final?.verdict ?? ""), outcome: r.final?.outcome ?? null, round: r.final?.decidedInRound ?? null },
    owner: {
      decision: String(od.decision ?? ""),
      reason: String(od.reason ?? ""),
      sameAs: String(od.sameAs ?? ""),
      overrodeJudges: od.overrodeJudges === true,
      lessonWrite: od.lessonWrite && !od.lessonWrite.error ? { lessonId: String(od.lessonWrite.lessonId), asset: String(od.lessonWrite.assetName), triples: od.lessonWrite.triples } : null,
    },
    entryWrite: r.dkgWrites?.entry && !r.dkgWrites.entry.error ? { asset: String(r.dkgWrites.entry.assetName), triples: r.dkgWrites.entry.triples } : null,
    cost: Number(r.costUsdEstimated ?? 0),
  };
}

// ---------- build ----------

function build() {
  if (!existsSync(path.join(EXPORT_DIR, "manifest.json"))) throw new Error("data/dkg-export/manifest.json not found; run `npm run export-dkg` first");
  const dkg = loadDkg();
  const runIds = new Set<string>();
  for (const l of dkg.lessons) for (const o of l.occurrences) if (o.runId) runIds.add(o.runId);
  for (const e of dkg.entries) if (e.runId) runIds.add(e.runId);

  const missing: string[] = [];
  const runs = [...runIds].sort().map((runId) => {
    const detail = loadRun(runId);
    if (!detail) missing.push(runId);
    const lesson = dkg.lessons.find((l) => l.occurrences.some((o) => o.runId === runId));
    const occ = lesson?.occurrences.find((o) => o.runId === runId);
    const entry = dkg.entries.find((e) => e.runId === runId);
    const entryKey = /^(entry-\d+)/.exec(runId)?.[1] ?? "";
    return {
      runId,
      week: WEEK_BY_ENTRY[entryKey] ?? 0,
      outcome: entry ? "approved" : "rejected",
      lesson: lesson ? { id: lesson.id, version: dkg.versionByRun[runId] ?? "", ownerReason: occ?.ownerReason ?? "", rejectedCaption: occ?.rejectedCaption ?? "", rejectedImage: occ?.rejectedImage ?? "" } : null,
      entry: entry ?? null,
      detail,
    };
  });

  const data = {
    generatedAt: new Date().toISOString(),
    business: { id: settings.businessId, name: "The Neighborhood Table" },
    models: { writer: settings.livepeer.writer, image: settings.livepeer.imageModel, imageJudge: settings.livepeer.imageJudge, captionJudge: settings.livepeer.captionJudge },
    lessons: dkg.lessons,
    improvementVersions: dkg.improvementVersions,
    entries: dkg.entries,
    manifest: dkg.manifest,
    runs,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  writeFileSync(path.join(OUT_DIR, "index.html"), PAGE.replace("__DATA__", () => json), "utf8");
  console.log(`Built docs/index.html: ${runs.length} runs, ${dkg.lessons.length} lessons, ${dkg.entries.length} journey entries.`);
  if (missing.length) console.log(`  ⚠ no local run file for: ${missing.join(", ")} (shown with DKG data only)`);
  console.log("Open it with:  open docs/index.html");
}

// ---------- the page ----------

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>ThreadBiz AI — pipeline replay</title>
<style>
:root{--bg:#f6f4ef;--card:#fff;--ink:#1d1b18;--muted:#6b665d;--line:#e3ded4;--accent:#b4532a;--ok:#2f7d4f;--okbg:#e5f3ea;--warn:#9a6a00;--warnbg:#fbf1d6;--bad:#b3261e;--badbg:#fbe4e2;--na:#5f6368;--nabg:#eceff1;--chip:#f1ede5}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#171513;--card:#211f1c;--ink:#f1ede6;--muted:#a59e92;--line:#35312b;--accent:#e08a5f;--ok:#7fd3a0;--okbg:#1f3a2a;--warn:#f0c35a;--warnbg:#3b3117;--bad:#ff8a80;--badbg:#3d1f1d;--na:#b0b5ba;--nabg:#2c2f33;--chip:#2b2824}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:30px;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:21px;margin:36px 0 12px}
h3{font-size:16px;margin:0 0 8px}
.sub{color:var(--muted);margin:0 0 18px}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 14px;min-width:120px}
.stat b{display:block;font-size:22px}
.stat span{color:var(--muted);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
img{max-width:100%;display:block;border-radius:10px}
.post img{aspect-ratio:4/3;object-fit:cover;width:100%}
.post .cap{font-style:italic;margin:10px 0 6px}
.meta{color:var(--muted);font-size:13px}
.chip{display:inline-block;background:var(--chip);border-radius:999px;padding:2px 9px;font-size:12px;margin:2px 4px 2px 0;white-space:nowrap}
.v{display:inline-block;border-radius:6px;padding:1px 7px;font-size:12px;font-weight:600;min-width:58px;text-align:center}
.v.yes{background:var(--okbg);color:var(--ok)}.v.partly{background:var(--warnbg);color:var(--warn)}.v.no{background:var(--badbg);color:var(--bad)}.v.unparseable,.v.error{background:var(--nabg);color:var(--na)}
.tl{display:flex;flex-direction:column;gap:10px}
.week{margin-top:18px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.06em;font-size:13px}
.run{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.run>button{all:unset;cursor:pointer;display:grid;grid-template-columns:92px 1fr auto;gap:14px;align-items:center;padding:12px 14px;width:100%;box-sizing:border-box}
.run>button:focus-visible{outline:2px solid var(--accent)}
.thumb{width:92px;height:69px;object-fit:cover;border-radius:8px;background:var(--chip)}
.run .title{font-weight:600}
.badge{font-size:12px;font-weight:700;border-radius:8px;padding:4px 9px;white-space:nowrap}
.badge.rej{background:var(--badbg);color:var(--bad)}.badge.app{background:var(--okbg);color:var(--ok)}
.flow{display:none;border-top:1px solid var(--line);padding:16px}
.run.open .flow{display:block}
.steps{display:flex;flex-direction:column;gap:0}
.step{display:grid;grid-template-columns:34px 1fr;gap:12px;position:relative;padding-bottom:18px}
.step:before{content:"";position:absolute;left:16px;top:30px;bottom:0;width:2px;background:var(--line)}
.step:last-child:before{display:none}
.dot{width:34px;height:34px;border-radius:50%;background:var(--chip);display:grid;place-items:center;font-size:16px;z-index:1}
.step h4{margin:5px 0 6px;font-size:14px}
.step .who{font-weight:400;color:var(--muted);font-size:12px;margin-left:6px}
.box{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.quote{font-style:italic}
.two{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:14px;align-items:start}
@media (max-width:760px){.two{grid-template-columns:1fr}.run>button{grid-template-columns:70px 1fr}.run>button .badge{grid-column:1/-1;justify-self:start}.thumb{width:70px;height:52px}}
.crit{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;align-items:start;font-size:13px}
.crit .id{font-weight:600}
.crit .why{color:var(--muted);grid-column:2}
.jgroup{margin-bottom:10px}
.jgroup h5{margin:0 0 6px;font-size:13px}
details summary{cursor:pointer;color:var(--muted);font-size:13px}
.lesson{border-left:4px solid var(--accent)}
.occ{font-size:13px;margin-top:8px;padding-top:8px;border-top:1px dashed var(--line)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.flowmap{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0 4px}
.flowmap .n{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:6px 10px;font-size:13px}
.flowmap .a{color:var(--muted)}
.note{font-size:13px;color:var(--muted)}
a{color:var(--accent)}
</style>
</head>
<body>
<div class="wrap" id="app"></div>
<script>
const DATA = __DATA__;
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const verdict = (v) => '<span class="v ' + esc(v) + '">' + esc(v === "unparseable" ? "unclear" : v) + "</span>";
const imgTag = (url, alt, cls) => url ? '<img loading="lazy" class="' + (cls || "") + '" src="' + esc(url) + '" alt="' + esc(alt) + '">' : "";
const JUDGE_NAMES = { "nemotron-omni-vision": "Image judge", "gemini-text": "Caption judge" };

function critList(report, filter) {
  if (!report) return "";
  if (report.status === "error") return '<div class="crit"><span class="v error">error</span><span>' + esc(report.error || "judge returned an unreadable answer") + "</span></div>";
  const items = report.criteria.filter(filter);
  if (!items.length) return "";
  return '<div class="crit">' + items.map((c) => verdict(c.verdict) + '<span class="id">' + esc(c.id) + '</span><span class="why">' + esc(c.reason) + (c.checkedBy === "code" ? " <span class=\"chip\">checked by code</span>" : "") + "</span>").join("") + "</div>";
}

function judgeBlock(j) {
  if (!j) return '<p class="note">No judging recorded.</p>';
  const isLesson = (c) => /^lesson-\d+$/.test(c.id);
  const parts = [];
  parts.push('<div class="jgroup"><h5>🖼️ Image judge <span class="who">' + esc(DATA.models.imageJudge) + "</span></h5>" + critList(j.image, () => true) + "</div>");
  parts.push('<div class="jgroup"><h5>✍️ Caption judge <span class="who">' + esc(DATA.models.captionJudge) + " + code checks</span></h5>" + critList(j.caption, (c) => !isLesson(c)) + "</div>");
  const lessonHtml = critList(j.caption, isLesson);
  if (lessonHtml) parts.push('<div class="jgroup"><h5>📌 One dedicated check per owner lesson <span class="who">' + esc(DATA.models.captionJudge) + "</span></h5>" + lessonHtml + "</div>");
  parts.push('<p><b>Round verdict:</b> ' + verdict(j.overall === "pass" ? "yes" : j.overall === "fail" ? "no" : "unparseable") + " " + esc(j.overall.toUpperCase()) + "</p>");
  return parts.join("");
}

function roundSteps(r, d, isFirst) {
  const out = [];
  if (!isFirst && r.trigger.length) {
    out.push(step("🔁", "Targeted revision", "only the failed parts are redone", '<div class="box">' + r.trigger.map((f) => '<div><span class="chip">' + esc(f.part) + "</span><b>" + esc(f.id) + "</b>: " + esc(f.reason) + "</div>").join("") + "</div>"));
  }
  const cited = r.lessonsCited.length ? '<p class="meta">Owner lessons the writer cited as applied: ' + r.lessonsCited.map((l) => '<span class="chip">' + esc(l) + "</span>").join("") + "</p>" : "";
  const kept = isFirst && d.captionKept ? '<p class="meta">Caption kept by the owner from an earlier run (still judged).</p>' : "";
  out.push(step("✍️", "Writer: caption + scene", DATA.models.writer + " on Livepeer",
    '<div class="box quote">"' + esc(r.caption) + '"</div>' + kept + cited +
    (r.ctaAddedByCode ? '<p class="meta">The closing pre-order sentence was added by code.</p>' : "") +
    '<details><summary>Scene description the writer produced</summary><p class="note">' + esc(r.scene) + "</p></details>"));
  const imgNote = r.image.reused ? "image " + r.image.reused + " (not regenerated)" : DATA.models.image + " on Livepeer" + (r.image.size ? " · " + r.image.size : "");
  out.push(step("🖼️", "Image", imgNote, r.image.url ? imgTag(r.image.url, "Round " + r.round + " image") : '<p class="note">No image recorded.</p>'));
  out.push(step("⚖️", "Judges", "round " + r.round, judgeBlock(r.judging)));
  return out.join("");
}

function step(icon, title, who, body) {
  return '<div class="step"><div class="dot">' + icon + '</div><div><h4>' + esc(title) + (who ? '<span class="who">' + esc(who) + "</span>" : "") + "</h4>" + body + "</div></div>";
}

function flowHtml(run) {
  const d = run.detail;
  const parts = [];
  if (!d) {
    parts.push('<p class="note">The detailed run file is not available here; this is what the DKG recorded.</p>');
  } else {
    const lessons = d.improvement && d.improvement.lessons.length
      ? d.improvement.lessons.map((l) => '<div><span class="chip">' + esc(l.id) + (l.count > 1 ? " · rejected " + l.count + "×" : "") + "</span>" + esc(l.rule) + "</div>").join("")
      : '<p class="note">' + (d.improvement ? "No lessons yet." : "This run predates Improvement Memory; no lessons were given to the writer.") + "</p>";
    parts.push(step("🗂️", "Inputs read from the DKG", "Shared Working Memory",
      '<div class="two"><div class="box"><p><b>Business Memory:</b> <span class="chip">' + esc(d.memory) + "</span></p>" +
      "<p><b>Journey entry:</b> <span class=\"chip\">" + esc(d.entry) + "</span>" + (d.entryPrivate ? " private voice note → the model only gets the owner-approved summary" : "") + "</p>" +
      "<p><b>This week's owner note:</b></p><p class=\"quote\">" + esc(d.ownerNote) + "</p></div>" +
      '<div class="box"><p><b>Improvement Memory:</b> <span class="chip">' + esc(d.improvement && d.improvement.asset ? d.improvement.asset : "none") + "</span></p>" + lessons + "</div></div>"));
    d.rounds.forEach((r, i) => parts.push(roundSteps(r, d, i === 0)));
  }
  if (run.outcome === "rejected" && run.lesson) {
    parts.push(step("🙋", "Owner: rejected", "one line, in the owner's own words",
      '<div class="box"><p class="quote">"' + esc(run.lesson.ownerReason) + '"</p>' + (d && d.owner.sameAs ? '<p class="meta">Marked as the same rule as ' + esc(d.owner.sameAs) + ".</p>" : "") + "</div>"));
    parts.push(step("🧠", "Written to the DKG", "Improvement Memory, Shared Working Memory",
      '<div class="box">Lesson <span class="chip">' + esc(run.lesson.id) + "</span> saved verbatim as <span class=\"chip\">" + esc(run.lesson.version || "the next improvement-memory version") + "</span>" +
      (d && d.owner.lessonWrite ? " · " + esc(d.owner.lessonWrite.triples) + " triples read back and verified" : "") +
      ". The candidate post draft was discarded; nothing unapproved was shared.</div>"));
  }
  if (run.outcome === "approved" && run.entry) {
    const e = run.entry;
    parts.push(step("🙋", "Owner: approved", d && d.owner.overrodeJudges ? "overriding the judges" : "", '<div class="box">' + (d && d.owner.overrodeJudges ? "The judges flagged issues; the owner checked them and approved anyway (recorded)." : "The owner approved the post.") + "</div>"));
    parts.push(step("🔗", "Written to the DKG", "Working Memory draft → Shared Working Memory",
      '<div class="box"><p><span class="chip">' + esc(e.asset) + "</span> status <b>" + esc(e.status) + "</b> · " + esc(e.triples) + " triples, read back and verified" + (e.replaces ? " · replaces " + esc(e.replaces) : "") + (e.replacedBy ? " · later replaced by " + esc(e.replacedBy) : "") + "</p>" +
      '<p class="meta">Built from: ' + esc(e.memoryVersionUsed) + " · image sha256 " + esc(e.imageSha256.slice(0, 16)) + "…</p>" +
      '<details><summary>Explainability stored with the entry</summary><p class="note">' + esc(e.explainability) + "</p></details></div>"));
  }
  return '<div class="steps">' + parts.join("") + "</div>";
}

function runCard(run) {
  const d = run.detail;
  const last = d && d.rounds.length ? d.rounds[d.rounds.length - 1] : null;
  const thumb = run.entry ? run.entry.image : run.lesson ? run.lesson.rejectedImage : last ? last.image.url : "";
  const caption = run.entry ? run.entry.caption : run.lesson ? run.lesson.rejectedCaption : last ? last.caption : "";
  const when = (d && d.createdAt ? d.createdAt : "").slice(11, 16);
  const badge = run.outcome === "approved"
    ? '<span class="badge app">Approved → ' + esc(run.entry.asset) + "</span>"
    : '<span class="badge rej">Rejected → ' + esc(run.lesson ? run.lesson.id : "lesson") + "</span>";
  const judges = d && d.final && d.final.outcome ? d.final.outcome.judges : "";
  return '<div class="run" id="' + esc(run.runId) + '"><button aria-expanded="false">' +
    (thumb ? '<img class="thumb" loading="lazy" src="' + esc(thumb) + '" alt="">' : '<div class="thumb"></div>') +
    '<div><div class="title">' + esc(caption.slice(0, 150)) + (caption.length > 150 ? "…" : "") + '</div><div class="meta">run ' + esc(run.runId) + (when ? " · " + when + " UTC" : "") + (judges ? " · judges: " + esc(judges) : "") + "</div></div>" +
    badge + '</button><div class="flow">' + flowHtml(run) + "</div></div>";
}

function render() {
  const approved = DATA.entries.filter((e) => !e.replacedBy);
  const weeks = [1, 2, 3];
  const weekTitle = { 1: "Week 1 · Vegetable & herb soup · cold start", 2: "Week 2 · Roast chicken · first customers (Maria, Dave)", 3: "Week 3 · Dumplings in broth · first supplier (Rosa)" };
  const html = [];
  html.push("<h1>ThreadBiz AI</h1>");
  html.push('<p class="sub">' + esc(DATA.business.name) + " · a social media agent that learns from the owner, with its memory on the OriginTrail DKG and its models on Livepeer. This page replays the real pipeline runs recorded in the DKG.</p>");
  html.push('<div class="flowmap"><span class="n">🗂️ DKG memory</span><span class="a">→</span><span class="n">✍️ Writer</span><span class="a">→</span><span class="n">🖼️ Image</span><span class="a">→</span><span class="n">⚖️ Judges</span><span class="a">→</span><span class="n">🔁 Revise once</span><span class="a">→</span><span class="n">🙋 Owner</span><span class="a">→</span><span class="n">🔗 DKG write</span></div>');
  const nRej = DATA.runs.filter((r) => r.outcome === "rejected").length;
  html.push('<div class="stats">' +
    '<div class="stat"><b>3</b><span>weeks</span></div>' +
    '<div class="stat"><b>' + DATA.runs.length + "</b><span>recorded runs</span></div>" +
    '<div class="stat"><b>' + nRej + "</b><span>owner rejections</span></div>" +
    '<div class="stat"><b>' + DATA.lessons.length + "</b><span>lessons learned</span></div>" +
    '<div class="stat"><b>' + approved.length + "</b><span>published posts</span></div>" +
    '<div class="stat"><b>' + DATA.manifest.length + "</b><span>Knowledge Assets</span></div></div>");

  html.push("<h2>Published posts</h2><div class=\"grid3\">" + approved.map((e) =>
    '<div class="card post">' + imgTag(e.image, e.title) + '<p class="cap">"' + esc(e.caption) + '"</p><p class="meta"><span class="chip">' + esc(e.asset) + "</span>" + esc(e.title) + (e.replaces ? " · replaces " + esc(e.replaces) : "") + '</p><p class="meta"><a href="#' + esc(e.runId) + '" data-open="' + esc(e.runId) + '">See how it was made →</a></p></div>').join("") + "</div>");

  html.push("<h2>Every run, step by step</h2><p class=\"note\">Click a run to open its full flow. Rejections turned into lessons; each later run was written and judged with every lesson in force.</p><div class=\"tl\">");
  for (const w of weeks) {
    const rs = DATA.runs.filter((r) => r.week === w);
    if (!rs.length) continue;
    html.push('<div class="week">' + esc(weekTitle[w]) + "</div>" + rs.map(runCard).join(""));
  }
  html.push("</div>");

  html.push("<h2>What the owner taught it</h2><div class=\"grid3\">" + DATA.lessons.map((l) =>
    '<div class="card lesson"><h3>' + esc(l.id) + (l.occurrenceCount > 1 ? ' <span class="chip">rejected ' + l.occurrenceCount + "×</span>" : "") + '</h3><p class="quote">"' + esc(l.rule) + '"</p>' +
    l.occurrences.map((o) => '<div class="occ"><div class="meta">' + esc(o.recordedAt.slice(0, 16).replace("T", " ")) + ' UTC · <a href="#' + esc(o.runId) + '" data-open="' + esc(o.runId) + '">run ' + esc(o.runId) + "</a></div>" +
      (o.ownerReason !== l.rule ? '<div>Owner said: <i>"' + esc(o.ownerReason) + '"</i></div>' : "") +
      '<div class="note">Rejected caption: "' + esc(o.rejectedCaption) + '"</div></div>').join("") + "</div>").join("") + "</div>");

  html.push("<h2>Improvement Memory versions</h2><div class=\"card scroll\"><table><thead><tr><th>Knowledge Asset</th><th>Triples</th><th>Change</th></tr></thead><tbody>" +
    DATA.improvementVersions.map((v) => "<tr><td><span class=\"chip\">" + esc(v.name) + "</span></td><td>" + esc(v.triples) + "</td><td>" + esc(v.changeNote) + "</td></tr>").join("") + "</tbody></table></div>");

  html.push("<h2>Knowledge Assets in the DKG</h2><div class=\"card scroll\"><table><thead><tr><th>Asset</th><th>Context graph</th><th>Triples</th></tr></thead><tbody>" +
    DATA.manifest.map((a) => "<tr><td>" + esc(a.name) + "</td><td>" + esc(a.graph === "main" ? "threadbiz-main" : "threadbiz-journey") + "</td><td>" + esc(a.triples) + "</td></tr>").join("") + "</tbody></table></div>");

  html.push('<p class="note" style="margin-top:28px">Generated ' + esc(DATA.generatedAt.slice(0, 16).replace("T", " ")) + " UTC from the DKG snapshot and the local run files. Models: " + esc(DATA.models.writer) + ", " + esc(DATA.models.image) + ", " + esc(DATA.models.imageJudge) + " via the Livepeer Agent. Prompts, raw model responses and private voice-note text are not included.</p>");
  $("#app").innerHTML = html.join("");

  document.querySelectorAll(".run > button").forEach((b) => b.addEventListener("click", () => {
    const run = b.parentElement;
    run.classList.toggle("open");
    b.setAttribute("aria-expanded", run.classList.contains("open") ? "true" : "false");
  }));
  document.querySelectorAll("[data-open]").forEach((a) => a.addEventListener("click", () => {
    const run = document.getElementById(a.getAttribute("data-open"));
    if (run && !run.classList.contains("open")) { run.classList.add("open"); run.querySelector("button").setAttribute("aria-expanded", "true"); }
  }));
  if (location.hash) {
    const run = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (run) { run.classList.add("open"); run.scrollIntoView(); }
  }
}
render();
</script>
</body>
</html>
`;

build();
