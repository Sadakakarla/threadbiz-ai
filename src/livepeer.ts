import { settings } from "./config.ts";

let rpcId = 0;

/** Every raw Livepeer response is kept so the run file can prove what actually happened. */
export const rawLog: { label: string; request: unknown; response: unknown }[] = [];

function parseRpcBody(body: string, id: number): any {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const messages = trimmed
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => {
      try {
        return JSON.parse(l.slice(5).trim());
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const match = messages.find((m: any) => m.id === id) ?? messages[messages.length - 1];
  if (!match) throw new Error(`Unparseable Livepeer response: ${trimmed.slice(0, 300)}`);
  return match;
}

async function rpc(method: string, params: unknown): Promise<any> {
  const id = ++rpcId;
  const res = await fetch(settings.livepeer.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Livepeer HTTP ${res.status}: ${body.slice(0, 500)}`);
  const msg = parseRpcBody(body, id);
  if (msg.error) throw new Error(`Livepeer RPC error: ${JSON.stringify(msg.error).slice(0, 500)}`);
  return msg.result;
}

function extractToolData(result: any): any {
  if (result?.structuredContent) return result.structuredContent;
  const texts: string[] = (result?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text);
  for (const t of texts) {
    try {
      return JSON.parse(t);
    } catch {
      /* not JSON, try next */
    }
  }
  return texts.length ? { text: texts.join("\n") } : result;
}

export async function callTool(label: string, name: string, args: Record<string, unknown>): Promise<any> {
  const result = await rpc("tools/call", { name, arguments: args });
  rawLog.push({ label, request: { tool: name, arguments: args }, response: result });
  const data = extractToolData(result);
  if (result?.isError || data?.ok === false) {
    throw new Error(`${name} failed: ${JSON.stringify(data ?? result).slice(0, 800)}`);
  }
  return data;
}

function findJobId(data: any): string | undefined {
  return data?.job_id ?? data?.jobId ?? data?.job?.id ?? data?.result?.job_id;
}

function isFinished(data: any): boolean {
  const status = String(data?.status ?? data?.state ?? "");
  if (/pending|queued|running|processing|in_progress/i.test(status)) return false;
  return data?.result !== undefined || /complete|succeed|done|success/i.test(status);
}

async function pollJob(label: string, jobId: string): Promise<any> {
  for (let attempt = 1; attempt <= 45; attempt++) {
    await new Promise((r) => setTimeout(r, 4000));
    const data = await callTool(`${label}:poll${attempt}`, "get_create_media", { job_id: jobId });
    if (/fail|error|cancel/i.test(String(data?.status ?? ""))) throw new Error(`Job ${jobId} failed: ${JSON.stringify(data).slice(0, 500)}`);
    if (isFinished(data)) return data;
  }
  throw new Error(`Job ${jobId} did not finish in time`);
}

export interface CapabilityCall {
  label: string;
  capability: string;
  prompt?: string;
  inputs?: Record<string, unknown>;
  persist?: boolean;
  timeout?: number;
  sessionId?: string;
  idempotencyKey?: string;
}

export async function runCapability(call: CapabilityCall): Promise<any> {
  const args: Record<string, unknown> = { capability: call.capability };
  if (call.prompt !== undefined) args.prompt = call.prompt;
  if (call.inputs) args.inputs = call.inputs;
  if (call.persist) args.persist = true;
  if (call.timeout) args.timeout = call.timeout;
  if (call.sessionId) args.session_id = call.sessionId;
  if (call.idempotencyKey) args.idempotency_key = call.idempotencyKey;

  const data = await callTool(call.label, "run_capability", args);
  const jobId = findJobId(data);
  if (jobId && !isFinished(data)) return pollJob(call.label, jobId);
  return data;
}

export function costOf(data: any): number {
  const c = data?.cost_usd_estimated ?? data?.cost_usd ?? data?.result?.cost_usd;
  return typeof c === "number" ? c : 0;
}

export async function generateText(label: string, capability: string, prompt: string, sessionId: string) {
  const data = await runCapability({ label, capability, prompt, timeout: 60, sessionId });
  const text = data?.result?.text ?? data?.text;
  if (typeof text !== "string" || !text.trim()) throw new Error(`${capability} returned no text: ${JSON.stringify(data).slice(0, 300)}`);
  return { text, cost: costOf(data), model: data?.result?.model_id ?? data?.capability ?? capability };
}

/** Collects every http(s) URL in a response, with the JSON path it was found at. */
function collectUrls(obj: any, path = "", out: { path: string; url: string }[] = []) {
  if (typeof obj === "string") {
    if (/^https?:\/\//.test(obj)) out.push({ path, url: obj });
  } else if (Array.isArray(obj)) {
    obj.forEach((v, i) => collectUrls(v, `${path}[${i}]`, out));
  } else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) collectUrls(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

export async function generateImage(label: string, prompt: string, sessionId: string, idempotencyKey: string) {
  const requested = settings.livepeer.imageModel;
  const data = await runCapability({
    label,
    capability: requested,
    prompt,
    persist: settings.livepeer.persistImages,
    timeout: 120,
    sessionId,
    idempotencyKey,
  });
  const urls = collectUrls(data).filter((u) => !/prompt/i.test(u.path));
  const chosen =
    urls.find((u) => /persist|durable|hosted|permanent|stored/i.test(u.path)) ??
    urls.find((u) => /image|url|output/i.test(u.path)) ??
    urls[0];
  if (!chosen) throw new Error(`No image URL in ${requested} response: ${JSON.stringify(data).slice(0, 500)}`);

  const fallbackKeys = Object.keys(data ?? {}).filter((k) => /fallback/i.test(k));
  return {
    url: chosen.url,
    urlPath: chosen.path,
    allUrls: urls,
    requestedCapability: requested,
    capabilityThatRan: data?.capability ?? requested,
    providerModel: data?.result?.model_id ?? data?.model_id ?? data?.model ?? null,
    fallbackInfo: Object.fromEntries(fallbackKeys.map((k) => [k, data[k]])),
    cost: costOf(data),
  };
}

/** Reads width/height from PNG or JPEG bytes without extra dependencies. */
export function imageSize(buf: Buffer): { format: string; width: number; height: number } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { format: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { format: "jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  if (buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { format: "webp", width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === "VP8 ") return { format: "webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}
