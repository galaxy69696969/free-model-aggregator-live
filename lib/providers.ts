// Reading the brief: the free model list, the six prompts, and the catalog.
//
// A trial hands this server its brief through MAKEFUN_PROMPT_FILE. The brief is prose wrapped
// around two JSON documents, and only the documents matter: the prose is never read. Each document
// names its shape in a `schema` string under this contest's prefix, and this module finds each one
// by the arrays it carries rather than by any single name — the brief may spell the model list
// `models` or `ratings` and the prompts `prompts` or `manifest` (the sibling contest's names),
// and one document may even carry both lists at once.
//
//   models  — one row per free model, keyed by the id the gateway routes
//             (`openrouter/<vendor>/<model>:free`): its public rating in milli-points, what it
//             can do (tools, vision, JSON mode, context length) and its free flag. Only a free
//             model ever serves a prompt; a paid row is never routed.
//   prompts — the six prompts the house's client sends, in arrival order: each with its id, its
//             wire (`openai` or `anthropic`), whether it streams, its weight (1 or 2) and the
//             requirements a model must meet to serve it. The client sends the bodies; this module
//             reads the list up front so the server can route each arrival by its row.
//
// Nothing here looks at a clock or rolls dice: the same brief always builds the same catalog, so
// `node main.ts --list` and the register body print the same document byte for byte on a live
// pass and on its replay.

import * as nodeFs from 'node:fs';

/** The prefix every schema name in this contest's brief starts with. */
const SCHEMA_PREFIX =
  'free-model-aggregator-02/';

/** The schema name of the free model list document. */
export const MODELS_SCHEMA =
  'free-model-aggregator-02/models/v1';
/** The schema name of the six prompts document. */
export const PROMPTS_SCHEMA =
  'free-model-aggregator-02/prompts/v1';
/** The public base URL of the provider the free models belong to: the endpoint the gateway reaches. */
export const OPENROUTER_PUBLIC_BASE =
  'https://openrouter.ai/api/v1';
/** The environment variable an entrant's OpenRouter key is pushed under (kept out of the sandbox). */
export const OPENROUTER_KEY_ENV =
  'OPENROUTER_API_KEY';

/** A JSON object: string keys holding values of any shape. */
export type Json = { [key: string]: unknown };

/** Whether `value` is a JSON object — not null, not an array, not a scalar. */
export function isRecord(value: unknown): value is Json {
  if (value === null) return false;
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  return true;
}

/** One free model as the brief lists it. */
export interface ModelRow {
  id: string; // the id the gateway routes: openrouter/<vendor>/<model>:free
  display_name: string; // the brief's human name for the model
  provider: string; // the provider, as the brief names it (openrouter)
  rating_milli: number; // the published rating in milli-points
  free: boolean; // true unless the brief says free: false
  context_length: number | null; // longest context, null when the brief does not say
  tools: boolean | null; // can it call tools, null when the brief does not say
  vision: boolean | null; // can it see images, null when the brief does not say
  json: boolean | null; // can it answer in JSON mode, null when the brief does not say
}

/** What a prompt demands of the model that serves it. */
export interface Requirement {
  tools?: boolean; // the prompt needs tool calls
  vision?: boolean; // the prompt needs image input
  json?: boolean; // the prompt needs JSON mode
  min_context?: number; // the prompt needs at least this much context
}

/** One prompt the client will send, in the brief's words. */
export interface PromptRow {
  id: string; // the prompt's id
  api: 'openai' | 'anthropic'; // which wire the client uses for it
  stream: boolean; // whether the client asks for a stream
  weight: 1 | 2; // the prompt's weight in the score
  requires: Requirement; // what a model must meet to serve it
}

/** The brief as this module reads it. `error` is set when a document could not be read. */
export interface Brief {
  models: ModelRow[]; // the brief's model rows, in the brief's order
  prompts: PromptRow[]; // the brief's prompt rows, in the brief's order
  error: string | null; // null when both documents read cleanly
}

/** One model as the catalog document lists it. */
export interface CatalogModel {
  id: string; // the id the gateway routes
  free: boolean; // always true: the catalog lists free models only
  context_length: number | null; // longest context, null when the brief does not say
}

