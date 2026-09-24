import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { settings } from "./config.ts";
import { toTurtle, tripleKey, uniqueTriples, type TripleSpec } from "./ttl.ts";

const exec = promisify(execFile);

export interface Term {
  kind: "iri" | "literal" | "bnode";
  value: string;
  datatype?: string;
  lang?: string;
}
export interface Triple {
  s: Term;
  p: Term;
  o: Term;
}

async function dkg(args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("docker", ["exec", settings.dkg.container, "dkg", ...args], {
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout;
  } catch (err: any) {
    throw new Error(`dkg ${args.slice(0, 2).join(" ")} failed: ${err.stderr || err.message}`);
  }
}

function extractJson(text: string): any {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`No JSON in DKG output: ${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start, end + 1));
}

function unescapeLiteral(s: string): string {
  return s.replace(/\\(["\\nrt])/g, (_, c) => ({ n: "\n", r: "\r", t: "\t" } as any)[c] ?? c);
}

/** Accepts either N-Triples-style strings ("\"x\"^^xsd:boolean") or SPARQL-JSON term objects. */
export function parseTerm(raw: unknown): Term {
  if (raw && typeof raw === "object") {
    const r = raw as any;
    if (r.type === "literal" || r.type === "typed-literal") {
      return { kind: "literal", value: String(r.value), datatype: r.datatype, lang: r["xml:lang"] };
    }
    return { kind: r.type === "bnode" ? "bnode" : "iri", value: String(r.value) };
  }
  const s = String(raw);
  const m = s.match(/^"([\s\S]*)"(?:\^\^<?([^>]+)>?|@([A-Za-z0-9-]+))?$/);
  if (m) return { kind: "literal", value: unescapeLiteral(m[1]), datatype: m[2], lang: m[3] };
  if (s.startsWith("_:")) return { kind: "bnode", value: s };
  return { kind: "iri", value: s.replace(/^<|>$/g, "") };
}

export function termValue(t: Term): unknown {
  if (t.kind !== "literal") return t.value;
  const dt = t.datatype ?? "";
  if (/boolean$/.test(dt)) return t.value === "true";
  if (/(integer|int|long|decimal|double|float)$/.test(dt)) return Number(t.value);
  return t.value;
}

export function localName(iri: string): string {
  const parts = iri.split(/[#/]/).filter(Boolean);
  return parts[parts.length - 1] ?? iri;
}

async function query(contextGraph: string, sparql: string): Promise<Record<string, Term>[]> {
  const out = extractJson(await dkg(["query", contextGraph, "--include-shared-memory", "--sparql", sparql]));
  const bindings = out.bindings ?? out.results?.bindings ?? out.result?.bindings;
  if (!Array.isArray(bindings)) throw new Error(`Unexpected query output shape: ${JSON.stringify(out).slice(0, 300)}`);
  return bindings.map((b: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(b).map(([k, v]) => [k, parseTerm(v)]))
  );
}

export async function kaStatus(name: string, contextGraph: string): Promise<any> {
  return extractJson(await dkg(["ka", "status", name, "--context-graph-id", contextGraph]));
}

async function graphTripleCount(contextGraph: string, graph: string): Promise<number> {
  const rows = await query(contextGraph, `SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  return rows[0]?.n ? Number(rows[0].n.value) : 0;
}

export interface ResolvedAsset {
  name: string;
  contextGraph: string;
  kaNumber: string;
  graph: string;
  tripleCount: number;
  status: string;
}

/**
 * Finds the Shared Working Memory named graph that holds exactly this Knowledge Asset,
 * so different versions stored under the same subject IRI are never mixed together.
 */
export async function resolveSharedGraph(name: string, contextGraph: string): Promise<ResolvedAsset> {
  const status = await kaStatus(name, contextGraph);
  const kaNumber = String(status.kaNumber ?? "");
  const statusLabel = String(status.status ?? status.memoryLayer ?? "");
  if (!kaNumber) throw new Error(`ka status for ${name} returned no kaNumber: ${JSON.stringify(status).slice(0, 300)}`);
  if (!/shared|swm/i.test(statusLabel)) throw new Error(`${name} is not in Shared Working Memory (status: ${statusLabel})`);

  const candidates: string[] = [];
  if (typeof status.assertionGraph === "string") {
    candidates.push(status.assertionGraph.replace("/_working_memory/", "/_shared_memory/"));
  }
  for (const graph of candidates) {
    const n = await graphTripleCount(contextGraph, graph);
    if (n > 0) return { name, contextGraph, kaNumber, graph, tripleCount: n, status: statusLabel };
  }

  // Fallback: list every named graph and match on the KA number.
  const rows = await query(contextGraph, "SELECT DISTINCT ?g (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } } GROUP BY ?g");
  const pattern = new RegExp(`/_shared_memory/[^/]+/${kaNumber}$`);
  const hit = rows.find((r) => r.g && pattern.test(r.g.value));
  if (!hit) throw new Error(`Could not find the shared-memory graph for ${name} (kaNumber ${kaNumber})`);
  return { name, contextGraph, kaNumber, graph: hit.g.value, tripleCount: Number(hit.n.value), status: statusLabel };
}

export async function readGraph(asset: ResolvedAsset): Promise<Triple[]> {
  const rows = await query(asset.contextGraph, `SELECT ?s ?p ?o WHERE { GRAPH <${asset.graph}> { ?s ?p ?o } }`);
  const triples = rows.map((r) => ({ s: r.s, p: r.p, o: r.o }));
  if (triples.length !== asset.tripleCount) {
    throw new Error(`Read ${triples.length} triples from ${asset.name} but the graph holds ${asset.tripleCount}`);
  }
  return triples;
}

/** Turns the triples for one subject into a plain object, inlining linked nodes (key people, facts). */
export function subjectToObject(triples: Triple[], rootLocalName: string): Record<string, unknown> {
  const bySubject = new Map<string, Map<string, Term[]>>();
  for (const t of triples) {
    if (!bySubject.has(t.s.value)) bySubject.set(t.s.value, new Map());
    const props = bySubject.get(t.s.value)!;
    const key = localName(t.p.value);
    if (!props.has(key)) props.set(key, []);
    props.get(key)!.push(t.o);
  }
  const root = [...bySubject.keys()].find((s) => localName(s) === rootLocalName);
  if (!root) throw new Error(`Subject "${rootLocalName}" not found in graph`);

  const build = (subject: string, seen: Set<string>): Record<string, unknown> => {
    const obj: Record<string, unknown> = {};
    for (const [key, terms] of bySubject.get(subject)!) {
      if (key === "type" || key === "22-rdf-syntax-ns#type") continue;
      const values = terms.map((t) =>
        t.kind !== "literal" && bySubject.has(t.value) && !seen.has(t.value)
          ? build(t.value, new Set([...seen, t.value]))
          : termValue(t)
      );
      obj[key] = values.length === 1 ? values[0] : values;
    }
    return obj;
  };
  return build(root, new Set([root]));
}

// ---------------------------------------------------------------------------------------------
// Discovery helpers (read-only)
// ---------------------------------------------------------------------------------------------

/**
 * Finds every Shared Working Memory graph in a context graph that holds `<subject> <predicate> ?v`
 * (subject optional) and returns each graph with the value found. Used to look up "the latest
 * version" or "the highest entry id" without hardcoding KA numbers. Only shared-memory graphs are
 * returned, so unshared drafts can never be mistaken for confirmed knowledge.
 */
export async function graphsWithPredicate(contextGraph: string, predicate: string, subject?: string): Promise<{ graph: string; value: string }[]> {
  const subj = subject ? `<${subject}>` : "?s";
  const rows = await query(contextGraph, `SELECT DISTINCT ?g ?v WHERE { GRAPH ?g { ${subj} <${predicate}> ?v } }`);
  return rows
    .filter((r) => r.g && r.v && /\/_shared_memory\//.test(r.g.value))
    .map((r) => ({ graph: r.g.value, value: r.v.value }));
}

export async function assetExists(name: string, contextGraph: string): Promise<boolean> {
  try {
    await kaStatus(name, contextGraph);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Writes: create / share / discard Knowledge Assets through the node's own CLI
// ---------------------------------------------------------------------------------------------

async function docker(args: string[], what: string): Promise<string> {
  try {
    const { stdout, stderr } = await exec("docker", args, { maxBuffer: 20 * 1024 * 1024 });
    return `${stdout}\n${stderr}`;
  } catch (err: any) {
    throw new Error(`${what} failed: ${(err.stderr || err.stdout || err.message || "").toString().trim().slice(0, 800)}`);
  }
}

export interface CreatedAsset {
  name: string;
  contextGraph: string;
  kaNumber: string;
  status: string;
  quadsParsed: number | null;
}

/**
 * Creates a Knowledge Asset from triples. The Turtle file is copied into the node container
 * (`docker cp`), so it works whether or not the host folder is mounted. With share=false the asset
 * stays a private, sealed draft in Working Memory; with share=true it is promoted to Shared
 * Working Memory in the same call.
 */
export async function createKnowledgeAsset(o: { name: string; contextGraph: string; triples: TripleSpec[]; share: boolean }): Promise<CreatedAsset> {
  const triples = uniqueTriples(o.triples);
  if (!triples.length) throw new Error(`Refusing to create ${o.name}: no triples`);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "threadbiz-ka-"));
  const hostFile = path.join(tmpDir, `${o.name}.ttl`);
  const containerFile = `/tmp/threadbiz-${o.name}-${Date.now()}.ttl`;
  let output: string;
  try {
    await writeFile(hostFile, toTurtle(triples), "utf8");
    await docker(["cp", hostFile, `${settings.dkg.container}:${containerFile}`], `docker cp for ${o.name}`);
    const cli = ["exec", settings.dkg.container, "dkg", "ka", "create", o.name, "--context-graph-id", o.contextGraph, "--input-file", containerFile];
    if (o.share) cli.push("--share");
    output = await docker(cli, `dkg ka create ${o.name}${o.share ? " --share" : ""}`);
  } finally {
    await docker(["exec", settings.dkg.container, "rm", "-f", containerFile], "cleanup").catch(() => undefined);
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
  const parsed = /Parsed\s+(\d+)\s+quad/i.exec(output);
  const quadsParsed = parsed ? Number(parsed[1]) : null;
  if (quadsParsed !== null && quadsParsed !== triples.length) {
    throw new Error(`${o.name}: the node parsed ${quadsParsed} quads but ${triples.length} were written to the file`);
  }
  const status = await kaStatus(o.name, o.contextGraph);
  return { name: o.name, contextGraph: o.contextGraph, kaNumber: String(status.kaNumber ?? ""), status: String(status.status ?? status.memoryLayer ?? ""), quadsParsed };
}

/** Discards an unshared Working Memory draft. Throws if there is no draft (e.g. the asset is already shared). */
export async function discardDraft(name: string, contextGraph: string): Promise<void> {
  const out = await docker(["exec", settings.dkg.container, "dkg", "ka", "discard", name, "--context-graph-id", contextGraph], `dkg ka discard ${name}`);
  if (!/discarded:\s*yes/i.test(out)) throw new Error(`dkg ka discard ${name}: unexpected output: ${out.trim().slice(0, 300)}`);
}

/** Like discardDraft, but returns false instead of throwing when there is nothing to discard. */
export async function discardDraftIfPresent(name: string, contextGraph: string): Promise<boolean> {
  try {
    await discardDraft(name, contextGraph);
    return true;
  } catch {
    return false;
  }
}

export interface VerifiedAsset {
  name: string;
  kaNumber: string;
  graph: string;
  tripleCount: number;
}

/**
 * Reads a freshly shared asset back from Shared Working Memory and checks that it holds exactly the
 * triples we wrote (same count, every expected subject/predicate/value present). Retries briefly
 * because the share can take a moment to become queryable.
 */
export async function verifyShared(name: string, contextGraph: string, expected: TripleSpec[]): Promise<VerifiedAsset> {
  const want = uniqueTriples(expected);
  let lastError = "";
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const asset = await resolveSharedGraph(name, contextGraph);
      const got = await readGraph(asset);
      const gotKeys = new Set(got.map((t) => `${t.s.value}\u0000${t.p.value}\u0000${t.o.kind === "iri" ? "iri:" : "lit:"}${t.o.value}`));
      const missing = want.filter((t) => !gotKeys.has(tripleKey(t)));
      if (got.length !== want.length || missing.length) {
        throw new Error(`read-back mismatch: wrote ${want.length} triples, read ${got.length}${missing.length ? `; missing ${missing.length} (first: ${missing[0].p})` : ""}`);
      }
      return { name, kaNumber: asset.kaNumber, graph: asset.graph, tripleCount: got.length };
    } catch (err: any) {
      lastError = err.message;
      if (attempt < 6) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`Could not verify ${name} after sharing: ${lastError}`);
}
