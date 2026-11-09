#!/usr/bin/env node
// Export finished OpenMausBot traces to Langfuse over OTLP/HTTP JSON (Langfuse's native ingestion).
// OMB stores no prompts, replies, tool arguments or outputs in its traces; neither does this export.
// Only names, timing, tokens and cost leave the machine.
// Configuration: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and optional LANGFUSE_BASE_URL (Langfuse Cloud EU by default).
// Usage: langfuse.cjs check | sync
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = '0.1.0';
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE = 1 << 20;
const DAY_MS = 24 * 60 * 60_000;
const SETTLE_MS = 60_000;      // a finished turn's ledger and span lines are flushed by then
const LOOKBACK_DAYS = 2;       // roots started earlier are not read again
const KEEP_DAYS = 30;          // exported-root memory
const PAGE = 100;              // OMB's PAGE_MAX
const MAX_ROOTS = 500;         // per run; the next run continues
const BATCH = 20;              // roots per OTLP request
const CLOUD = 'https://cloud.langfuse.com';

/** The Langfuse origin (plus optional path prefix); HTTPS, or HTTP on loopback only. */
function baseUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw Error('LANGFUSE_BASE_URL is not a URL'); }
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname) || url.hostname.endsWith('.localhost');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw Error('LANGFUSE_BASE_URL must use HTTPS (HTTP only on localhost)');
  if (url.username || url.password || url.search || url.hash) throw Error('LANGFUSE_BASE_URL must not carry credentials, a query or a fragment');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function config(env) {
  const missing = ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'].filter(name => !env[name]);
  if (missing.length) throw Error(`empty secret(s): ${missing.join(', ')}. Set them with 'mise run secrets'`);
  return {
    url: baseUrl(env.LANGFUSE_BASE_URL || CLOUD),
    auth: 'Basic ' + Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString('base64'),
    project: env.FYSO_PROJECT || 'fyso',
    omb: env.FYSO_OMB_PORT ? `http://127.0.0.1:${env.FYSO_OMB_PORT}` : null,
    state: env.FYSO_DATA ? path.join(env.FYSO_DATA, 'ext/langfuse/state.json') : null,
  };
}

/** Bounded request: no redirects (credentials never follow one), a timeout and a size cap. */
async function request(fetchImpl, url, init = {}) {
  const res = await fetchImpl(url, {...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS)});
  const text = await res.text();
  if (text.length > MAX_RESPONSE) throw Error(`${new URL(url).pathname}: response too large`);
  if (res.status >= 300 && res.status < 400) throw Error(`${new URL(url).pathname}: refused redirect (HTTP ${res.status})`);
  if (!res.ok) throw Error(`${new URL(url).pathname}: HTTP ${res.status}${text ? ` ${text.slice(0, 200).replace(/\s+/g, ' ')}` : ''}`);
  try { return text ? JSON.parse(text) : {}; } catch { throw Error(`${new URL(url).pathname}: not JSON`); }
}

// ---------- OMB trace → OTLP spans ----------

const hex = (seed, length) => crypto.createHash('sha256').update(seed).digest('hex').slice(0, length);
const nanos = ms => (BigInt(Math.round(ms)) * 1_000_000n).toString();
const finite = value => typeof value === 'number' && Number.isFinite(value);

function attribute(key, value) {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value)) return {key, value: {arrayValue: {values: value.map(v => ({stringValue: String(v)}))}}};
  if (typeof value === 'boolean') return {key, value: {boolValue: value}};
  if (typeof value === 'number') return Number.isInteger(value) ? {key, value: {intValue: String(value)}} : {key, value: {doubleValue: value}};
  if (typeof value === 'object') return {key, value: {stringValue: JSON.stringify(value)}};
  return {key, value: {stringValue: String(value)}};
}
const attributes = entries => entries.map(([key, value]) => attribute(key, value)).filter(Boolean);

/** A tool's own name (Bash, mcp__server__tool…). OMB names Codex shell calls by their raw, unredacted command line. */
const toolName = name => typeof name === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(name) ? name : 'shell';

