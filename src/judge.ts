import { asText, findPhrases, parseJsonLoose, settings, splitPhraseList, visualStyle } from "./config.ts";
import { costOf, runCapability } from "./livepeer.ts";
import type { Brief, Failure } from "./brief.ts";
import { activeLessons, lessonRuleText, type Lesson } from "./improvement.ts";
import type { LoadedEntry, LoadedMemory } from "./memory.ts";

export type Verdict = "yes" | "partly" | "no" | "unparseable";
export interface Criterion {
  id: string;
  verdict: Verdict;
  reason: string;
  checkedBy: string;
}
export interface JudgeReport {
  judge: string;
  status: "ok" | "error";
  criteria: Criterion[];
  error?: string;
  cost: number;
  itemized?: Record<string, unknown>;
}

const CAPTION_RUBRIC = (mem: LoadedMemory) => [
  { id: "no-avoided-phrases", question: `Does the caption avoid all of these phrases: ${splitPhraseList(mem.memory.avoidPhrases).join(", ")}?` },
  { id: "no-known-failures", question: `Does the caption avoid repeating this known failure: ${asText(mem.memory.knownFailure ?? mem.memory.knownFailures)}?` },
  {
    id: "follows-strategy",
    question: `Does the caption follow every part of this content strategy that is possible with the available facts: ${asText(mem.memory.nextContentStrategy)}? Parts that would need facts NOT in the ALLOWED FACTS (for example pickup times, places, or capacity numbers) are NOT required; a clear invitation to order is enough for ordering details. Answer no only if the caption ignores a part it could have done with the allowed facts.`,
  },
  { id: "matches-tone", question: `Does the caption match this tone: ${asText(mem.memory.preferredTone)}?` },
  {
    id: "factually-grounded",
    question:
      "Is every factual claim in the caption supported by the ALLOWED FACTS below? Treat all of these as factual claims: where a dish or recipe comes from, ingredients, taste or texture descriptions (e.g. 'sweet', 'tender', 'crispy'), sourcing, quantities, prices, times, and places. A general fact about the business does NOT support a more specific claim about this week's dish. Purely emotional wording (e.g. 'comforting', 'cozy') is not a factual claim. Answer no if anything is unsupported, and name the exact words.",
  },
];

function normalize(raw: any, expected: { id: string }[], checkedBy: string): Criterion[] {
  const list: any[] = Array.isArray(raw?.criteria) ? raw.criteria : [];
  return expected.map(({ id }) => {
    const found = list.find((c) => String(c?.id).toLowerCase() === id);
    const v = String(found?.verdict ?? "").toLowerCase().trim();
    const verdict: Verdict = v === "yes" || v === "partly" || v === "no" ? v : "unparseable";
    return { id, verdict, reason: String(found?.reason ?? "judge gave no answer for this criterion"), checkedBy };
  });
}

function rubricText(rubric: { id: string; question: string }[]): string {
  return rubric.map((r, i) => `${i + 1}. id "${r.id}": ${r.question}`).join("\n");
}

async function runJudge(
  label: string,
  capability: string,
  prompt: string,
  rubric: { id: string }[],
  sessionId: string,
  inputs?: Record<string, unknown>
): Promise<{ report: JudgeReport; parsed: any }> {
  try {
    const data = await runCapability({ label, capability, prompt, inputs, timeout: 60, sessionId });
    const text = data?.result?.text ?? data?.text;
    const parsed = parseJsonLoose(String(text ?? ""));
    const criteria = normalize(parsed, rubric, capability);
    return { report: { judge: capability, status: "ok", criteria, cost: costOf(data) }, parsed };
  } catch (err: any) {
    // Deliberately no fallback to another judge: a failed check is reported, never silently replaced.
    return { report: { judge: capability, status: "error", criteria: [], error: err.message, cost: 0 }, parsed: null };
  }
}

/** Overrides one criterion from itemized findings, so a skimming judge cannot contradict its own item list. */
function force(report: JudgeReport, id: string, verdict: Verdict, reason: string) {
  const c = report.criteria.find((x) => x.id === id);
  if (c) Object.assign(c, { verdict, reason, checkedBy: `${report.judge} (itemized)` });
}

const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
const STOP = new Set("a an the and or of to in on for with is are it its it's this that our my we i you your from at by as be".split(" "));

