// Free Model Aggregator (live) — one server, two wires, a real free model behind every answer.
//
// The entry is a quality-ordered router over OpenRouter's free models: for each prompt it dials the
// best-rated free model that meets the prompt's requirements (JSON mode, tools, vision), straight
// through the grader's gateway, and it never answers from its own text. When a model refuses, it
// fails over to the next best candidate and reports the refusals it survived, so the failover column
// can see them. Nothing here reads a clock or rolls dice: every choice comes from the brief, the
// request and the gateway's answers, so a replay makes exactly the live pass's requests.
//
// A trial gives this server:
//   - the brief at $MAKEFUN_PROMPT_FILE: the fourteen free models with the house's rating and
//     capabilities, and the six prompts in the order the client sends them;
//   - the env at $MAKEFUN_ENV_URL: POST /register, then GET /work until it says done;
//   - the gateway at $OPENAI_BASE_URL: the only route any model call takes, on the trial's dummy key
//     (the gateway swaps it for the entrant's pushed OpenRouter key; the real key never enters here).
// `node main.ts --list` prints the catalog this server registers, byte for byte, and exits 0.
//
// ROUTING (quality is 60% of the score)
//   Candidates are the brief's free models that meet the prompt's requirements, ranked by the brief's
//   rating_milli, highest first, ties broken by id so the order is fixed. The prompt's requirements
//   come from the brief's manifest row, in arrival order — the house's own declaration of what the
//   prompt needs — with the request body as fallback when the brief holds no row.
//
// FAILOVER (10% of the score) AND RATE LIMITS
//   A prompt costs at most 3 gateway calls: the best candidate, then the next best, then one more.
//   A model that refuses is never tried again for that prompt, but it stays a candidate for the next
//   one: a refusal is usually a passing rate-limit blip or a momentary overload, and demoting the
//   best model for the whole trial would cost quality (60%) on every later prompt to save a call or
//   two — calls only break exact ties. A 401 is key-scoped, not model-scoped: the prompt is given up
//   at once (no other model could pass it) and the next prompt starts fresh. A global cap of 55
//   calls a trial stays far under the gateway's 60-call cap. Every refusal a recovered answer
//   survived is reported in the x-makefun-upstream-failures header, at most 8 rows, in the order
//   they happened.
//
// THE MODEL FIELD
//   Whatever this server reports in a response's `model` field is the model it actually dialled: the
//   id goes to the gateway in the request and comes back on every answer and every streamed chunk
//   (the provider spells it without the gateway's `openrouter/` prefix; lib/wire.ts puts the dialled
//   id back). A reported model with no matching successful call in the house's record earns nothing.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCatalog,
  capabilitiesOf,
  freeModels,
  isRecord,
  meetsRequirements,
  readBrief,
  type CatalogReport,
  type Json,
  type ModelRow,
  type Requirement,
} from './lib/providers.ts';
import {
  anthropicError,
  anthropicEventsFromOpenAI,
  anthropicModelList,
  anthropicToOpenAI,
  openAIError,
  openAIJsonWithModel,
  openAIModelList,
  openAIStreamWithModel,
  openAIToAnthropic,
  type ServedModel,
} from './lib/wire.ts';

/** The wire protocol's version, in the register body. */
const PROTOCOL_VERSION = 1;
/** How often GET /work is polled, in milliseconds. */
const POLL_INTERVAL_MS = 100;
/** The most bytes of one client request body this server reads. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** The most gateway dials one prompt may cost: first try plus two failovers. */
const MAX_ATTEMPTS_PER_PROMPT = 3;
/** The most gateway dials one trial may cost: far under the gateway's 60-call cap. */
const MAX_CALLS_PER_TRIAL = 55;
/** The most refusal rows one answer reports. */
const MAX_TRAIL_FAILURES = 8;
/** The header that carries the refusals a recovered answer survived. */
const FAILURES_HEADER = 'x-makefun-upstream-failures';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
/** The trial's dummy key for the gateway lane; the gateway swaps it for the entrant's own key. */
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);
/** Which prompt row the request now arriving is: the brief's prompts are in the client's arrival order. */
let manifestIndex = 0;
/** Gateway dials made so far this trial, against MAX_CALLS_PER_TRIAL. */
let callsMade = 0;

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

