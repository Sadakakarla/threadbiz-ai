import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { ROOT, settings } from "./config.ts";
import { loadBusinessMemory, loadJourneyEntry, type LoadedEntry, type LoadedMemory } from "./memory.ts";
import { citedLessons, withPhotoStyle, writeBrief, type Brief, type BriefResult, type Revision } from "./brief.ts";
import { generateImage, imageSize, rawLog } from "./livepeer.ts";
import { collectFailures, judgeCaption, judgeImage, overallVerdict, type JudgeReport } from "./judge.ts";
import { activeLessons, loadImprovementMemory, recordLesson, type Lesson, type LoadedImprovement } from "./improvement.ts";
import { approveEntry, explain, planEntry, rejectEntry, stageCandidate, type EntryPlan } from "./journey.ts";

/*
 * Usage:
 *   npm run week -- --memory business-memory-v1 --journey journey-001 --entry entry-000 \
 *     --note "This week's first drop: ..." [--title "Week 1: Vegetable & Herb Soup"] [--replaces entry-001] \
 *     [--improvement latest|none|improvement-memory-v1] [--stop-after memory|brief] [--no-retry] [--no-dkg-write] \
 *     [--decision approve|reject --reason "..." [--same-as lesson-001]]   (skips the interactive owner prompt)
 *
 * Flow: read Business Memory + the journey entry + the latest Improvement Memory from the DKG -> write brief
 * (following the owner's lessons) -> generate image -> judge (including one dedicated check per lesson).
 * On a FAIL, one targeted revision. Then the owner decides:
 *   approve -> the post is written to the DKG as its own sealed journey entry (candidate draft -> confirmed, shared)
 *   reject  -> the draft is discarded and the owner's reason becomes the next Improvement Memory version.
 * --no-dkg-write keeps the whole run read-only (no candidate draft, no lesson, no entry).
 */

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    out[key] = next !== undefined && !next.startsWith("--") ? argv[++i] : "true";
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
for (const required of ["memory", "journey", "entry"]) {
  if (!args[required]) {
    console.error(`Missing --${required}. See usage at the top of src/run.ts`);
    process.exit(1);
  }
}
const ownerNote = args.note ?? "";
const stopAfter = args["stop-after"];
const allowRetry = args["no-retry"] !== "true";
const writesEnabled = args["no-dkg-write"] !== "true";

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
const runId = `${args.entry}-${stamp}`;
const sessionId = `threadbiz-${runId}`.replace(/[^A-Za-z0-9_-]/g, "-");
const runsDir = path.join(ROOT, "runs");
const run: Record<string, any> = {
  runId,
  sessionId,
  createdAt: new Date().toISOString(),
  dkgWrites: writesEnabled ? { enabled: true } : { enabled: false, note: "--no-dkg-write: read-only run" },
};
const timings: Record<string, number> = {};
let totalCost = 0;

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  process.stdout.write(`→ ${name}... `);
  try {
    const result = await fn();
    timings[name] = (Date.now() - t0) / 1000;
    console.log(`done (${timings[name].toFixed(1)}s)`);
    return result;
  } catch (err) {
    console.log("FAILED");
    throw err;
  }
}

function save() {
  mkdirSync(path.join(runsDir, "raw"), { recursive: true });
  run.timingsSeconds = timings;
  run.costUsdEstimated = Number(totalCost.toFixed(5));
  writeFileSync(path.join(runsDir, `${runId}.json`), JSON.stringify(run, null, 2));
  writeFileSync(path.join(runsDir, "raw", `${runId}.livepeer.json`), JSON.stringify(rawLog, null, 2));
  console.log(`\nRun file: runs/${runId}.json   (raw Livepeer responses: runs/raw/${runId}.livepeer.json)`);
}

function printReport(r: JudgeReport) {
  console.log(`\n  Judge: ${r.judge} (${r.status})${r.error ? ` — ${r.error}` : ""}`);
  for (const c of r.criteria) console.log(`   [${c.verdict.toUpperCase().padEnd(6)}] ${c.id}: ${c.reason}`);
}

function printBrief(b: Brief) {
  console.log(`\nCAPTION:\n  ${b.caption}\n\nIMAGE PROMPT (scene by writer + fixed photo style):\n  ${withPhotoStyle(b.imagePrompt)}\n\nMEMORY FACTS USED:`);
  for (const f of b.memoryFactsUsed) console.log(`  - ${f.field}: ${f.how}`);
}