/** True if the claim's words are really in the caption (exact substring, or most content words present). */
function appearsIn(claim: string, caption: string): boolean {
  const cap = words(caption).join(" ");
  const cw = words(claim);
  if (cap.includes(cw.join(" "))) return true;
  const content = cw.filter((w) => !STOP.has(w));
  if (!content.length) return false;
  const capSet = new Set(words(caption));
  return content.filter((w) => capSet.has(w)).length / content.length >= 0.6;
}

const CTA = /\b(pre-?orders?|order(s|ing)?|reserve)\b/i;
function isCallToAction(claim: string): boolean {
  return CTA.test(claim) && words(claim).length <= 10;
}

/** Word sequences of length n that appear in both texts (used to detect copied private wording). */
function sharedPhrases(a: string, b: string, n: number): string[] {
  const grams = (t: string) => {
    const w = words(t);
    const out = new Set<string>();
    for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
    return out;
  };
  const gb = grams(b);
  return [...grams(a)].filter((g) => gb.has(g));
}

const isFalse = (v: unknown) => v === false || String(v).toLowerCase().trim() === "false" || String(v).toLowerCase().trim() === "no";

export async function judgeImage(imageUrl: string, brief: Brief, ownerNote: string, sessionId: string): Promise<JudgeReport> {
  const rubric = visualStyle.imageRubric;
  const prompt = [
    "You are a strict photo editor reviewing an image for a small home-based food business's social media post. Judge only what you can actually see.",
    `INTENDED DISH (from the owner): ${ownerNote || "(not specified)"}`,
    `CAPTION THAT WILL ACCOMPANY IT: "${brief.caption}"`,
    "FIRST, list every ingredient named in the INTENDED DISH, including what the base is made of (for example a tomato broth), and say whether each is actually visible in the image.",
    `THEN answer the criteria:\n${rubricText(rubric)}`,
    'Return ONLY a JSON object, no markdown: {"ingredients": [{"name": "<ingredient>", "visible": "yes" | "partly" | "no", "note": "<what you see>"}], "criteria": [{"id": "<criterion id>", "verdict": "yes" | "partly" | "no", "reason": "<one sentence describing what you actually observed>"}]}',
  ].join("\n\n");
  const { report, parsed } = await runJudge("judge:image", settings.livepeer.imageJudge, prompt, rubric, sessionId, { image_url: imageUrl });
  if (report.status !== "ok") return report;
  const items: any[] = Array.isArray(parsed?.ingredients) ? parsed.ingredients : [];
  report.itemized = { ingredients: items };
  if (ownerNote && !items.length) {
    force(report, "right-subject", "unparseable", "Judge did not list ingredient visibility, so the subject is unverified.");
  } else {
    const missing = items.filter((i) => String(i?.visible).toLowerCase().trim() === "no");
    if (missing.length) force(report, "right-subject", "no", `Not visible: ${missing.map((i) => `${i.name}${i.note ? ` (${i.note})` : ""}`).join("; ")}`);
  }
  return report;
}

/**
 * One dedicated, narrow check per owner lesson. It is a separate call from the general caption judge
 * on purpose: the general judge decides for itself which claims to list and can skip one, but this
 * call asks only "does the caption break THIS rule?" and must quote the offending words.
 * Code cross-checks the answer: if the judge says "no violation" while quoting words that really are
 * in the caption, the judge contradicted itself and the lesson is treated as broken.
 */
