import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadJson<T>(rel: string): T {
  return JSON.parse(readFileSync(path.join(ROOT, rel), "utf8")) as T;
}

export interface Settings {
  businessId: string;
  /** Added by code when the writer's caption has no invitation to order. Every word is grounded in memory. */
  orderInvitationFallback: string;
  dkg: { container: string; memoryContextGraph: string; journeyContextGraph: string };
  livepeer: {
    endpoint: string;
    writer: string;
    imageModel: string;
    imageJudge: string;
    captionJudge: string;
    persistImages: boolean;
    expectedImageSize: { width: number; height: number };
  };
}

export interface VisualStyle {
  photoStyleSuffix: string;
  imagePromptRules: string[];
  bannedPromptWords: string[];
  imageRubric: { id: string; question: string }[];
}

export const settings = loadJson<Settings>("config/threadbiz.json");
export const visualStyle = loadJson<VisualStyle>("config/visual-style.json");

/** Parse a JSON object out of LLM text that may include code fences or chatter. */
export function parseJsonLoose(text: string): any {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`No JSON object found in: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (err) {
    // Models sometimes return two JSON objects, or JSON followed by notes containing braces: use the first complete object.
    const first = firstBalancedObject(cleaned, start);
    if (first) return JSON.parse(first);
    throw err;
  }
}

/** The first complete {...} starting at `from`, respecting strings and escapes. */
function firstBalancedObject(text: string, from: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(from, i + 1);
  }
  return null;
}

/** Case-insensitive whole-phrase search. Returns the phrases that were found. */
export function findPhrases(text: string, phrases: string[]): string[] {
  return phrases.filter((p) => {
    const escaped = p.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    return escaped && new RegExp(`\\b${escaped}\\b`, "i").test(text);
  });
}

/** "gourmet, chef-inspired, limited time only (overused)" -> ["gourmet", "chef-inspired", "limited time only"] */
export function splitPhraseList(value: unknown): string[] {
  const items = Array.isArray(value) ? value.map(String) : String(value ?? "").split(",");
  return items.map((s) => s.replace(/\(.*?\)/g, "").trim()).filter(Boolean);
}

export function asText(value: unknown): string {
  if (value === undefined || value === null) return "(none recorded)";
  if (Array.isArray(value)) return value.map(asText).join("; ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
