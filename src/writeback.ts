import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./config.ts";
import { recordLesson } from "./improvement.ts";
import { approveEntry, type EntryPlan } from "./journey.ts";

/*
 * Writes an owner decision from a SAVED run file to the DKG. Use it when a run's automatic write failed,
 * or to record the two rejections that were saved before lessons were written automatically.
 *
 *   npm run writeback -- lesson --from-run <runId> [--same-as lesson-001]
 *       Records the owner's rejection reason (verbatim, confirmed) as the next improvement-memory version.
 *   npm run writeback -- entry --from-run <runId>
 *       Writes an APPROVED post as its own confirmed, shared journey entry (from the plan saved in the run file).
 */

const argv = process.argv.slice(2);
const command = argv[0];
const args: Record<string, string> = {};
for (let i = 1; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) continue;
  const next = argv[i + 1];
  args[argv[i].slice(2)] = next !== undefined && !next.startsWith("--") ? argv[++i] : "true";
}

function usage(): never {
  console.error("Usage:\n  npm run writeback -- lesson --from-run <runId> [--same-as lesson-001]\n  npm run writeback -- entry --from-run <runId>");
  process.exit(1);
}
if ((command !== "lesson" && command !== "entry") || !args["from-run"]) usage();

const runId = path.basename(args["from-run"]).replace(/\.json$/, "");
const runFile = path.join(ROOT, "runs", `${runId}.json`);
if (!existsSync(runFile)) {
  console.error(`No run file at runs/${runId}.json`);
  process.exit(1);
}
const run = JSON.parse(readFileSync(runFile, "utf8"));
const save = () => writeFileSync(runFile, JSON.stringify(run, null, 2));

async function main() {
  if (command === "lesson") {
    const od = run.ownerDecision;
    const cl = od?.candidateLesson;
    if (od?.decision !== "rejected" || !cl?.lesson) throw new Error(`${runId} was not rejected by the owner, so it has no lesson to record`);
    if (od.lessonWrite && !od.lessonWrite.error) throw new Error(`${runId}: lesson already written (${od.lessonWrite.lessonId} in ${od.lessonWrite.assetName})`);
    const sameAs = args["same-as"] ?? od.sameAs;
    console.log(`Recording the owner's lesson from ${runId}${sameAs ? ` as another occurrence of ${sameAs}` : " as a new lesson"}:\n  "${cl.lesson}"`);
    const w = await recordLesson({
      reason: cl.lesson,
      runId,
      rejectedCaption: cl.context?.rejectedCaption ?? "",
      rejectedImage: cl.context?.rejectedImage ?? "",
      recordedAt: cl.recordedAt,
      sameAs,
    });
    od.lessonWrite = w;
    if (sameAs) od.sameAs = sameAs;
    if (run.final?.outcome) run.final.outcome.owner = `REJECTED (lesson ${w.lessonId} saved to ${w.assetName})`;
    save();
    console.log(`\nDONE: ${w.lessonId} is now in ${w.assetName} (KA #${w.kaNumber}, ${w.triples} triples read back and verified${w.newLesson ? "" : `, rejected ${w.occurrenceCount}x`}).`);
    return;
  }

  const plan: EntryPlan | undefined = run.journeyEntryPlan;
  if (run.ownerDecision?.decision !== "approved") throw new Error(`${runId} was not approved by the owner; refusing to write it as confirmed`);
  if (!plan) throw new Error(`${runId} has no journeyEntryPlan saved (it was run with --no-dkg-write or before entries were written)`);
  if (run.dkgWrites?.entry && !run.dkgWrites.entry.error) throw new Error(`${runId}: entry already written (${run.dkgWrites.entry.assetName})`);
  console.log(`Writing approved post ${plan.assetName} from ${runId}...`);
  const w = await approveEntry(plan);
  run.dkgWrites = { ...(run.dkgWrites ?? {}), entry: w };
  if (run.final?.outcome) run.final.outcome.dkg = `${w.assetName} confirmed & shared (${w.triples} triples verified, KA #${w.kaNumber})`;
  save();
  console.log(`\nDONE: ${w.assetName} is confirmed and shared (KA #${w.kaNumber}, ${w.triples} triples read back and verified).`);
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`);
  process.exit(1);
});
