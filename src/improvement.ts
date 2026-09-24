import { settings } from "./config.ts";
import {
  assetExists,
  createKnowledgeAsset,
  discardDraftIfPresent,
  graphsWithPredicate,
  readGraph,
  resolveSharedGraph,
  subjectToObject,
  verifyShared,
  type ResolvedAsset,
} from "./dkg.ts";
import { RDF_TYPE, int, iri, str, uniqueTriples, type TripleSpec } from "./ttl.ts";

/*
 * Improvement Memory = the owner's confirmed lessons, kept in its own Knowledge Asset series
 * (improvement-memory-v1, -v2, ...) in the same context graph as Business Memory.
 * Every version is a CUMULATIVE snapshot: vN holds all earlier lessons plus the newest change.
 * A lesson is the owner's own words from a rejection, stored verbatim and confirmed immediately
 * (the owner typed it, so the owner confirmed it). Nothing is reworded by a model.
 */

const NS = "https://threadbiz.example/#"; // same vocabulary as Business Memory
const SUBJECT = `${NS}improvement-memory`;
export const IMPROVEMENT_PREFIX = "improvement-memory-v";

export interface LessonOccurrence {
  ownerReason: string;
  runId: string;
  recordedAt: string;
  rejectedCaption: string;
  rejectedImage: string;
}

export interface Lesson {
  id: string;
  status: string;
  /** The owner's most recent wording of this rule (verbatim). */
  rule: string;
  occurrenceCount: number;
  firstRecordedAt: string;
  lastRecordedAt: string;
  occurrences: LessonOccurrence[];
}

export interface LoadedImprovement {
  /** null when no improvement memory exists yet, or when it was switched off with --improvement none. */
  asset: ResolvedAsset | null;
  version: number;
  lessons: Lesson[];
  mode: "latest" | "none" | "none-yet" | "pinned";
}

