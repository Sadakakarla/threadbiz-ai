import { createHash } from "node:crypto";
import { asText, findPhrases, parseJsonLoose, settings, splitPhraseList, visualStyle } from "./config.ts";
import { generateText } from "./livepeer.ts";
import type { LoadedEntry, LoadedMemory } from "./memory.ts";

export interface Brief {
  caption: string;
  imagePrompt: string;
  memoryFactsUsed: { field: string; how: string }[];
  claims: { claim: string; source: string }[];
}

/** The writer describes the scene; the fixed product photo style is always appended by code. */
export function withPhotoStyle(scene: string): string {
  return `${scene.trim().replace(/\s*No text, no logos, no overlay\.?\s*$/i, "")} ${visualStyle.photoStyleSuffix}`.trim();
}

export interface Failure {
  part: "caption" | "image";
  id: string;
  reason: string;
}

export interface Revision {
  previous: Brief;
  failures: Failure[];
  captionMayChange: boolean;
  imagePromptMayChange: boolean;
}

export interface BriefResult {
  brief: Brief;
  attempts: { attempt: number; violations: string[] }[];
  cost: number;
  model: string;
  /** The exact prompt sent, with any PRIVATE entry text replaced by a hash placeholder. */
  promptSentRedacted: string;
  promptSha256: string;
  /** True when the writer omitted an invitation to order and the code appended the fixed fallback sentence. */
  ctaAddedByCode: boolean;
}

/** If the caption has no invitation to order, append the fixed, memory-grounded fallback sentence. */
function ensureOrderInvitation(caption: string): { caption: string; added: boolean } {
  if (ORDER_INVITATION.test(caption)) return { caption, added: false };
  const base = caption.trim().replace(/([^.!?])$/, "$1.");
  return { caption: `${base} ${settings.orderInvitationFallback}`, added: true };
}

export function buildBriefPrompt(mem: LoadedMemory, input: LoadedEntry, ownerNote: string): string {
  const m = mem.memory;
  return [
    "You are ThreadBiz AI, the content assistant for a small home-based business. Write this week's social media caption and a scene description for an image generator.",
    "GROUNDING: Only state facts that appear in BUSINESS MEMORY or THIS WEEK'S OWNER NOTE. Never invent ingredients, recipe origins, prices, dates, pickup times, places, quantities, or awards.",
    input.isPrivate
      ? "PRIVACY: The owner's voice note for this entry is private, so you are given only its owner-approved summary. Rely on BUSINESS MEMORY and THIS WEEK'S OWNER NOTE for all facts."
      : "The owner voice note below is public and may be used as a source.",
    [
      "CAPTION RULES:",
      `- Tone: ${asText(m.preferredTone)}`,
      `- Never use these phrases: ${splitPhraseList(m.avoidPhrases).join(", ")}`,
      `- Follow this strategy: ${asText(m.nextContentStrategy)}`,
      `- Build on what has worked: ${asText(m.successfulPattern ?? m.successfulPatterns)}`,
      `- Avoid what has failed before: ${asText(m.knownFailure ?? m.knownFailures)}`,
      "- The FINAL sentence must invite people to pre-order. If pickup or ordering specifics are not given, do not invent them.",
      "- 2 to 4 short sentences, at most one emoji, no hashtags.",
    ].join("\n"),
    ["IMAGE PROMPT RULES:", ...visualStyle.imagePromptRules.map((r) => `- ${r}`), `- Never use these words: ${visualStyle.bannedPromptWords.join(", ")}`].join("\n"),
    [
      "Return ONLY a JSON object, no markdown, with exactly these keys:",
      '{"caption": string, "imagePrompt": "<scene description only>",',
      ' "memoryFactsUsed": [{"field": "<memory field name>", "how": "<how it shaped the output>"}],',
      ' "claims": [{"claim": "<each factual statement in the caption>", "source": "memory:<field> or owner-note"}]}',
    ].join("\n"),
    `BUSINESS MEMORY (${mem.asset.name}):\n${JSON.stringify(m, null, 2)}`,
    input.isPrivate
      ? `OWNER-APPROVED SUMMARY OF PRIVATE ENTRY ${input.entry.entryId} (raw text withheld by design):\n${String(input.entry.description ?? "(no summary)")}`
      : `OWNER VOICE NOTE (${input.entry.entryId}):\n${input.text}`,
    `THIS WEEK'S OWNER NOTE:\n${ownerNote || "(none)"}`,
  ].join("\n\n");
}