async function makeImage(scene: string, round: number) {
  const prompt = withPhotoStyle(scene);
  const image = await step(`round ${round}: generate image with ${settings.livepeer.imageModel}`, () =>
    generateImage(`image:round${round}`, prompt, sessionId, `${sessionId}-image-r${round}`)
  );
  totalCost += image.cost;
  const bytes = Buffer.from(await (await fetch(image.url)).arrayBuffer());
  const size = imageSize(bytes);
  const expected = settings.livepeer.expectedImageSize;
  const ext = size?.format === "jpeg" ? "jpg" : size?.format ?? "bin";
  const file = `${runId}-r${round}.${ext}`;
  mkdirSync(path.join(runsDir, "images"), { recursive: true });
  writeFileSync(path.join(runsDir, "images", file), bytes);
  const sizeMatchesExpected = !!size && size.width === expected.width && size.height === expected.height;
  console.log(`\nIMAGE: ${image.url}`);
  console.log(`  requested ${image.requestedCapability}, ran ${image.capabilityThatRan} (${image.providerModel ?? "provider model not reported"})`);
  console.log(`  size ${size ? `${size.width}x${size.height} ${size.format}` : "unknown"}${sizeMatchesExpected ? "" : `  ⚠ expected ${expected.width}x${expected.height}`}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { ...image, sceneFromWriter: scene, finalPrompt: prompt, size, sizeMatchesExpected, sha256, localBackup: `runs/images/${file}` };
}
type ImageRecord = Awaited<ReturnType<typeof makeImage>>;

async function judgeBoth(round: number, image: ImageRecord, brief: Brief, mem: LoadedMemory, input: LoadedEntry, lessons: Lesson[]) {
  const [imageReport, captionReport] = await step(`round ${round}: judge image + caption`, () =>
    Promise.all([
      judgeImage(image.url, brief, ownerNote, sessionId),
      judgeCaption(brief, mem, input, ownerNote, sessionId, lessons),
    ])
  );
  totalCost += imageReport.cost + captionReport.cost;
  printReport(imageReport);
  printReport(captionReport);
  const verdict = overallVerdict([imageReport, captionReport]);
  console.log(`\n  ROUND ${round}: ${verdict.toUpperCase()}`);
  return { image: imageReport, caption: captionReport, overall: verdict };
}

/**
 * The owner has the final say. Approve, or reject with a one-line reason.
 * A rejection reason is the owner's own words: it is written verbatim, as a confirmed lesson, to the next
 * Improvement Memory version (see recordLesson). If it is the same rule as an existing lesson, the owner says so
 * (--same-as lesson-001, or the interactive question) and that lesson's recurrence count goes up instead.
 */
async function askOwner(final: { verdict: string; brief: Brief; image: { url: string } }, improvement: LoadedImprovement) {
  console.log("\n=== OWNER REVIEW ===");
  console.log(`Judges' verdict: ${final.verdict.toUpperCase()}${final.verdict === "pass" ? "" : " (the judges flagged issues above; you still have the final say)"}`);
  console.log(`Caption: ${final.brief.caption}`);
  console.log(`Image:   ${final.image.url}`);

  let choice = (args.decision ?? "").toLowerCase();
  let reason = args.reason ?? "";
  let sameAs = args["same-as"] ?? "";
  if (!choice) {
    if (!process.stdin.isTTY) {
      console.log("No interactive terminal and no --decision given: leaving the post undecided.");
      return { decision: "undecided" };
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    while (!["a", "approve", "r", "reject"].includes(choice)) {
      choice = (await rl.question("\nApprove this post? Type a (approve) or r (reject): ")).trim().toLowerCase();
    }
    if (choice.startsWith("r")) {
      while (!reason.trim()) reason = await rl.question("In one line, why? (this becomes a lesson in Improvement Memory): ");
      const known = improvement.mode === "none" ? (await loadImprovementMemory("latest").catch(() => improvement)).lessons : improvement.lessons;
      const ids = activeLessons(known).map((l) => l.id);
      while (ids.length && !sameAs) {
        const answer = (await rl.question(`Is this the same rule as an existing lesson? Type its id (${ids.join(", ")}) or press Enter for a new lesson: `)).trim();
        if (!answer) break;
        if (ids.includes(answer)) sameAs = answer;
        else console.log(`  "${answer}" is not one of: ${ids.join(", ")}`);
      }
    }
    rl.close();
  }
  const decidedAt = new Date().toISOString();
  if (choice.startsWith("a")) {
    console.log(`\nOWNER: APPROVED${final.verdict !== "pass" ? " (overriding the judges)" : ""}`);
    return { decision: "approved", decidedAt, overrodeJudges: final.verdict !== "pass" };
  }
  if (!reason.trim()) throw new Error("A rejection needs a reason (use --reason when passing --decision reject).");
  const candidateLesson = {
    status: "candidate",
    source: "owner-rejection",
    lesson: reason.trim(),
    context: { runId, rejectedCaption: final.brief.caption, rejectedImage: final.image.url },
    recordedAt: decidedAt,
  };
  console.log(`\nOWNER: REJECTED — lesson: "${candidateLesson.lesson}"${sameAs ? ` (same rule as ${sameAs})` : ""}`);
  return { decision: "rejected", decidedAt, reason: reason.trim(), sameAs: sameAs || undefined, candidateLesson };
}

function printLessonUse(result: BriefResult, lessons: Lesson[]) {
  if (!lessons.length) return;
  const cited = citedLessons(result.brief, lessons);
  console.log(`\nOWNER LESSONS GIVEN TO THE WRITER: ${lessons.map((l) => l.id).join(", ")}`);
  console.log(`  cited by the writer as applied: ${cited.length ? cited.join(", ") : "(none)"}`);
  if (result.lessonCitationMissing.length) console.log(`  ⚠ writer never cited: ${result.lessonCitationMissing.join(", ")} (recorded in the run file)`);
}

async function main() {
  const [mem, input, improvement] = await step(`read ${args.memory} + ${args.entry} + improvement memory from DKG (in parallel)`, () =>
    Promise.all([loadBusinessMemory(args.memory), loadJourneyEntry(args.journey, args.entry), loadImprovementMemory(args.improvement ?? "latest")])
  );
  const lessons = activeLessons(improvement.lessons);
  run.inputs = {
    memory: { asset: mem.asset.name, kaNumber: mem.asset.kaNumber, graph: mem.asset.graph, triples: mem.asset.tripleCount },
    entry: { id: args.entry, journeyAsset: input.asset.name, kaNumber: input.asset.kaNumber, isPrivate: input.isPrivate },
    improvementMemory: {
      mode: improvement.mode,
      asset: improvement.asset
        ? { name: improvement.asset.name, kaNumber: improvement.asset.kaNumber, graph: improvement.asset.graph, triples: improvement.asset.tripleCount, version: improvement.version }
        : null,
      lessonsGivenToWriterAndJudge: lessons.map((l) => ({ id: l.id, rule: l.rule, occurrenceCount: l.occurrenceCount })),
    },
    ownerNote,
  };
  run.memorySnapshot = mem.memory;
  console.log(`\nMemory ${mem.asset.name}: ${mem.asset.tripleCount} triples from KA #${mem.asset.kaNumber}`);
  console.log(`Entry ${args.entry}: ${input.isPrivate ? "PRIVATE" : "public"}, ${input.text.length} chars`);
  if (improvement.asset) {
    console.log(`Improvement memory ${improvement.asset.name}: ${improvement.asset.tripleCount} triples from KA #${improvement.asset.kaNumber}, ${lessons.length} lesson(s) in force`);
    for (const l of lessons) console.log(`  - ${l.id}${l.occurrenceCount > 1 ? ` (rejected ${l.occurrenceCount}x)` : ""}: ${l.rule}`);
  } else {
    console.log(`Improvement memory: ${improvement.mode === "none" ? "switched off (--improvement none)" : "none yet (no lessons recorded)"}`);
  }
  if (stopAfter === "memory") {
    console.log("\n" + JSON.stringify({ memory: mem.memory, improvementLessons: lessons, entry: input.isPrivate ? { ...input.entry, sourceReference: "[PRIVATE, not printed]" } : input.entry }, null, 2));
    return save();
  }

  // ---- Round 1 ----
  console.log("\n=== ROUND 1 ===");
  const brief1: BriefResult = await step(`round 1: write brief with ${settings.livepeer.writer}`, () => writeBrief(mem, input, ownerNote, lessons, sessionId, 1));
  totalCost += brief1.cost;
  printBrief(brief1.brief);
  printLessonUse(brief1, lessons);
  if (brief1.ctaAddedByCode) console.log("  (writer omitted an invitation to order; code appended the fixed pre-order sentence)");
  run.rounds = [{ round: 1, brief: brief1, lessonsCitedByWriter: citedLessons(brief1.brief, lessons) }];
  if (stopAfter === "brief") return save();

  const image1 = await makeImage(brief1.brief.imagePrompt, 1);
  const judging1 = await judgeBoth(1, image1, brief1.brief, mem, input, lessons);
  Object.assign(run.rounds[0], { image: image1, judging: judging1 });

  let final = { round: 1, brief: brief1.brief, image: image1, verdict: judging1.overall, imageFromRound: 1 };
  let finalBrief: BriefResult = brief1;

  // ---- Round 2: one targeted revision, only on a clear FAIL ----
  const failures = collectFailures(judging1.image, judging1.caption);
  if (judging1.overall === "fail" && allowRetry && failures.length) {
    const revision: Revision = {
      previous: brief1.brief,
      failures,
      captionMayChange: failures.some((f) => f.part === "caption"),
      imagePromptMayChange: failures.some((f) => f.part === "image"),
    };
    const redo = [revision.captionMayChange && "caption", revision.imagePromptMayChange && "image"].filter(Boolean).join(" + ");
    console.log(`\n=== ROUND 2: targeted revision of ${redo} ===`);
    for (const f of failures) console.log(`  feedback [${f.part}] ${f.id}: ${f.reason}`);

    const brief2 = await step(`round 2: revise with ${settings.livepeer.writer}`, () => writeBrief(mem, input, ownerNote, lessons, sessionId, 2, revision));
    totalCost += brief2.cost;
    printBrief(brief2.brief);
    printLessonUse(brief2, lessons);
    if (brief2.ctaAddedByCode) console.log("  (writer omitted an invitation to order; code appended the fixed pre-order sentence)");
    const image2 = revision.imagePromptMayChange ? await makeImage(brief2.brief.imagePrompt, 2) : image1;
    if (!revision.imagePromptMayChange) console.log("\n  (image kept from round 1: no image criteria failed, so it is not regenerated)");
    // Re-judge everything: an edit can break something that passed, and a new caption must still match the image.
    const judging2 = await judgeBoth(2, image2, brief2.brief, mem, input, lessons);

    run.rounds.push({
      round: 2,
      trigger: failures,
      changed: {
        caption: brief2.brief.caption !== brief1.brief.caption,
        imagePrompt: brief2.brief.imagePrompt !== brief1.brief.imagePrompt,
        imageRegenerated: revision.imagePromptMayChange,
      },
      brief: brief2,
      lessonsCitedByWriter: citedLessons(brief2.brief, lessons),
      image: revision.imagePromptMayChange ? image2 : { reusedFromRound: 1, url: image1.url },
      judging: judging2,
    });
    final = { round: 2, brief: brief2.brief, image: image2, verdict: judging2.overall, imageFromRound: revision.imagePromptMayChange ? 2 : 1 };
    finalBrief = brief2;
  } else if (judging1.overall === "incomplete") {
    console.log("\n  No automatic revision: a judge errored or gave an unreadable answer, so there is no reliable feedback to act on.");
  }

  const judgesText =
    final.verdict === "pass"
      ? final.round === 1 ? "PASS on the first attempt" : "PASS after one targeted revision"
      : final.verdict === "fail" ? (final.round === 2 ? "FAIL after one revision" : "FAIL (no revision attempted)") : "INCOMPLETE";
  run.final = {
    verdict: final.verdict,
    decidedInRound: final.round,
    caption: final.brief.caption,
    imageUrl: final.image.url,
    imageFromRound: final.imageFromRound,
    lessonsCitedByWriter: citedLessons(final.brief, lessons),
    needsOwnerReview: final.verdict !== "pass",
  };

  // ---- Candidate draft in Working Memory, BEFORE the owner reviews (nothing is shared yet) ----
  let plan: EntryPlan | null = null;
  if (writesEnabled) {
    try {
      const cited = citedLessons(final.brief, lessons);
      plan = await step("plan the journey entry (next entry id from the DKG)", () =>
        planEntry({
          title: args.title ?? `Weekly post generated from ${args.entry}`,
          caption: final.brief.caption,
          imageUrl: final.image.url,
          imageSha256: final.image.sha256,
          memoryVersionUsed: [mem.asset.name, args.entry, improvement.asset?.name].filter(Boolean).join(", "),
          explainability: explain({
            memoryAsset: mem.asset.name,
            entryRef: args.entry,
            improvementAsset: improvement.asset?.name ?? null,
            lessonsCited: cited,
            memoryFieldsUsed: [...new Set(final.brief.memoryFactsUsed.map((f) => String(f.field)).filter((f) => !f.startsWith("improvement-memory:")))],
            rounds: final.round,
            judgeOutcome: judgesText,
            ctaAddedByCode: finalBrief.ctaAddedByCode,
          }),
          runId,
          judgeOutcome: judgesText,
          recordedOn: new Date().toISOString().slice(0, 10),
          replaces: args.replaces,
        })
      );
      run.journeyEntryPlan = plan;
      const staged = await step(`create candidate draft ${plan.assetName} in Working Memory (private, not shared)`, () => stageCandidate(plan!));
      run.dkgWrites.candidate = { asset: plan.assetName, entryId: plan.entryId, kaNumber: staged.kaNumber, status: staged.status };
    } catch (err: any) {
      console.log(`\n  ⚠ Could not stage the candidate entry: ${err.message}`);
      run.dkgWrites.candidateError = err.message;
    }
  }

  // ---- Owner decides ----
  run.ownerDecision = await askOwner(final, improvement);
  const d = run.ownerDecision.decision;
  let dkgText = writesEnabled ? "" : "read-only (--no-dkg-write)";

  if (writesEnabled && d === "approved") {
    if (!plan) {
      run.dkgWrites.entry = { error: "no entry plan was created, so nothing was written" };
      dkgText = "entry NOT written (see run file)";
    } else {
      try {
        const written = await step(`write confirmed ${plan.assetName} (discard draft, create --share, read back)`, () => approveEntry(plan!));
        run.dkgWrites.entry = written;
        dkgText = `${written.assetName} confirmed & shared (${written.triples} triples verified, KA #${written.kaNumber})`;
      } catch (err: any) {
        run.dkgWrites.entry = { error: err.message };
        dkgText = "entry NOT written";
        console.log(`\n  ⚠ Writing ${plan.assetName} failed: ${err.message}\n  Your approval is saved in the run file. Retry with:\n    npm run writeback -- entry --from-run ${runId}`);
      }
    }
  }

  if (writesEnabled && d === "rejected") {
    if (plan) run.dkgWrites.candidateDiscarded = await rejectEntry(plan);
    const cl = run.ownerDecision.candidateLesson;
    try {
      const w = await step("record the owner's lesson in Improvement Memory (create --share, read back)", () =>
        recordLesson({
          reason: cl.lesson,
          runId,
          rejectedCaption: cl.context.rejectedCaption,
          rejectedImage: cl.context.rejectedImage,
          recordedAt: cl.recordedAt,
          sameAs: run.ownerDecision.sameAs,
        })
      );
      run.ownerDecision.lessonWrite = w;
      dkgText = `${w.lessonId} saved to ${w.assetName} (${w.triples} triples verified, KA #${w.kaNumber}${w.newLesson ? "" : `, now rejected ${w.occurrenceCount}x`})`;
    } catch (err: any) {
      run.ownerDecision.lessonWrite = { error: err.message };
      dkgText = "lesson NOT written";
      console.log(`\n  ⚠ Recording the lesson failed: ${err.message}\n  Your reason is saved in the run file. Retry with:\n    npm run writeback -- lesson --from-run ${runId}${run.ownerDecision.sameAs ? ` --same-as ${run.ownerDecision.sameAs}` : ""}`);
    }
  }

  if (writesEnabled && d === "undecided" && plan) dkgText = `candidate draft ${plan.assetName} left in Working Memory (undecided)`;

  const lw = run.ownerDecision.lessonWrite;
  const ownerText =
    d === "approved"
      ? `APPROVED${final.verdict !== "pass" ? " (overriding the judges)" : ""}`
      : d === "rejected"
        ? lw && !lw.error ? `REJECTED (lesson ${lw.lessonId} saved to ${lw.assetName})` : writesEnabled ? "REJECTED (lesson NOT saved to the DKG; see run file)" : "REJECTED (reason saved in the run file only)"
        : "UNDECIDED";
  run.final.outcome = { judges: judgesText, owner: ownerText, dkg: dkgText };
  console.log(`\nFINAL — Judges: ${judgesText} · Owner: ${ownerText}${dkgText ? ` · DKG: ${dkgText}` : ""}   estimated cost $${totalCost.toFixed(4)}`);
  save();
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`);
  run.error = err.message;
  save();
  process.exit(1);
});
