import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, settings } from "./config.ts";
import { assetExists, createFromTurtle, readGraph, resolveSharedGraph, type Term, type Triple } from "./dkg.ts";
import { escapeLiteral, XSD } from "./ttl.ts";

/*
 * Clean-start support for judges.
 *
 *   npm run export-dkg    (run on the node that holds the data)
 *       Reads every shared ThreadBiz Knowledge Asset (Business Memory, journey ledger, Improvement Memory,
 *       approved posts) and writes an exact snapshot to data/dkg-export/, plus manifest.json.
 *
 *   npm run seed          (run on a fresh node, after setting its context graph ids in config/threadbiz.json)
 *       Loads every asset in the manifest, shares it to Shared Working Memory and reads it back to verify
 *       that the node holds exactly the exported triples. Assets that already exist are verified, not rewritten,
 *       so running it twice is safe.
 */

const EXPORT_DIR = path.join(ROOT, "data", "dkg-export");
const MANIFEST = path.join(EXPORT_DIR, "manifest.json");

type GraphKey = "main" | "journey";
const graphId = (g: GraphKey) => (g === "main" ? settings.dkg.memoryContextGraph : settings.dkg.journeyContextGraph);

/** Asset families, in load order. Each is probed by name: prefix + number, from `first` upwards. */
const FAMILIES: { graph: GraphKey; prefix: string; first: number; pad: number }[] = [
  { graph: "main", prefix: "business-memory-v", first: 1, pad: 0 },
  { graph: "journey", prefix: "journey-", first: 1, pad: 3 },
  { graph: "main", prefix: "improvement-memory-v", first: 1, pad: 0 },
  { graph: "journey", prefix: "journey-entry-", first: 9, pad: 3 },
];
/** Stop probing a family after this many consecutive names that do not exist. */
const MAX_GAP = 3;

interface ManifestAsset {
  name: string;
  graph: GraphKey;
  file: string;
  triples: number;
  sha256: string;
}

// ---------------------------------------------------------------------------------------------
// Serialising what the node returns (IRIs, literals with datatype/language, blank nodes)
// ---------------------------------------------------------------------------------------------

function normDatatype(dt?: string): string | undefined {
  if (!dt) return undefined;
  const full = dt.startsWith("xsd:") ? `${XSD}${dt.slice(4)}` : dt;
  return full === `${XSD}string` ? undefined : full;
}

