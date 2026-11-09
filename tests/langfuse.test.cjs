'use strict';
// Fixtures follow OpenMausBot 0.1.141 (dist-server/server/usage-trace/build.js: summarizeRoot, traceTurn).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const lf = require('../extensions/langfuse/langfuse.cjs');

const NOW = Date.parse('2026-11-09T12:00:00Z');
const ago = minutes => NOW - minutes * 60_000;

function summary(id, overrides = {}) {
  return {id, title: 'Plan the launch for ACME', source: 'person', startedAt: ago(30), endedAt: ago(20), running: false, timed: true,
    bots: [{id: 'b1', name: 'Chief'}, {id: 'b2', name: 'Researcher'}], usageStatus: 'complete',
    durationMs: 600_000, costUsd: 0.05, tokens: 1700, input: 1200, cachedInput: 800, output: 500, steps: 3, tools: 4, errors: 1, ...overrides};
}

function detail(root) {
  return {root, turns: [{
    kind: 'turn', id: 't1:u1', threadId: 't1', turnId: 'u1', botId: 'b1', botName: 'Chief', model: 'claude-sonnet-5-5', driverKind: 'claude',
    startedAt: root.startedAt, endedAt: root.endedAt, timed: true, status: 'ok', costUsd: 0.04, costSource: 'reported',
    tokens: {input: 1000, cachedInput: 700, output: 400, cacheWrite: 100}, usageStatus: 'complete',
    children: [
      {kind: 'step', id: 's1', startedAt: root.startedAt, endedAt: root.startedAt + 2000, tokens: {input: 1000, cachedInput: 700, output: 400, cacheWrite: 100}, costUsd: 0.04},
      {kind: 'tool', id: 'x0', name: "/bin/zsh -lc 'curl -H \"Authorization: Bearer s3cr3t\" https://api'", icon: 'terminal', detail: "/bin/zsh -lc 'curl -H Authorization: Bearer [redacted]'", startedAt: root.startedAt + 1000, endedAt: root.startedAt + 2000, status: 'ok', timedBy: 'engine'},
      {kind: 'tool', id: 'x1', name: 'Bash', icon: 'tool', detail: 'git status', startedAt: root.startedAt + 2000, endedAt: root.startedAt + 3000, status: 'ok', timedBy: 'engine'},
      {kind: 'group', id: 'group:g1', icon: 'mcp', name: 'search', count: 3, errors: 1, startedAt: root.startedAt + 3000, endedAt: root.startedAt + 6000, children: [
        {kind: 'tool', id: 'g1', name: 'mcp__web__search', icon: 'mcp', server: 'web', detail: 'launch checklist', startedAt: root.startedAt + 3000, endedAt: root.startedAt + 4000, status: 'ok'},
        {kind: 'step', id: 's2', startedAt: root.startedAt + 4000, endedAt: root.startedAt + 4500},
        {kind: 'tool', id: 'g2', name: 'mcp__web__search', icon: 'mcp', server: 'web', startedAt: root.startedAt + 4500, endedAt: root.startedAt + 6000, status: 'error', error: 'timeout'},
      ]},
      {kind: 'turn', id: 't2:u9', threadId: 't2', turnId: 'u9', botId: 'b2', botName: 'Researcher', model: 'gpt-5.5', driverKind: 'codex',
        startedAt: root.startedAt + 6000, endedAt: root.startedAt + 9000, timed: true, status: 'error', reason: 'quota', costUsd: null,
        tokens: {input: 200, cachedInput: 100, output: 100}, usageStatus: 'partial', children: [
          {kind: 'step', id: 's3', startedAt: root.startedAt + 6000, endedAt: root.startedAt + 9000, tokens: {input: 200, cachedInput: 100, output: 100}},
        ]},
    ],
  }]};
}

const attr = (span, key) => {
  const found = span.attributes.find(a => a.key === key);
  if (!found) return undefined;
  const v = found.value;
  return v.stringValue ?? v.boolValue ?? v.doubleValue ?? (v.intValue !== undefined ? Number(v.intValue) : v.arrayValue.values.map(x => x.stringValue));
};