/** Token counts in Langfuse's usage keys. OMB counts cached input and cache writes inside `input`. */
function usageDetails(tokens) {
  if (!tokens || !finite(tokens.input) || !finite(tokens.output)) return null;
  const cached = finite(tokens.cachedInput) ? tokens.cachedInput : 0;
  const written = finite(tokens.cacheWrite) ? tokens.cacheWrite : 0;
  const usage = {input: Math.max(0, tokens.input - cached - written), output: tokens.output};
  if (cached) usage.input_cache_read = cached;
  if (written) usage.input_cache_creation = written;
  usage.total = tokens.input + tokens.output;
  return usage;
}

/** One trace per OMB root: turns are agents, AI steps generations, tool calls tools; groups are flattened. */
function traceSpans(detail, options) {
  const root = detail.root;
  const top = detail.turns && detail.turns[0];
  if (!root || !top) throw Error(`trace ${root && root.id}: no turns`);
  const traceId = hex(`fyso:${options.project}:trace:${root.id}`, 32);
  const botNames = (root.bots || []).map(bot => bot.name).filter(Boolean);
  const name = `${botNames[0] || top.botName || 'bot'} · ${root.source || 'owner'}`;
  const traceAttributes = attributes([
    ['langfuse.trace.name', name],
    ['langfuse.session.id', top.threadId],
    ['langfuse.trace.tags', ['fyso', `project:${options.project}`, `source:${root.source || 'owner'}`, ...botNames.map(bot => `bot:${bot}`)]],
    ['langfuse.trace.metadata.project', options.project],
    ['langfuse.trace.metadata.omb_trace_id', root.id],
    ['langfuse.trace.metadata.usage_status', root.usageStatus],
  ]);
  const spans = [];
  const end = node => finite(node.endedAt) ? node.endedAt : node.startedAt;

  function push(node, parent, spanName, type, own, status) {
    const spanId = hex(`fyso:${options.project}:span:${root.id}:${node.kind}:${node.id}`, 16);
    spans.push({
      traceId, spanId, ...(parent ? {parentSpanId: parent} : {}), name: spanName, kind: 1,
      startTimeUnixNano: nanos(node.startedAt), endTimeUnixNano: nanos(Math.max(node.startedAt, end(node))),
      attributes: [...traceAttributes, ...attributes([['langfuse.observation.type', type], ...own])],
      status: status ? {code: 2, message: status} : {code: 0},
    });
    return spanId;
  }

  function walk(node, parent, turn) {
    if (node.kind === 'group') { for (const child of node.children || []) walk(child, parent, turn); return; }
    if (node.kind === 'turn') {
      const error = node.status === 'error' ? node.reason || 'turn failed' : null;
      const id = push(node, parent, node.botName || node.botId || 'bot', 'agent', [
        ['langfuse.observation.level', error ? 'ERROR' : node.status && node.status !== 'ok' ? 'WARNING' : null],
        ['langfuse.observation.metadata.bot_id', node.botId],
        ['langfuse.observation.metadata.model', node.model],
        ['langfuse.observation.metadata.engine', node.driverKind],
        ['langfuse.observation.metadata.status', node.status],
        ['langfuse.observation.metadata.usage_status', node.usageStatus],
        ['langfuse.observation.metadata.cost_source', node.costSource],
        ['langfuse.observation.metadata.thread_id', node.threadId],
      ], error);
      for (const child of node.children || []) walk(child, id, node);
      return;
    }
    if (node.kind === 'step') {
      const usage = usageDetails(node.tokens);
      push(node, parent, turn.model || 'llm', 'generation', [
        ['langfuse.observation.model.name', turn.model],
        ['langfuse.observation.usage_details', usage],
        ['langfuse.observation.cost_details', finite(node.costUsd) ? {total: node.costUsd} : null],
        ['langfuse.observation.metadata.engine', turn.driverKind],
        ['langfuse.observation.metadata.cost_source', finite(node.costUsd) ? turn.costSource || 'reported' : null],
        ['langfuse.observation.metadata.reasoning_tokens', node.tokens && node.tokens.reasoning],
        ['langfuse.observation.metadata.context_tokens', node.contextTokens],
        ['langfuse.observation.metadata.context_window', node.contextWindow],
      ]);
      return;
    }
    if (node.kind === 'tool') {
      const error = node.status === 'error' ? node.error || 'tool failed' : null;
      push(node, parent, toolName(node.name), 'tool', [
        ['langfuse.observation.metadata.kind', node.icon],
        ['langfuse.observation.level', error ? 'ERROR' : null],
        ['langfuse.observation.metadata.server', node.server],
        ['langfuse.observation.metadata.app', node.app],
      ], error);
    }
  }
  walk(top, null, top);
  return spans;
}

