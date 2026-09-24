import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { ROOT, settings } from "./config.ts";
import { loadBusinessMemory, loadJourneyEntry, type LoadedEntry, type LoadedMemory } from "./memory.ts";
import { withPhotoStyle, writeBrief, type Brief, type BriefResult, type Revision } from "./brief.ts";
import { generateImage, imageSize, rawLog } from "./livepeer.ts";
import { collectFailures, judgeCaption, judgeImage, overallVerdict, type JudgeReport } from "./judge.ts";

/*
 * Usage:
 *   npm run week -- --memory business-memory-v1 --journey journey-001 --entry entry-000 \
 *     --note "This week's first drop: ..." [--stop-after memory|brief] [--no-retry]
 *     [--decision approve|reject --reason "..."]   (skips the interactive owner prompt, e.g. for scripted demos)
 *
 * Flow: read memory + entry from the DKG -> write brief -> generate image -> judge.
 * On a FAIL, one targeted revision: only the failed part is redone, using the judge's reasons,
 * and the whole result is judged again. Still read-only on the DKG (writes come in slice 2).
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

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
const runId = `${args.entry}-${stamp}`;
const sessionId = `threadbiz-${runId}`.replace(/[^A-Za-z0-9_-]/g, "-");
const runsDir = path.join(ROOT, "runs");
const run: Record<string, any> = { runId, sessionId, createdAt: new Date().toISOString(), dkgWrites: "none (read-only run)" };
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
  return { ...image, sceneFromWriter: scene, finalPrompt: prompt, size, sizeMatchesExpected, localBackup: `runs/images/${file}` };
}
type ImageRecord = Awaited<ReturnType<typeof makeImage>>;

async function judgeBoth(round: number, image: ImageRecord, brief: Brief, mem: LoadedMemory, input: LoadedEntry) {
  const [imageReport, captionReport] = await step(`round ${round}: judge image + caption`, () =>
    Promise.all([
      judgeImage(image.url, brief, ownerNote, sessionId),
      judgeCaption(brief, mem, input, ownerNote, sessionId),
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
 * A rejection reason is saved as a CANDIDATE lesson for Improvement Memory (owner-sourced feedback).
 */
async function askOwner(final: { verdict: string; brief: Brief; image: { url: string } }) {
  console.log("\n=== OWNER REVIEW ===");
  console.log(`Judges' verdict: ${final.verdict.toUpperCase()}${final.verdict === "pass" ? "" : " (the judges flagged issues above; you still have the final say)"}`);
  console.log(`Caption: ${final.brief.caption}`);
  console.log(`Image:   ${final.image.url}`);

  let choice = (args.decision ?? "").toLowerCase();
  let reason = args.reason ?? "";
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
      while (!reason.trim()) reason = await rl.question("In one line, why? (this becomes a candidate lesson): ");
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
  console.log(`\nOWNER: REJECTED — saved as a candidate lesson: "${candidateLesson.lesson}"`);
  return { decision: "rejected", decidedAt, reason: reason.trim(), candidateLesson };
}