function revisionBlock(r: Revision): string {
  const allowed = [r.captionMayChange && "caption", r.imagePromptMayChange && "imagePrompt"].filter(Boolean).join(" and ");
  return [
    "REVISION REQUEST: an editor reviewed your previous draft and found these problems:",
    ...r.failures.map((f) => `- [${f.part}] ${f.id}: ${f.reason}`),
    `PREVIOUS DRAFT:\n${JSON.stringify(r.previous, null, 2)}`,
    `Fix ONLY these problems, by editing ONLY the ${allowed}. Keep everything that was not criticized as close to word-for-word as possible. Do not introduce any new claims. Update "claims" and "memoryFactsUsed" to match the revised text. Return the full JSON object.`,
  ].join("\n\n");
}

function validate(b: any): string[] {
  const problems: string[] = [];
  if (typeof b?.caption !== "string" || !b.caption.trim()) problems.push("missing caption");
  if (typeof b?.imagePrompt !== "string" || !b.imagePrompt.trim()) problems.push("missing imagePrompt");
  if (!Array.isArray(b?.memoryFactsUsed)) problems.push("memoryFactsUsed must be an array");
  if (!Array.isArray(b?.claims)) problems.push("claims must be an array");
  return problems;
}

const ORDER_INVITATION = /\b(pre-?orders?|order(s|ing)?|reserve|save (you|yours|one|a)|claim (one|yours)|message (me|us)|dm (me|us)|sign up)\b/i;

/** Code-level checks that don't need a model: exact banned words and avoided phrases. */
export function deterministicViolations(brief: Brief, mem: LoadedMemory): string[] {
  const out: string[] = [];
  for (const w of findPhrases(brief.imagePrompt, visualStyle.bannedPromptWords)) out.push(`image prompt uses banned word "${w}"`);
  for (const p of findPhrases(brief.caption, splitPhraseList(mem.memory.avoidPhrases))) out.push(`caption uses avoided phrase "${p}"`);
  return out;
}

function redact(prompt: string, input: LoadedEntry): string {
  if (!input.isPrivate) return prompt;
  const hash = createHash("sha256").update(input.text).digest("hex");
  return prompt.split(input.text).join(`[PRIVATE ${input.entry.entryId} withheld from logs, sha256:${hash}]`);
}

/**
 * Writes a brief, or (with `revision`) a targeted edit of a previous brief based on judge feedback.
 * Inside one call, a malformed or rule-breaking reply gets one corrective re-ask.
 */
export async function writeBrief(
  mem: LoadedMemory,
  input: LoadedEntry,
  ownerNote: string,
  sessionId: string,
  round: number,
  revision?: Revision
): Promise<BriefResult> {
  const basePrompt = buildBriefPrompt(mem, input, ownerNote) + (revision ? `\n\n${revisionBlock(revision)}` : "");
  const attempts: BriefResult["attempts"] = [];
  let prompt = basePrompt;
  let cost = 0;
  let model = settings.livepeer.writer;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await generateText(`brief:round${round}:try${attempt}`, settings.livepeer.writer, prompt, sessionId);
    cost += res.cost;
    model = res.model;
    let parsed: any;
    let violations: string[];
    try {
      parsed = parseJsonLoose(res.text);
      violations = validate(parsed);
      if (!violations.length && revision) {
        // Enforce the "only change what failed" rule in code, not just by instruction.
        if (!revision.captionMayChange) parsed.caption = revision.previous.caption;
        if (!revision.imagePromptMayChange) parsed.imagePrompt = revision.previous.imagePrompt;
      }
      if (!violations.length) {
        const cta = ensureOrderInvitation(parsed.caption);
        parsed.caption = cta.caption;
        parsed.ctaAddedByCode = cta.added;
        violations = deterministicViolations(parsed, mem);
      }
    } catch (err: any) {
      violations = [`reply was not valid JSON (${err.message.slice(0, 80)})`];
    }
    attempts.push({ attempt, violations });
    if (!violations.length) {
      const ctaAddedByCode = parsed.ctaAddedByCode === true;
      delete parsed.ctaAddedByCode;
      return {
        ctaAddedByCode,
        brief: parsed as Brief,
        attempts,
        cost,
        model,
        promptSentRedacted: redact(basePrompt, input),
        promptSha256: createHash("sha256").update(basePrompt).digest("hex"),
      };
    }
    prompt = `${basePrompt}\n\nYOUR PREVIOUS ANSWER HAD THESE PROBLEMS: ${violations.join("; ")}. Fix them and return ONLY the JSON object.`;
  }
  throw new Error(`Brief (round ${round}) failed after 2 tries: ${JSON.stringify(attempts)}`);
}