async function judgeLesson(lesson: Lesson, caption: string, ownerNote: string, sessionId: string): Promise<{ criterion: Criterion; cost: number; detail: Record<string, unknown> }> {
  const capability = settings.livepeer.captionJudge;
  const checkedBy = `${capability} (dedicated lesson check)`;
  const prompt = [
    "You are a strict editor checking ONE rule that the business owner set, against a social media caption.",
    `OWNER'S RULE: ${lessonRuleText(lesson)}`,
    `CAPTION:\n"${caption}"`,
    `THIS WEEK'S OWNER NOTE (the only thing that can make an exception to the rule):\n${ownerNote || "(none)"}`,
    "QUESTION: Does the caption state or imply anything the rule forbids? Look for paraphrases and closely related wording, not just the exact words of the rule. If the owner note explicitly says the thing the rule forbids, it is allowed.",
    'Return ONLY a JSON object, no markdown: {"breaksRule": true | false, "quotes": ["<exact words copied from the caption that break the rule>"], "reason": "<one sentence>"}. If the rule is not broken, quotes must be an empty list.',
  ].join("\n\n");
  try {
    const data = await runCapability({ label: `judge:lesson:${lesson.id}`, capability, prompt, timeout: 60, sessionId });
    const parsed = parseJsonLoose(String(data?.result?.text ?? data?.text ?? ""));
    const flag = String(parsed?.breaksRule).toLowerCase().trim();
    if (flag !== "true" && flag !== "false") throw new Error("judge did not answer breaksRule with true or false");
    const quotes: string[] = (Array.isArray(parsed?.quotes) ? parsed.quotes : []).map(String).filter((q: string) => q.trim());
    const capWords = words(caption).join(" ");
    const realQuotes = quotes.filter((q) => capWords.includes(words(q).join(" ")) && words(q).length > 0);
    const judgeSaysBroken = flag === "true";
    const contradiction = !judgeSaysBroken && realQuotes.length > 0;
    const broken = judgeSaysBroken || contradiction;
    const quoted = realQuotes.length ? ` Words in the caption: ${realQuotes.map((q) => `"${q}"`).join(", ")}.` : "";
    const why = String(parsed?.reason ?? "").trim();
    return {
      cost: costOf(data),
      detail: { lessonId: lesson.id, breaksRule: judgeSaysBroken, quotes, quotesFoundInCaption: realQuotes, contradictionOverridden: contradiction },
      criterion: {
        id: lesson.id,
        verdict: broken ? "no" : "yes",
        reason: broken
          ? `Breaks the owner's rule (${lessonRuleText(lesson)}).${quoted}${contradiction ? " (The judge answered 'no violation' but quoted offending words, so code overrode it.)" : ""} ${why}`.trim()
          : `Follows the owner's rule (${lessonRuleText(lesson)}). ${why}`.trim(),
        checkedBy,
      },
    };
  } catch (err: any) {
    return {
      cost: 0,
      detail: { lessonId: lesson.id, error: err.message },
      criterion: { id: lesson.id, verdict: "unparseable", reason: `Lesson check failed: ${err.message.slice(0, 200)}`, checkedBy },
    };
  }
}