/** One provider as the catalog document lists it. */
export interface CatalogProvider {
  id: string; // the provider id (openrouter)
  base_url: string; // the provider's public endpoint
  key_env: string; // the env var holding the entrant's key
  wire: 'openai'; // the wire the provider speaks
  models: CatalogModel[]; // the free models it serves, in the brief's order
}

/** The document `--list` prints and the entry POSTs to /register — one document, byte for byte. */
export interface CatalogReport {
  providers: CatalogProvider[]; // the providers, one for this contest
}

/** A model's abilities, as the brief's row states them (null where it stays silent). */
export interface Capabilities {
  context_length: number | null; // longest context, null when unknown
  tools: boolean | null; // can it call tools, null when unknown
  vision: boolean | null; // can it see images, null when unknown
  json: boolean | null; // can it answer in JSON mode, null when unknown
}

/** The text of `value` when it is a string, else the empty string. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The number in `value` when it is finite, else null. */
function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

/** The boolean in `value` when it is one, else null. */
function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** The first of `fields` on `row` that holds a non-empty string, else the empty string. */
function firstText(row: Json, fields: readonly string[]): string {
  for (const field of fields) {
    const text = asText(row[field]);
    if (text !== '') return text;
  }
  return '';
}

/**
 * The index of the `}` that closes the object opening at `open`, or -1 when the text runs out
 * first. Characters inside strings do not count as braces, and a backslash inside a string
 * escapes the character after it, so a `}` in a string value never closes the object early.
 */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Every JSON object in `text` that carries a string `schema`, in the order they appear. Each
 * `{` in the text is tried as an object start, so a document nested inside prose that is not
 * itself JSON is still found; a span that does not parse on its own is skipped.
 */
function schemaDocuments(text: string): Json[] {
  const docs: Json[] = [];
  let cursor = 0;
  for (;;) {
    const open = text.indexOf('{', cursor);
    if (open === -1) break;
    cursor = open + 1;
    const close = closingBrace(text, open);
    if (close === -1) continue;
    try {
      const parsed: unknown = JSON.parse(text.slice(open, close + 1));
      if (isRecord(parsed) && typeof parsed.schema === 'string') docs.push(parsed);
    } catch {
      // Not a JSON object on its own: keep scanning from the next brace.
    }
  }
  return docs;
}

/**
 * The first document whose schema names this contest and which carries one of `keys` as an array,
 * with the key it was found under. Documents are tried in the order they appear and keys in the
 * order given, so a brief that spells its lists in the sibling contest's names still reads.
 */
function listDocument(documents: readonly Json[], keys: readonly string[]): { document: Json; key: string } | null {
  const hit = documents.find((doc) => {
    if (!asText(doc.schema).includes(SCHEMA_PREFIX)) return false;
    return keys.some((key) => Array.isArray(doc[key]));
  });
  if (hit === undefined) return null;
  const key = keys.find((candidate) => Array.isArray(hit[candidate]));
  if (key === undefined) return null;
  return { document: hit, key };
}

/**
 * One model row. The id is the row's `id`, or its `model` when it gives no id; a row that gives
 * the bare OpenRouter id (`vendor/model:free`) and names `openrouter` is routed as the gateway
 * spells it (`openrouter/vendor/model:free`). A row is free unless it says `free: false`, and a
 * paid row is never routed.
 */
function normalizeModel(raw: unknown): ModelRow | null {
  if (!isRecord(raw)) return null;
  const bare = firstText(raw, ['id', 'model']);
  if (bare === '') return null;
  const named = firstText(raw, ['provider', 'wire']);
  const routed = named === 'openrouter' && !/^openrouter\//i.test(bare) ? `openrouter/${bare}` : bare;
  const display = asText(raw.display_name);
  const provider = named === '' ? 'openrouter' : named;
  return {
    id: routed,
    display_name: display !== '' ? display : bare,
    provider,
    rating_milli: asFiniteNumber(raw.rating_milli) ?? 0,
    free: raw.free !== false,
    context_length: asFiniteNumber(raw.context_length),
    tools: asBoolean(raw.tools),
    vision: asBoolean(raw.vision),
    json: asBoolean(raw.json),
  };
}

