import { settings } from "./config.ts";
import { readGraph, resolveSharedGraph, subjectToObject, type ResolvedAsset } from "./dkg.ts";

export interface LoadedMemory {
  asset: ResolvedAsset;
  memory: Record<string, any>;
}

export interface LoadedEntry {
  asset: ResolvedAsset;
  entry: Record<string, any>;
  isPrivate: boolean;
  text: string;
}

/** Reads exactly one Business Memory version (e.g. "business-memory-v1") from its own named graph. */
export async function loadBusinessMemory(assetName: string): Promise<LoadedMemory> {
  const asset = await resolveSharedGraph(assetName, settings.dkg.memoryContextGraph);
  const triples = await readGraph(asset);
  const memory = subjectToObject(triples, "business-memory");
  if (memory.businessId !== settings.businessId) {
    throw new Error(`${assetName} belongs to ${memory.businessId}, expected ${settings.businessId}`);
  }
  return { asset, memory };
}

/** Reads one Journey Ledger entry (e.g. "entry-000") from a weekly journey asset (e.g. "journey-001"). */
export async function loadJourneyEntry(journeyAsset: string, entryId: string): Promise<LoadedEntry> {
  const asset = await resolveSharedGraph(journeyAsset, settings.dkg.journeyContextGraph);
  const triples = await readGraph(asset);
  const entry = subjectToObject(triples, entryId);
  const isVoiceNote = /voice/i.test(String(entry.sourceType ?? ""));
  const text = String(isVoiceNote ? entry.sourceReference : entry.description ?? "");
  if (!text.trim()) throw new Error(`${entryId} has no usable text`);
  return { asset, entry, isPrivate: entry.canBeUsedPublicly === false, text };
}
