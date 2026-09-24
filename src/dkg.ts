import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { settings } from "./config.ts";

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