export async function judgeCaption(brief: Brief, mem: LoadedMemory, input: LoadedEntry, ownerNote: string, sessionId: string, lessons: Lesson[] = []): Promise<JudgeReport> {
  const rubric = CAPTION_RUBRIC(mem);
  // Started now so the per-lesson checks run in parallel with the general caption judge.
  const lessonChecks = Promise.all(activeLessons(lessons).map((l) => judgeLesson(l, brief.caption, ownerNote, sessionId)));
  const prompt = [
    "You are a strict editor checking a social media caption for a small home-based business before it is published.",
    `CAPTION:\n"${brief.caption}"`,
    `CLAIMS THE WRITER SAYS IT MADE:\n${JSON.stringify(brief.claims)}`,
    `ALLOWED FACTS (business memory + this week's owner note):\n${JSON.stringify(mem.memory)}\nOwner note: ${ownerNote || "(none)"}`,
    "GENERAL RULES: Never require details that are not in the ALLOWED FACTS. Calls to action (e.g. 'Pre-order today', 'Pre-order to enjoy') and emotional or mood words (e.g. 'comforting', 'cozy', 'warm') are NOT factual claims: do not list them as claims.",
    "FIRST, list EVERY factual claim in the caption, copying the caption's exact words for each (origins, ingredients, taste or texture words like 'sweet' or 'tender', sourcing, quantities, times, places, people). For each, say whether the ALLOWED FACTS support it and quote the supporting fact. A general fact about the business does not support a more specific claim about this dish.",
    `THEN answer the criteria:\n${rubricText(rubric)}`,
    'Return ONLY a JSON object, no markdown: {"claims": [{"text": "<exact words from the caption>", "supported": true | false, "evidence": "<supporting fact, or what is missing>"}], "criteria": [{"id": "<criterion id>", "verdict": "yes" | "partly" | "no", "reason": "<one sentence>"}]}',
  ].join("\n\n");
  const { report, parsed } = await runJudge("judge:caption", settings.livepeer.captionJudge, prompt, rubric, sessionId);
  if (report.status === "ok") {
    const listed: any[] = Array.isArray(parsed?.claims) ? parsed.claims : [];
    // Sanity filter: keep only claims that really are in the caption, and drop calls to action.
    const claims = listed.filter(
      (c) =>
        c?.text &&
        appearsIn(String(c.text), brief.caption) &&
        !isCallToAction(String(c.text)) &&
        // The judge itself says the problem is only mood/emotional wording, which is not a factual claim.
        !(isFalse(c?.supported) && /emotion|mood|subjective|not a factual|opinion|feeling|tone/i.test(String(c?.evidence ?? "")))
    );
    report.itemized = { claims, discardedClaims: listed.filter((c) => !claims.includes(c)) };
    if (!Array.isArray(parsed?.claims)) {
      force(report, "factually-grounded", "unparseable", "Judge did not list the caption's claims, so grounding is unverified.");
    } else {
      const unsupported = claims.filter((c) => isFalse(c?.supported));
      if (unsupported.length) {
        force(report, "factually-grounded", "no", `Unsupported: ${unsupported.map((c) => `"${c.text}"${c.evidence ? ` (${c.evidence})` : ""}`).join("; ")}`);
      } else {
        force(report, "factually-grounded", "yes", claims.length ? `All ${claims.length} listed claims are supported by the allowed facts.` : "No factual claims beyond the allowed facts.");
      }
    }
  }

  // Privacy is checked by code, not by a model: the writer never receives private text,
  // and this confirms no 4-word sequence from a private entry appears in the caption.
  // Phrases that also appear in allowed sources (memory, owner note) are not leaks.
  const allowedText = `${JSON.stringify(mem.memory)} ${ownerNote}`;
  const copied = input.isPrivate
    ? sharedPhrases(brief.caption, input.text, 4).filter((g) => !sharedPhrases(g, allowedText, 4).length)
    : [];
  report.criteria.push({
    id: "privacy",
    verdict: copied.length ? "no" : "yes",
    reason: copied.length
      ? `Caption repeats private wording: ${copied.map((p) => `"${p}"`).join(", ")}`
      : input.isPrivate ? "Writer never received the private text, and no 4-word sequence from it appears in the caption." : "No private entries were used.",
    checkedBy: "code",
  });

  // Exact phrase matching is done by code as well; code findings override the model on this criterion.
  const hits = findPhrases(brief.caption, splitPhraseList(mem.memory.avoidPhrases));
  if (hits.length && report.status === "ok") {
    const c = report.criteria.find((x) => x.id === "no-avoided-phrases");
    if (c) Object.assign(c, { verdict: "no", reason: `Exact match found by code: ${hits.join(", ")}`, checkedBy: "code" });
  }

  const lessonResults = await lessonChecks;
  for (const r of lessonResults) {
    report.criteria.push(r.criterion);
    report.cost += r.cost;
  }
  if (lessonResults.length) report.itemized = { ...(report.itemized ?? {}), lessonChecks: lessonResults.map((r) => r.detail) };
  return report;
}

export function overallVerdict(reports: JudgeReport[]): "pass" | "fail" | "incomplete" {
  if (reports.some((r) => r.status === "error" || r.criteria.some((c) => c.verdict === "unparseable"))) {
    return reports.some((r) => r.criteria.some((c) => c.verdict === "no")) ? "fail" : "incomplete";
  }
  return reports.some((r) => r.criteria.some((c) => c.verdict === "no")) ? "fail" : "pass";
}

/**
 * Turns judge "no" verdicts into targeted failures. "matches-caption" is routed to the caption:
 * when image and caption disagree, the cheaper caption is revised to fit the image.
 */
export function collectFailures(imageReport: JudgeReport, captionReport: JudgeReport): Failure[] {
  const out: Failure[] = [];
  for (const c of imageReport.criteria) {
    if (c.verdict === "no") out.push({ part: c.id === "matches-caption" ? "caption" : "image", id: c.id, reason: c.reason });
  }
  for (const c of captionReport.criteria) if (c.verdict === "no") out.push({ part: "caption", id: c.id, reason: c.reason });
  return out;
}