/** One prompt row. A requirement only counts when the brief states it outright (`true`). */
function normalizePrompt(raw: unknown): PromptRow | null {
  if (!isRecord(raw)) return null;
  const id = asText(raw.id);
  if (id === '') {
    return null;
  }
  const stated = isRecord(raw.requires) ? raw.requires : {};
  const needs: Requirement = {};
  if (stated.tools === true) needs.tools = true;
  if (stated.vision === true) needs.vision = true;
  if (stated.json === true) needs.json = true;
  const minContext = asFiniteNumber(stated.min_context);
  if (minContext !== null) needs.min_context = minContext;
  return {
    id,
    api: raw.api === 'anthropic' ? 'anthropic' : 'openai',
    stream: raw.stream === true,
    weight: raw.weight === 2 ? 2 : 1,
    requires: needs,
  };
}

/** The brief at `path`: its two documents, found under this contest's schema prefix. */
export function readBrief(path: string): Brief {
  if (path === '') {
    return { models: [], prompts: [], error: 'MAKEFUN_PROMPT_FILE is not set' };
  }
  let text: string;
  try {
    text = nodeFs.readFileSync(path, 'utf8');
  } catch (err) {
    const problem = `cannot read ${path}: ${(err as Error).message}`;
    return { models: [], prompts: [], error: problem };
  }
  const documents = schemaDocuments(text);
  const modelsFound = listDocument(documents, ['models', 'ratings']);
  if (modelsFound === null) {
    const missing = `the brief at ${path} holds no ${MODELS_SCHEMA} document`;
    return { models: [], prompts: [], error: missing };
  }
  const models: ModelRow[] = [];
  for (const row of modelsFound.document[modelsFound.key] as unknown[]) {
    const model = normalizeModel(row);
    if (model !== null) models.push(model);
  }
  const promptsFound = listDocument(documents, ['prompts', 'manifest']);
  if (promptsFound === null) {
    const missing = `the brief at ${path} holds no ${PROMPTS_SCHEMA} document`;
    return { models, prompts: [], error: missing };
  }
  const prompts: PromptRow[] = [];
  for (const row of promptsFound.document[promptsFound.key] as unknown[]) {
    const prompt = normalizePrompt(row);
    if (prompt !== null) prompts.push(prompt);
  }
  const brief: Brief = { models, prompts, error: null };
  return brief;
}

/** The brief's free models, in the brief's order: the only ones this entry may serve. */
export function freeModels(brief: Brief): ModelRow[] {
  const free: ModelRow[] = [];
  for (const model of brief.models) {
    if (model.free) free.push(model);
  }
  return free;
}

/** A model's abilities, read off its brief row. */
export function capabilitiesOf(model: ModelRow): Capabilities {
  const { context_length, tools, vision, json } = model;
  return { context_length, tools, vision, json };
}

/** Whether a model's abilities satisfy a prompt's demands — an unstated ability never satisfies one. */
export function meetsRequirements(requires: Requirement, caps: Capabilities): boolean {
  const flags: Array<['tools' | 'vision' | 'json', boolean | null]> = [
    ['tools', caps.tools],
    ['vision', caps.vision],
    ['json', caps.json],
  ];
  for (const [name, have] of flags) {
    if (requires[name] === true && have !== true) return false;
  }
  if (requires.min_context !== undefined) {
    if (caps.context_length === null || caps.context_length < requires.min_context) return false;
  }
  return true;
}

/**
 * The catalog built from the brief's free model list: one provider and the models it serves.
 *
 * The base_url is the provider's public endpoint, never the gateway's trial-local address: the
 * gateway's origin is not the same on a live pass and on its replay, and the catalog ships in
 * the state export a replay has to reproduce byte for byte.
 *
 * This entry registers every free model in the brief — exactly the fourteen dialable ids the
 * catalog column scores — so keep it that way: GET /v1/models (under either auth header) must
 * name exactly this set too, since listing fewer loses the column as surely as listing more.
 */
export function buildCatalog(brief: Brief): CatalogReport {
  const listed = new Map<string, CatalogModel>();
  for (const row of brief.models) {
    if (!row.free) continue;
    if (listed.has(row.id)) continue;
    listed.set(row.id, { id: row.id, free: true, context_length: row.context_length });
  }
  const models = [...listed.values()];
  if (models.length === 0) {
    return { providers: [] };
  }
  const provider: CatalogProvider = {
    id: 'openrouter',
    base_url: OPENROUTER_PUBLIC_BASE,
    key_env: OPENROUTER_KEY_ENV,
    wire: 'openai',
    models,
  };
  return { providers: [provider] };
}