async function main() {
  const [mem, input] = await step(`read ${args.memory} + ${args.entry} from DKG (in parallel)`, () =>
    Promise.all([loadBusinessMemory(args.memory), loadJourneyEntry(args.journey, args.entry)])
  );
  run.inputs = {
    memory: { asset: mem.asset.name, kaNumber: mem.asset.kaNumber, graph: mem.asset.graph, triples: mem.asset.tripleCount },
    entry: { id: args.entry, journeyAsset: input.asset.name, kaNumber: input.asset.kaNumber, isPrivate: input.isPrivate },
    ownerNote,
  };
  run.memorySnapshot = mem.memory;
  console.log(`\nMemory ${mem.asset.name}: ${mem.asset.tripleCount} triples from KA #${mem.asset.kaNumber}`);
  console.log(`Entry ${args.entry}: ${input.isPrivate ? "PRIVATE" : "public"}, ${input.text.length} chars`);
  if (stopAfter === "memory") {
    console.log("\n" + JSON.stringify({ memory: mem.memory, entry: input.isPrivate ? { ...input.entry, sourceReference: "[PRIVATE, not printed]" } : input.entry }, null, 2));
    return save();
  }

  // ---- Round 1 ----
  console.log("\n=== ROUND 1 ===");
  const brief1: BriefResult = await step(`round 1: write brief with ${settings.livepeer.writer}`, () => writeBrief(mem, input, ownerNote, sessionId, 1));
  totalCost += brief1.cost;
  printBrief(brief1.brief);
  if (brief1.ctaAddedByCode) console.log("  (writer omitted an invitation to order; code appended the fixed pre-order sentence)");
  run.rounds = [{ round: 1, brief: brief1 }];
  if (stopAfter === "brief") return save();

  const image1 = await makeImage(brief1.brief.imagePrompt, 1);
  const judging1 = await judgeBoth(1, image1, brief1.brief, mem, input);
  Object.assign(run.rounds[0], { image: image1, judging: judging1 });

  let final = { round: 1, brief: brief1.brief, image: image1, verdict: judging1.overall, imageFromRound: 1 };

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

    const brief2 = await step(`round 2: revise with ${settings.livepeer.writer}`, () => writeBrief(mem, input, ownerNote, sessionId, 2, revision));
    totalCost += brief2.cost;
    printBrief(brief2.brief);
    if (brief2.ctaAddedByCode) console.log("  (writer omitted an invitation to order; code appended the fixed pre-order sentence)");
    const image2 = revision.imagePromptMayChange ? await makeImage(brief2.brief.imagePrompt, 2) : image1;
    if (!revision.imagePromptMayChange) console.log("\n  (image kept from round 1: no image criteria failed, so it is not regenerated)");
    // Re-judge everything: an edit can break something that passed, and a new caption must still match the image.
    const judging2 = await judgeBoth(2, image2, brief2.brief, mem, input);

    run.rounds.push({
      round: 2,
      trigger: failures,
      changed: {
        caption: brief2.brief.caption !== brief1.brief.caption,
        imagePrompt: brief2.brief.imagePrompt !== brief1.brief.imagePrompt,
        imageRegenerated: revision.imagePromptMayChange,
      },
      brief: brief2,
      image: revision.imagePromptMayChange ? image2 : { reusedFromRound: 1, url: image1.url },
      judging: judging2,
    });
    final = { round: 2, brief: brief2.brief, image: image2, verdict: judging2.overall, imageFromRound: revision.imagePromptMayChange ? 2 : 1 };
  } else if (judging1.overall === "incomplete") {
    console.log("\n  No automatic revision: a judge errored or gave an unreadable answer, so there is no reliable feedback to act on.");
  }

  run.final = {
    verdict: final.verdict,
    decidedInRound: final.round,
    caption: final.brief.caption,
    imageUrl: final.image.url,
    imageFromRound: final.imageFromRound,
    needsOwnerReview: final.verdict !== "pass",
  };
  run.ownerDecision = await askOwner(final);
  const judgesText =
    final.verdict === "pass"
      ? final.round === 1 ? "PASS on the first attempt" : "PASS after one targeted revision"
      : final.verdict === "fail" ? "FAIL after one revision" : "INCOMPLETE";
  const d = run.ownerDecision.decision;
  const ownerText = d === "approved" ? `APPROVED${final.verdict !== "pass" ? " (overriding the judges)" : ""}` : d === "rejected" ? "REJECTED (reason saved as a candidate lesson)" : "UNDECIDED";
  run.final.outcome = { judges: judgesText, owner: ownerText };
  console.log(`\nFINAL — Judges: ${judgesText} · Owner: ${ownerText}   estimated cost $${totalCost.toFixed(4)}`);
  save();
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`);
  run.error = err.message;
  save();
  process.exit(1);
});