test('base URL: HTTPS anywhere, HTTP only on loopback, never credentials or queries', () => {
  assert.equal(lf.baseUrl('https://cloud.langfuse.com/'), 'https://cloud.langfuse.com');
  assert.equal(lf.baseUrl('https://obs.example.org/langfuse/'), 'https://obs.example.org/langfuse');
  assert.equal(lf.baseUrl('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(lf.baseUrl('http://langfuse.localhost:8080'), 'http://langfuse.localhost:8080');
  for (const bad of ['http://langfuse.example.org', 'https://u:p@cloud.langfuse.com', 'https://cloud.langfuse.com/?x=1', 'ftp://x', 'nope'])
    assert.throws(() => lf.baseUrl(bad), /LANGFUSE_BASE_URL/);
  const keys = {LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk'};
  assert.equal(lf.config(keys).url, 'https://cloud.langfuse.com', 'Langfuse Cloud by default');
  assert.equal(lf.config({...keys, LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com'}).url, 'https://us.cloud.langfuse.com');
});

test('usage: cached input and cache writes are split out of OMB input, never added twice', () => {
  assert.deepEqual(lf.usageDetails({input: 1000, cachedInput: 700, output: 400, cacheWrite: 100}),
    {input: 200, output: 400, input_cache_read: 700, input_cache_creation: 100, total: 1400});
  assert.deepEqual(lf.usageDetails({input: 10, cachedInput: 0, output: 5}), {input: 10, output: 5, total: 15});
  assert.equal(lf.usageDetails(undefined), null);
  assert.equal(lf.usageDetails({input: null, output: 3}), null);
});

test('trace mapping: turns are agents, steps generations, tools tools; groups flatten; delegations nest', () => {
  const root = summary('t1~u1');
  const spans = lf.traceSpans(detail(root), {project: 'acme'});
  assert.equal(spans.length, 9); // 2 turns, 3 steps, 4 tools
  assert.equal(new Set(spans.map(s => s.traceId)).size, 1);
  assert.match(spans[0].traceId, /^[0-9a-f]{32}$/);
  assert.ok(spans.every(s => /^[0-9a-f]{16}$/.test(s.spanId)));
  const byName = name => spans.filter(s => s.name === name);
  const [chief] = byName('Chief'), [researcher] = byName('Researcher');
  assert.equal(chief.parentSpanId, undefined);
  assert.equal(attr(chief, 'langfuse.observation.type'), 'agent');
  assert.equal(researcher.parentSpanId, chief.spanId);
  assert.equal(attr(researcher, 'langfuse.observation.level'), 'ERROR');
  assert.deepEqual(researcher.status, {code: 2, message: 'quota'});

  const generations = spans.filter(s => attr(s, 'langfuse.observation.type') === 'generation');
  assert.equal(generations.length, 3);
  const first = generations.find(s => attr(s, 'langfuse.observation.cost_details'));
  assert.equal(first.parentSpanId, chief.spanId);
  assert.equal(attr(first, 'langfuse.observation.model.name'), 'claude-sonnet-5-5');
  assert.deepEqual(JSON.parse(attr(first, 'langfuse.observation.cost_details')), {total: 0.04});
  assert.deepEqual(JSON.parse(attr(first, 'langfuse.observation.usage_details')), {input: 200, output: 400, input_cache_read: 700, input_cache_creation: 100, total: 1400});
  const codex = generations.find(s => s.parentSpanId === researcher.spanId);
  assert.equal(attr(codex, 'langfuse.observation.model.name'), 'gpt-5.5');
  assert.equal(attr(codex, 'langfuse.observation.cost_details'), undefined, 'unknown cost stays absent, never zero');
  const noTokens = generations.find(s => !attr(s, 'langfuse.observation.usage_details'));
  assert.ok(noTokens, 'a step without tokens carries no usage');

  const tools = spans.filter(s => attr(s, 'langfuse.observation.type') === 'tool');
  assert.equal(tools.length, 4);
  assert.equal(byName('shell').length, 1, 'raw command lines never become names');
  assert.ok(!JSON.stringify(spans).includes('s3cr3t'));
  assert.ok(tools.every(s => s.parentSpanId === chief.spanId), 'grouped tools hang from their turn');
  assert.equal(attr(byName('Bash')[0], 'langfuse.observation.input'), undefined, 'tool details stay out unless enabled');
  const failed = tools.find(s => s.status.code === 2);
  assert.equal(failed.status.message, 'timeout');

  for (const span of spans) {
    assert.equal(attr(span, 'langfuse.session.id'), 't1');
    assert.equal(attr(span, 'langfuse.trace.name'), 'Chief · person');
    assert.deepEqual(attr(span, 'langfuse.trace.tags'), ['fyso', 'project:acme', 'source:person', 'bot:Chief', 'bot:Researcher']);
    assert.ok(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano));
  }
  assert.ok(!/ACME|git status|s3cr3t/.test(JSON.stringify(spans)), 'no title, tool detail or command line');
  assert.deepEqual(lf.traceSpans(detail(root), {project: 'acme'}), spans, 'ids are deterministic');
  const other = lf.traceSpans(detail(root), {project: 'other'});
  assert.notEqual(other[0].traceId, spans[0].traceId, 'projects never share trace ids');
});

// ---------- sync against fake OMB and Langfuse ----------

function serve(handler) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const send = (res, status, value, headers = {}) => { res.writeHead(status, {'content-type': 'application/json', ...headers}); res.end(JSON.stringify(value)); };

async function stack(t, roots, langfuse) {
  const omb = await serve((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/usage/traces') return send(res, 200, {roots, totals: {}});
    const id = decodeURIComponent(url.pathname.slice('/api/usage/traces/'.length));
    const root = roots.find(r => r.id === id);
    return root ? send(res, 200, detail({...root, title: ''})) : send(res, 404, {error: 'no such trace'});
  });
  const received = [];
  const lfServer = await serve((req, res, body) => {
    received.push({method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null});
    langfuse(req, res);
  });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'fyso-langfuse-'));
  t.after(() => { omb.close(); lfServer.close(); fs.rmSync(data, {recursive: true, force: true}); });
  const env = {LANGFUSE_PUBLIC_KEY: 'pk-lf-test', LANGFUSE_SECRET_KEY: 'sk-lf-test', FYSO_PROJECT: 'acme', FYSO_DATA: data,
    FYSO_OMB_PORT: String(omb.address().port), LANGFUSE_BASE_URL: `http://127.0.0.1:${lfServer.address().port}`};
  return {env, received, state: path.join(data, 'ext/langfuse/state.json')};
}

test('sync exports finished, settled roots once and re-exports a root that grew', async t => {
  const roots = [summary('done~1'), summary('running~2', {running: true, endedAt: NOW}), summary('fresh~3', {endedAt: NOW - 10_000})];
  const {env, received, state} = await stack(t, roots, (req, res) => send(res, 200, {}));
  const first = await lf.sync({env, now: NOW});
  assert.deepEqual({exported: first.exported, spans: first.spans}, {exported: 1, spans: 9});
  assert.equal(received.length, 1);
  const [post] = received;
  assert.equal(post.method, 'POST');
  assert.equal(post.url, '/api/public/otel/v1/traces');
  assert.equal(post.headers.authorization, 'Basic ' + Buffer.from('pk-lf-test:sk-lf-test').toString('base64'));
  assert.equal(post.headers['x-langfuse-ingestion-version'], '4');
  const spans = post.body.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 9);
  assert.ok(!/ACME|git status|s3cr3t/.test(JSON.stringify(post.body)), 'no title, detail or command line');
  assert.equal((fs.statSync(state).mode & 0o777), 0o600);

  const again = await lf.sync({env, now: NOW + 60_000});
  assert.equal(again.exported, 1, 'the root that was fresh is now settled');
  assert.equal(received.length, 2);
  assert.equal(received[1].body.resourceSpans[0].scopeSpans[0].spans.length, 9);
  assert.equal((await lf.sync({env, now: NOW + 120_000})).exported, 0);

  roots[0].endedAt += 5000; roots[0].tools += 1; // a late delegation joined the root
  assert.equal((await lf.sync({env, now: NOW + 180_000})).exported, 1);
  assert.equal(received.length, 3);
});

test('a Langfuse failure exports nothing and keeps the roots pending', async t => {
  let status = 500;
  const {env, received, state} = await stack(t, [summary('done~1')], (req, res) => send(res, status, {message: 'down'}));
  await assert.rejects(lf.sync({env, now: NOW}), /HTTP 500/);
  assert.ok(!fs.existsSync(state) || !JSON.parse(fs.readFileSync(state, 'utf8')).exported['done~1']);
  status = 200;
  assert.equal((await lf.sync({env, now: NOW})).exported, 1);
  assert.equal(received.length, 2);
});

test('redirects are refused so the keys never follow them', async t => {
  const {env} = await stack(t, [summary('done~1')], (req, res) => send(res, 307, {}, {location: 'https://elsewhere.example/'}));
  await assert.rejects(lf.sync({env, now: NOW}), /refused redirect/);
});

test('check authenticates against the projects API; empty keys fail before any request', async t => {
  const {env, received} = await stack(t, [], (req, res) => req.headers.authorization ? send(res, 200, {data: [{id: 'p1', name: 'fyso-acme'}]}) : send(res, 401, {}));
  assert.deepEqual(await lf.check({env}), {url: env.LANGFUSE_BASE_URL, project: 'fyso-acme'});
  assert.equal(received[0].url, '/api/public/projects');
  await assert.rejects(lf.check({env: {...env, LANGFUSE_SECRET_KEY: ''}}), /LANGFUSE_SECRET_KEY/);
  assert.equal(received.length, 1);
});