const toArray = (v: unknown): any[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

function parseLessons(obj: Record<string, any>): Lesson[] {
  return toArray(obj.lesson)
    .map((l) => {
      const occurrences: LessonOccurrence[] = toArray(l.occurrence)
        .map((o) => ({
          ownerReason: String(o.ownerReason ?? ""),
          runId: String(o.runId ?? ""),
          recordedAt: String(o.recordedAt ?? ""),
          rejectedCaption: String(o.rejectedCaption ?? ""),
          rejectedImage: String(o.rejectedImage ?? ""),
        }))
        .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
      return {
        id: String(l.lessonId),
        status: String(l.status),
        rule: String(l.rule),
        occurrenceCount: Number(l.occurrenceCount ?? occurrences.length),
        firstRecordedAt: String(l.firstRecordedAt ?? ""),
        lastRecordedAt: String(l.lastRecordedAt ?? ""),
        occurrences,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Every improvement-memory version number in shared memory. Falls back to checking names one by one if the discovery query itself errors. */
async function discoverVersions(cg: string): Promise<number[]> {
  try {
    const found = await graphsWithPredicate(cg, `${NS}version`, SUBJECT);
    return found.map((f) => Number(f.value)).filter((n) => Number.isInteger(n) && n > 0);
  } catch (err: any) {
    console.warn(`  (version discovery query failed: ${String(err.message).slice(0, 140)}; checking asset names one by one instead)`);
    const out: number[] = [];
    for (let n = 1; n <= 200 && (await assetExists(`${IMPROVEMENT_PREFIX}${n}`, cg)); n++) out.push(n);
    return out;
  }
}

/**
 * which = "latest" (default), "none" (switch lessons off, for before/after comparisons),
 * or an exact asset name such as "improvement-memory-v1".
 */
export async function loadImprovementMemory(which = "latest"): Promise<LoadedImprovement> {
  const cg = settings.dkg.memoryContextGraph;
  if (which === "none") return { asset: null, version: 0, lessons: [], mode: "none" };

  let name = which;
  let mode: LoadedImprovement["mode"] = "pinned";
  if (which === "latest") {
    mode = "latest";
    const versions = await discoverVersions(cg);
    if (!versions.length) {
      // Belt and braces: never silently treat "could not find it" as "there is none".
      if (await assetExists(`${IMPROVEMENT_PREFIX}1`, cg)) {
        throw new Error(`${IMPROVEMENT_PREFIX}1 exists but version discovery found nothing; refusing to continue without the owner's lessons`);
      }
      return { asset: null, version: 0, lessons: [], mode: "none-yet" };
    }
    const latest = Math.max(...versions);
    if (versions.filter((v) => v === latest).length > 1) {
      throw new Error(`More than one shared improvement memory claims version ${latest}; resolve this before continuing`);
    }
    name = `${IMPROVEMENT_PREFIX}${latest}`;
  } else if (!new RegExp(`^${IMPROVEMENT_PREFIX}\\d+$`).test(which)) {
    throw new Error(`--improvement must be "latest", "none", or a name like ${IMPROVEMENT_PREFIX}1 (got "${which}")`);
  }

  const asset = await resolveSharedGraph(name, cg);
  const obj = subjectToObject(await readGraph(asset), "improvement-memory") as Record<string, any>;
  if (obj.businessId !== settings.businessId) throw new Error(`${name} belongs to ${obj.businessId}, expected ${settings.businessId}`);
  const version = Number(obj.version);
  if (`${IMPROVEMENT_PREFIX}${version}` !== name) throw new Error(`${name} says it is version ${obj.version}; refusing to use inconsistent memory`);
  return { asset, version, lessons: parseLessons(obj), mode };
}

/** Only owner-confirmed lessons are ever given to the writer or the judge. */
export const activeLessons = (lessons: Lesson[]) => lessons.filter((l) => l.status === "confirmed");

/**
 * The rule as the writer and judge see it: EVERY distinct wording the owner has used for this lesson,
 * verbatim and in order, so a later, narrower wording can never weaken an earlier, broader one.
 */
export function lessonRuleText(l: Lesson): string {
  const distinct = [...new Set(l.occurrences.map((o) => o.ownerReason.trim()).filter(Boolean))];
  if (distinct.length <= 1) return distinct[0] ?? l.rule;
  return `The owner has put this rule in these words, and ALL of them apply: ${distinct.map((r) => `"${r}"`).join(" and ")}`;
}

export function lessonsForPrompt(lessons: Lesson[]): string {
  return activeLessons(lessons)
    .map((l) => `- ${l.id}${l.occurrenceCount > 1 ? ` (the owner has rejected drafts for this ${l.occurrenceCount} times)` : ""}: ${lessonRuleText(l)}`)
    .join("\n");
}

// ---------------------------------------------------------------------------------------------
// Writing the next version
// ---------------------------------------------------------------------------------------------

function lessonTriples(l: Lesson): TripleSpec[] {
  const s = `${NS}${l.id}`;
  const out: TripleSpec[] = [
    { s, p: RDF_TYPE, o: iri(`${NS}OwnerLesson`) },
    { s, p: `${NS}lessonId`, o: str(l.id) },
    { s, p: `${NS}status`, o: str(l.status) },
    { s, p: `${NS}source`, o: str("owner-rejection") },
    { s, p: `${NS}rule`, o: str(l.rule) },
    { s, p: `${NS}occurrenceCount`, o: int(l.occurrenceCount) },
    { s, p: `${NS}firstRecordedAt`, o: str(l.firstRecordedAt) },
    { s, p: `${NS}lastRecordedAt`, o: str(l.lastRecordedAt) },
  ];
  l.occurrences.forEach((occ, i) => {
    const o = `${NS}${l.id}-occurrence-${i + 1}`;
    out.push(
      { s, p: `${NS}occurrence`, o: iri(o) },
      { s: o, p: RDF_TYPE, o: iri(`${NS}LessonOccurrence`) },
      { s: o, p: `${NS}ownerReason`, o: str(occ.ownerReason) },
      { s: o, p: `${NS}runId`, o: str(occ.runId) },
      { s: o, p: `${NS}recordedAt`, o: str(occ.recordedAt) },
      { s: o, p: `${NS}rejectedCaption`, o: str(occ.rejectedCaption) },
      { s: o, p: `${NS}rejectedImage`, o: str(occ.rejectedImage) }
    );
  });
  return out;
}

export function improvementTriples(version: number, lessons: Lesson[], changeNote: string, updatedAt: string): TripleSpec[] {
  const out: TripleSpec[] = [
    { s: SUBJECT, p: RDF_TYPE, o: iri(`${NS}ImprovementMemoryAsset`) },
    { s: SUBJECT, p: `${NS}businessId`, o: str(settings.businessId) },
    { s: SUBJECT, p: `${NS}version`, o: str(String(version)) },
    { s: SUBJECT, p: `${NS}updatedAt`, o: str(updatedAt) },
    { s: SUBJECT, p: `${NS}versionChangeNote`, o: str(changeNote) },
  ];
  if (version > 1) out.push({ s: SUBJECT, p: `${NS}previousVersion`, o: str(String(version - 1)) });
  for (const l of lessons) out.push({ s: SUBJECT, p: `${NS}lesson`, o: iri(`${NS}${l.id}`) }, ...lessonTriples(l));
  return uniqueTriples(out);
}

export interface LessonInput {
  reason: string;
  runId: string;
  rejectedCaption: string;
  rejectedImage: string;
  recordedAt: string;
  /** Existing lesson id when the owner says this is the same rule again (adds an occurrence instead of a new lesson). */
  sameAs?: string;
}

export interface LessonWriteResult {
  assetName: string;
  version: number;
  kaNumber: string;
  lessonId: string;
  newLesson: boolean;
  occurrenceCount: number;
  triples: number;
  previousVersion: number;
}

/**
 * Writes the owner's rejection reason, verbatim and confirmed, as the next cumulative
 * improvement-memory version, shares it to Shared Working Memory and reads it back to verify.
 */
export async function recordLesson(input: LessonInput): Promise<LessonWriteResult> {
  const reason = input.reason.trim();
  if (!reason) throw new Error("A lesson needs the owner's reason");
  const cg = settings.dkg.memoryContextGraph;

  const current = await loadImprovementMemory("latest");
  const lessons: Lesson[] = current.lessons.map((l) => ({ ...l, occurrences: [...l.occurrences] }));

  if (lessons.some((l) => l.occurrences.some((o) => o.runId === input.runId))) {
    throw new Error(`Run ${input.runId} is already recorded in ${current.asset?.name}; not writing it twice`);
  }

  const occurrence: LessonOccurrence = {
    ownerReason: reason,
    runId: input.runId,
    recordedAt: input.recordedAt,
    rejectedCaption: input.rejectedCaption,
    rejectedImage: input.rejectedImage,
  };

  let lesson: Lesson;
  let newLesson: boolean;
  if (input.sameAs) {
    const existing = lessons.find((l) => l.id === input.sameAs);
    if (!existing) throw new Error(`--same-as ${input.sameAs}: no such lesson in ${current.asset?.name ?? "improvement memory (none exists yet)"}`);
    existing.occurrences.push(occurrence);
    existing.occurrenceCount = existing.occurrences.length;
    existing.rule = reason; // the owner's latest wording; earlier wordings stay stored in occurrences
    existing.lastRecordedAt = input.recordedAt;
    lesson = existing;
    newLesson = false;
  } else {
    const nextNumber = Math.max(0, ...lessons.map((l) => Number(/^lesson-(\d+)$/.exec(l.id)?.[1] ?? 0))) + 1;
    lesson = {
      id: `lesson-${String(nextNumber).padStart(3, "0")}`,
      status: "confirmed",
      rule: reason,
      occurrenceCount: 1,
      firstRecordedAt: input.recordedAt,
      lastRecordedAt: input.recordedAt,
      occurrences: [occurrence],
    };
    lessons.push(lesson);
    newLesson = true;
  }

  const version = current.version + 1;
  const assetName = `${IMPROVEMENT_PREFIX}${version}`;
  const changeNote = newLesson
    ? `Added ${lesson.id} from the owner's rejection of run ${input.runId}.`
    : `Recorded another owner rejection (run ${input.runId}) of the same rule, ${lesson.id}; now seen ${lesson.occurrenceCount} times.`;
  const triples = improvementTriples(version, lessons, changeNote, input.recordedAt.slice(0, 10));

  // A leftover unshared draft from an interrupted earlier attempt would block the name; a shared one is never touched.
  await discardDraftIfPresent(assetName, cg);
  await createKnowledgeAsset({ name: assetName, contextGraph: cg, triples, share: true });
  const verified = await verifyShared(assetName, cg, triples);

  return {
    assetName,
    version,
    kaNumber: verified.kaNumber,
    lessonId: lesson.id,
    newLesson,
    occurrenceCount: lesson.occurrenceCount,
    triples: verified.tripleCount,
    previousVersion: current.version,
  };
}
