import { loadImprovementMemory } from "./improvement.ts";
import { nextEntryId } from "./journey.ts";

/*
 * Read-only view of the owner's Improvement Memory as stored in the DKG.
 *   npm run lessons                              -> the latest version
 *   npm run lessons -- --version improvement-memory-v1
 * Also prints the next journey entry id, which is a read-only check of the DKG discovery queries.
 */

const i = process.argv.indexOf("--version");
const which = i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "latest";

loadImprovementMemory(which)
  .then((im) => {
    if (!im.asset) {
      console.log(im.mode === "none-yet" ? "No improvement memory exists yet (no lessons recorded)." : "Improvement memory is switched off.");
      return;
    }
    console.log(`${im.asset.name}: version ${im.version}, KA #${im.asset.kaNumber}, ${im.asset.tripleCount} triples in Shared Working Memory`);
    console.log(`Graph: ${im.asset.graph}\n`);
    for (const l of im.lessons) {
      console.log(`${l.id} [${l.status}] rejected ${l.occurrenceCount}x`);
      console.log(`  rule (owner's latest wording): ${l.rule}`);
      for (const o of l.occurrences) {
        console.log(`  - ${o.recordedAt.slice(0, 19)}Z  run ${o.runId}`);
        console.log(`    owner said: ${o.ownerReason}`);
        console.log(`    rejected caption: ${o.rejectedCaption.slice(0, 140)}${o.rejectedCaption.length > 140 ? "…" : ""}`);
      }
      console.log("");
    }
  })
  .then(async () => console.log(`Next journey entry the pipeline would write: journey-${await nextEntryId()}`))
  .catch((err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  });
