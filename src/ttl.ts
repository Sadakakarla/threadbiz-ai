/**
 * Minimal, dependency-free Turtle writer. Every triple is written on its own line with full IRIs
 * (no prefixes, no blank nodes), which is valid Turtle and N-Triples at the same time, so the DKG
 * parser cannot misread it. Because we build the triples ourselves, we always know the exact count
 * that should end up in the DKG.
 */

export const XSD = "http://www.w3.org/2001/XMLSchema#";
export const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

export type ObjectTerm = { iri: string } | { lit: string; datatype?: string };
export interface TripleSpec {
  s: string;
  p: string;
  o: ObjectTerm;
}

export const iri = (value: string): ObjectTerm => ({ iri: value });
export const str = (value: string): ObjectTerm => ({ lit: value });
export const int = (value: number): ObjectTerm => ({ lit: String(Math.trunc(value)), datatype: `${XSD}integer` });
export const date = (value: string): ObjectTerm => ({ lit: value, datatype: `${XSD}date` });
export const bool = (value: boolean): ObjectTerm => ({ lit: String(value), datatype: `${XSD}boolean` });

export function escapeLiteral(value: string): string {
  let out = "";
  for (const ch of value.replace(/\r\n?/g, "\n")) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out;
}

function assertIri(value: string): string {
  if (/[\s<>"{}|\\^`]/.test(value)) throw new Error(`Unsafe IRI: ${value}`);
  return `<${value}>`;
}

function termText(o: ObjectTerm): string {
  if ("iri" in o) return assertIri(o.iri);
  return `"${escapeLiteral(o.lit)}"${o.datatype ? `^^${assertIri(o.datatype)}` : ""}`;
}

export function tripleKey(t: TripleSpec): string {
  return `${t.s}\u0000${t.p}\u0000${"iri" in t.o ? `iri:${t.o.iri}` : `lit:${t.o.lit}`}`;
}

/** Removes exact duplicates (an RDF graph is a set, so the DKG would collapse them anyway). */
export function uniqueTriples(triples: TripleSpec[]): TripleSpec[] {
  const seen = new Set<string>();
  return triples.filter((t) => {
    const key = tripleKey(t);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function toTurtle(triples: TripleSpec[]): string {
  return uniqueTriples(triples)
    .map((t) => `${assertIri(t.s)} ${assertIri(t.p)} ${termText(t.o)} .`)
    .join("\n") + "\n";
}