function termToTurtle(t: Term, bnodes: Map<string, string>): string {
  if (t.kind === "iri") {
    if (/[\s<>"{}|\\^`]/.test(t.value)) throw new Error(`Unsafe IRI in export: ${t.value}`);
    return `<${t.value}>`;
  }
  if (t.kind === "bnode") {
    if (!bnodes.has(t.value)) bnodes.set(t.value, `_:b${bnodes.size}`);
    return bnodes.get(t.value)!;
  }
  const dt = normDatatype(t.datatype);
  return `"${escapeLiteral(t.value)}"${t.lang ? `@${t.lang}` : dt ? `^^<${dt}>` : ""}`;
}

export function triplesToTurtle(triples: Triple[]): string {
  const bnodes = new Map<string, string>();
  return (
    triples
      .map((t) => `${termToTurtle(t.s, bnodes)} ${termToTurtle(t.p, bnodes)} ${termToTurtle(t.o, bnodes)} .`)
      .sort()
      .join("\n") + "\n"
  );
}

/**
 * Canonical key used to compare what was exported with what a node holds. Blank node labels are
 * node-specific, so they compare as "_:"; everything else must match exactly.
 */
function termKey(t: Term): string {
  if (t.kind === "bnode") return "_:";
  if (t.kind === "iri") return `<${t.value}>`;
  return `"${t.value}"@${t.lang ?? ""}^^${normDatatype(t.datatype) ?? ""}`;
}
const tripleKeys = (triples: Triple[]) => triples.map((t) => `${termKey(t.s)} ${termKey(t.p)} ${termKey(t.o)}`).sort();

function sameTriples(a: Triple[], b: Triple[]): { same: boolean; detail: string } {
  if (a.length !== b.length) return { same: false, detail: `expected ${a.length} triples, node holds ${b.length}` };
  const ka = tripleKeys(a);
  const kb = tripleKeys(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return { same: false, detail: `first difference: expected ${ka[i].slice(0, 160)} | node has ${kb[i].slice(0, 160)}` };
  }
  return { same: true, detail: `${a.length} triples identical` };
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

const assetName = (prefix: string, n: number, pad: number) => `${prefix}${pad ? String(n).padStart(pad, "0") : n}`;

async function exportAll() {
  mkdirSync(EXPORT_DIR, { recursive: true });
  const assets: ManifestAsset[] = [];
  const skipped: string[] = [];
  for (const fam of FAMILIES) {
    const cg = graphId(fam.graph);
    let gap = 0;
    for (let n = fam.first; gap < MAX_GAP && n < fam.first + 500; n++) {
      const name = assetName(fam.prefix, n, fam.pad);
      if (!(await assetExists(name, cg))) {
        gap++;
        continue;
      }
      gap = 0;
      let resolved;
      try {
        resolved = await resolveSharedGraph(name, cg);
      } catch (err: any) {
        // e.g. a private draft that was never shared: not part of the public snapshot
        skipped.push(`${name} (${String(err.message).slice(0, 90)})`);
        console.log(`  skip ${name}: not in Shared Working Memory`);
        continue;
      }
      const triples = await readGraph(resolved);
      const turtle = triplesToTurtle(triples);
      const file = `${fam.graph}/${name}.ttl`;
      mkdirSync(path.join(EXPORT_DIR, fam.graph), { recursive: true });
      writeFileSync(path.join(EXPORT_DIR, file), turtle, "utf8");
      const sha256 = createHash("sha256").update(turtle).digest("hex");
      assets.push({ name, graph: fam.graph, file, triples: triples.length, sha256 });
      console.log(`  exported ${name.padEnd(24)} ${String(triples.length).padStart(3)} triples -> data/dkg-export/${file}`);
    }
  }
  if (!assets.length) throw new Error("Nothing exported: no shared ThreadBiz assets were found on this node");
  const manifest = {
    about: "Exact snapshot of the ThreadBiz Knowledge Assets in Shared Working Memory. Load with `npm run seed`.",
    exportedAt: new Date().toISOString(),
    businessId: settings.businessId,
    graphs: { main: "Business Memory + Improvement Memory context graph", journey: "Journey Ledger context graph" },
    assets,
    skipped,
  };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nDONE: ${assets.length} assets exported to data/dkg-export/ (manifest.json)${skipped.length ? `; skipped ${skipped.length} unshared` : ""}.`);
}

// ---------------------------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------------------------

async function seedAll() {
  if (!existsSync(MANIFEST)) throw new Error("data/dkg-export/manifest.json not found; run `npm run export-dkg` on the source node first");
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { assets: ManifestAsset[] };
  console.log(`Seeding ${manifest.assets.length} assets into:\n  main:    ${graphId("main")}\n  journey: ${graphId("journey")}\n`);
  let created = 0;
  let verified = 0;
  for (const a of manifest.assets) {
    const turtle = readFileSync(path.join(EXPORT_DIR, a.file), "utf8");
    if (createHash("sha256").update(turtle).digest("hex") !== a.sha256) throw new Error(`${a.file} does not match its sha256 in manifest.json (file was modified)`);
    const cg = graphId(a.graph);
    const exists = await assetExists(a.name, cg);
    if (!exists) {
      await createFromTurtle({ name: a.name, contextGraph: cg, turtle, expectedTriples: a.triples, share: true });
    }
    // Verify against what the node now holds (retry briefly: a fresh share can take a moment to be queryable)
    const expected = parseSnapshot(turtle);
    let result = { same: false, detail: "" };
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        const got = await readGraph(await resolveSharedGraph(a.name, cg));
        result = sameTriples(expected, got);
        if (result.same) break;
      } catch (err: any) {
        result = { same: false, detail: err.message };
      }
      if (attempt < 6) await new Promise((r) => setTimeout(r, 2000));
    }
    if (!result.same) throw new Error(`${a.name}: ${exists ? "already on this node but DIFFERENT from the snapshot" : "loaded but verification failed"} (${result.detail})`);
    if (exists) verified++;
    else created++;
    console.log(`  ${exists ? "already present, verified" : "created + shared + verified"}  ${a.name.padEnd(24)} ${result.detail}`);
  }
  console.log(`\nDONE: ${created} created, ${verified} already present; all ${manifest.assets.length} verified triple by triple.`);
  console.log("Next: npm run lessons   (should list the owner's lessons)");
}

/** Parses our own one-triple-per-line snapshot format back into Terms (for comparison). */
function parseSnapshot(turtle: string): Triple[] {
  const token = /<[^>]*>|_:[A-Za-z0-9]+|"(?:[^"\\]|\\.)*"(?:@[A-Za-z0-9-]+|\^\^<[^>]*>)?/g;
  const toTerm = (x: string): Term => {
    if (x.startsWith("<")) return { kind: "iri", value: x.slice(1, -1) };
    if (x.startsWith("_:")) return { kind: "bnode", value: x };
    const m = /^"((?:[^"\\]|\\.)*)"(?:@([A-Za-z0-9-]+)|\^\^<([^>]*)>)?$/.exec(x);
    if (!m) throw new Error(`Unreadable literal in snapshot: ${x.slice(0, 80)}`);
    // escapeLiteral only emits \\ \" \n \t and \uXXXX, all of which JSON decodes identically.
    return { kind: "literal", value: JSON.parse(`"${m[1]}"`), lang: m[2], datatype: m[3] };
  };
  return turtle
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => {
      const parts = line.match(token);
      if (!parts || parts.length !== 3) throw new Error(`Unreadable snapshot line: ${line.slice(0, 120)}`);
      const [s, p, o] = parts.map(toTerm);
      return { s, p, o };
    });
}

const cmd = process.argv[2];
const job = cmd === "export" ? exportAll : cmd === "seed" ? seedAll : null;
if (!job) {
  console.error("Usage: tsx src/snapshot.ts export|seed   (npm run export-dkg / npm run seed)");
  process.exit(1);
}
job().catch((err) => {
  console.error(`\nERROR: ${err.message}`);
  process.exit(1);
});