/**
 * The gateway's Chat Completions route. OPENAI_BASE_URL is the OpenAI-compatible root (`…/v1` on the
 * trial network); a base that does not already end in `/v1` gets one, so both spellings reach it.
 */
function chatCompletionsUrl(): string {
  if (GATEWAY_URL === '') return '';
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

/** The free models the brief lists, as GET /v1/models names them. */
function servedModels(): ServedModel[] {
  return freeModels(brief).map((model) => ({ id: model.id, provider: model.provider, display_name: model.display_name }));
}

/**
 * One refusal a prompt survived, as the failover column reads it: the gateway's status, a short code,
 * and the model that was dialled (null when no model was).
 */
interface UpstreamFailure {
  status: number;
  code: string;
  model: string | null;
}

/**
 * The candidates for a prompt, best first: the brief's free models that meet the requirements, ranked
 * by the brief's rating_milli (highest first, ties by id), so the order is fixed and a replay takes
 * the same path the live pass took.
 */
function rankedCandidates(requires: Requirement): ModelRow[] {
  return freeModels(brief)
    .filter((model) => meetsRequirements(requires, capabilitiesOf(model)))
    .sort((a, b) => {
      const rating = b.rating_milli - a.rating_milli;
      if (rating !== 0) return rating;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/** The requirements of the prompt now arriving: the brief's row by arrival order, else the body's own. */
function requirementsFor(body: Json): Requirement {
  const entry = brief.prompts[manifestIndex];
  manifestIndex += 1;
  if (entry !== undefined) return entry.requires;
  // The brief's prompt list is the declared source of each request's requirements; this fallback is
  // a guess for a brief that holds none.
  return requirementsFromBody(body);
}

/** Requirements read off a request body, when the brief has no row for it. */
function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return { tools: Array.isArray(body.tools) && body.tools.length > 0, vision, json: format === 'json_object' || format === 'json_schema' };
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** A short code for a refused gateway call, from its error body when it names one. */
function codeOf(status: number, text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value) && isRecord(value.error)) {
      const code = value.error.code;
      if (typeof code === 'string' && code !== '') return code;
      const type = value.error.type;
      if (typeof type === 'string' && type !== '') return type;
    }
  } catch {
    // Not JSON: fall through to the status-based code.
  }
  if (status === 400) return 'invalid_request';
  if (status === 401) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_error';
  return `http_${status}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extraHeaders });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string, extraHeaders: Record<string, string> = {}): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message), extraHeaders);
  else sendJson(res, status, openAIError(message, type, null), extraHeaders);
}

/** The trail header for a prompt's refusals: nothing when the prompt survived none. */
function trailHeaders(trail: UpstreamFailure[]): Record<string, string> {
  if (trail.length === 0) return {};
  return { [FAILURES_HEADER]: JSON.stringify(trail.slice(0, MAX_TRAIL_FAILURES)) };
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

/** POST one request to the gateway's Chat Completions route, naming the model this entry dialled. */
async function dial(model: string, body: Json): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (body.stream === true) headers.accept = 'text/event-stream';
  return fetch(chatCompletionsUrl(), { method: 'POST', headers, body: JSON.stringify({ ...body, model }) });
}

/** What one prompt's dialling came back with: a live upstream answer, or the trail of its refusals. */
interface Attempt {
  ok: boolean;
  model: ModelRow | null;
  upstream: Response | null;
  trail: UpstreamFailure[];
}

/**
 * Dial the gateway for one prompt, failing over down the ranked candidates. Each attempt names the
 * model it dials; a refusal is recorded and that model is not tried again for this prompt. A 401 is
 * key-scoped — no other model could pass it — so the prompt is given up at once. The loop never
 * spends more than MAX_ATTEMPTS_PER_PROMPT calls on one prompt, and never more than
 * MAX_CALLS_PER_TRIAL in the trial, so the gateway's 60-call cap is never the thing that stops it.
 */
async function attempt(requires: Requirement, gatewayBody: Json): Promise<Attempt> {
  const trail: UpstreamFailure[] = [];
  const tried = new Set<string>();
  let attempts = 0;
  while (attempts < MAX_ATTEMPTS_PER_PROMPT && callsMade < MAX_CALLS_PER_TRIAL) {
    const candidates = rankedCandidates(requires).filter((model) => !tried.has(model.id));
    if (candidates.length === 0) break;
    const model = candidates[0];
    tried.add(model.id);
    attempts += 1;
    callsMade += 1;
    let upstream: Response;
    try {
      upstream = await dial(model.id, gatewayBody);
    } catch (err) {
      // The gateway itself was unreachable: a refusal with no HTTP status of its own.
      trail.push({ status: 502, code: 'upstream_unreachable', model: model.id });
      log(`dial ${model.id}: ${(err as Error).message}`);
      continue;
    }
    if (upstream.ok && upstream.body !== null) return { ok: true, model, upstream, trail };
    const text = await upstream.text();
    trail.push({ status: upstream.status, code: codeOf(upstream.status, text), model: model.id });
    if (upstream.status === 401) break;
  }
  return { ok: false, model: null, upstream: null, trail };
}

/** A prompt no model served, as a 502 in the client's wire, carrying the trail of what refused it. */
function refused(res: ServerResponse, wire: 'openai' | 'anthropic', trail: UpstreamFailure[]): void {
  const last = trail[trail.length - 1];
  const detail = last === undefined ? 'no free model answered' : `the gateway answered HTTP ${last.status} (${last.code})`;
  const headers = trailHeaders(trail);
  if (wire === 'anthropic') sendError(res, wire, 502, 'api_error', detail, headers);
  else sendError(res, wire, 502, 'upstream_error', detail, headers);
}

/** POST /v1/chat/completions: an OpenAI-shaped client, answered by the best free model that meets it. */
async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const requires = requirementsFor(body);
  const gatewayBody: Json = { ...body, model: 'auto' };
  const result = await attempt(requires, gatewayBody);
  if (!result.ok || result.model === null || result.upstream === null) return refused(res, 'openai', result.trail);
  const model = result.model;
  const upstream = result.upstream;
  const headers = trailHeaders(result.trail);
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...headers });
    try {
      for await (const frame of openAIStreamWithModel(upstream.body, model.id)) res.write(frame);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json();
  sendJson(res, 200, openAIJsonWithModel(isRecord(answer) ? answer : {}, model.id), headers);
}

/** POST /v1/messages: an Anthropic-shaped client, rewritten to Chat Completions and answered back. */
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const requires = requirementsFor(body);
  const result = await attempt(requires, anthropicToOpenAI(body, 'auto'));
  if (!result.ok || result.model === null || result.upstream === null) return refused(res, 'anthropic', result.trail);
  const model = result.model;
  const upstream = result.upstream;
  const headers = trailHeaders(result.trail);
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...headers });
    try {
      for await (const event of anthropicEventsFromOpenAI(upstream.body, model.id)) res.write(event);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json();
  sendJson(res, 200, openAIToAnthropic(isRecord(answer) ? answer : {}, model.id), headers);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messages(req, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the trial's prompt count. */
async function register(port: number, report: CatalogReport): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the trial holds ${reply.requests} prompts`);
}

/** Poll GET /work every 100 ms; exit 0 the moment it says done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte: print the one built object and stop
    // before any server starts. A process whose stdout is not flushed loses the tail, so wait for it.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (chatCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  // 8080 is the env's on one layout; the OS's ephemeral range never holds it, and the guard says so.
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${servedModels().length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