function otlp(spans, project) {
  return {resourceSpans: [{
    resource: {attributes: attributes([['service.name', 'fyso-agentic-framework'], ['fyso.project', project]])},
    scopeSpans: [{scope: {name: 'fyso-ext-langfuse', version: VERSION}, spans}],
  }]};
}

// ---------- state ----------

function readState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return state && typeof state.exported === 'object' ? state : {exported: {}};
  } catch (error) {
    if (error.code === 'ENOENT') return {exported: {}};
    throw Error(`unreadable state ${file}: ${error.message}`);
  }
}

function writeState(file, state, now) {
  for (const [id, entry] of Object.entries(state.exported)) if (now - entry.at > KEEP_DAYS * DAY_MS) delete state.exported[id];
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state) + '\n', {mode: 0o600});
  fs.renameSync(temporary, file);
}

// ---------- commands ----------

async function check({env = process.env, fetchImpl = fetch} = {}) {
  const options = config(env);
  const projects = await request(fetchImpl, `${options.url}/api/public/projects`, {headers: {Authorization: options.auth}});
  const project = Array.isArray(projects.data) && projects.data[0];
  if (!project) throw Error('Langfuse answered without a project for these keys');
  return {url: options.url, project: project.name || project.id};
}

/** Roots finished at least SETTLE_MS ago that were never exported, or that changed since (a late delegation). */
async function pending(options, fetchImpl, now) {
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  const from = day(now - LOOKBACK_DAYS * DAY_MS), to = day(now);
  const state = readState(options.state);
  const due = [];
  let offset = 0, listed = 0;
  while (listed < MAX_ROOTS) {
    const page = await request(fetchImpl, `${options.omb}/api/usage/traces?from=${from}&to=${to}&limit=${PAGE}&offset=${offset}`);
    if (!Array.isArray(page.roots)) throw Error('OMB answered without trace roots');
    for (const root of page.roots) {
      listed++;
      if (root.running || !finite(root.endedAt) || now - root.endedAt < SETTLE_MS) continue;
      const seen = state.exported[root.id];
      if (!seen || seen.endedAt !== root.endedAt || seen.size !== root.steps + root.tools) due.push(root);
    }
    if (page.next === undefined) break;
    offset = page.next;
  }
  return {state, due};
}

async function sync({env = process.env, fetchImpl = fetch, now = Date.now()} = {}) {
  const options = config(env);
  if (!options.omb || !options.state) throw Error('FYSO_OMB_PORT and FYSO_DATA are required: run through mise');
  const {state, due} = await pending(options, fetchImpl, now);
  let exported = 0, spans = 0;
  for (let index = 0; index < due.length; index += BATCH) {
    const batch = due.slice(index, index + BATCH), body = [];
    for (const root of batch) {
      const detail = await request(fetchImpl, `${options.omb}/api/usage/traces/${encodeURIComponent(root.id)}?at=${Math.round(root.startedAt)}`);
      body.push(...traceSpans(detail, options));
    }
    await request(fetchImpl, `${options.url}/api/public/otel/v1/traces`, {
      method: 'POST',
      headers: {Authorization: options.auth, 'Content-Type': 'application/json', 'x-langfuse-ingestion-version': '4'},
      body: JSON.stringify(otlp(body, options.project)),
    });
    for (const root of batch) state.exported[root.id] = {at: now, endedAt: root.endedAt, size: root.steps + root.tools};
    writeState(options.state, state, now);   // after every accepted batch: a later failure never resends it
    exported += batch.length; spans += body.length;
  }
  if (!due.length) writeState(options.state, state, now);
  return {exported, spans, url: options.url};
}

module.exports = {baseUrl, config, usageDetails, traceSpans, otlp, check, sync, SETTLE_MS};

if (require.main === module) {
  const command = process.argv[2];
  const run = {check, sync}[command];
  if (!run) { console.error('Usage: langfuse.cjs check | sync'); process.exit(2); }
  run().then(result => {
    if (command === 'check') console.log(`Langfuse: authenticated at ${result.url} (project ${result.project})`);
    else console.log(JSON.stringify(result));
  }, error => { console.error(`langfuse: ${error.message}`); process.exit(1); });
}
