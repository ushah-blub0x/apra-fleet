import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { kbContext } from '../../src/tools/kb-context.js';
import { kbSessionPrime, neighborQueryOptions } from '../../src/tools/kb-session-prime.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import { FLEET_DIR } from '../../src/paths.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

// all_repositories opt-in and pass-through of each result's repository origin.
// No mocks: real kb_* tool handlers, real kb_setup/getKbProviders/HttpKbProvider,
// real git repos in temp dirs and a real local node http server that records
// method, path, query string and body of every request.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_ENV_VAR = 'APRA_FLEET_TEST_KB_HTTP_TOKEN';
const TOKEN_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'kb-http-test-token.txt');

function loadTestToken(): string {
  const fromEnv = process.env[TOKEN_ENV_VAR];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  const fromFile = fs.existsSync(TOKEN_FIXTURE_PATH) ? fs.readFileSync(TOKEN_FIXTURE_PATH, 'utf-8').trim() : '';
  if (fromFile.length > 0) return fromFile;
  throw new Error(`Missing test KB token: set ${TOKEN_ENV_VAR} or provide a non-empty ${TOKEN_FIXTURE_PATH}`);
}

const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const OTHER_REPOSITORY = 'host.example/org/other-repo';
const OTHER_COMMIT = '0123456789abcdef0123456789abcdef01234567';

interface RecordedRequest {
  method: string;
  pathname: string;
  search: URLSearchParams;
  body: string;
}

function serverEntry(id: string, confidence: string, origin: boolean): Record<string, unknown> {
  return {
    id, type: 'knowledge', title: `Entry ${id}`, summary: `Summary of ${id}.`, content: `Content of ${id}.`,
    source_files: [], symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256',
    stale: false, flagged_for_review: false, author: 'doer', source: 'session', confidence,
    created_at: '2026-10-01T00:00:00.000Z', use_count: 0,
    ...(origin ? { repository: OTHER_REPOSITORY, repository_commit: OTHER_COMMIT } : {}),
  };
}

// The second entry fails kb_query's default CONFIRMED filter: with limit 2 the
// first page "filtered short", which forces kb_query's wider retry.
const QUERY_RESULTS = [serverEntry('with-origin', 'CONFIRMED', true), serverEntry('inferred', 'INFERRED', false)];
const CONTEXT_RESULTS = [
  { file: 'src/fresh.ts', status: 'fresh', summary: 'fresh summary', entry_id: 'c1', repository: OTHER_REPOSITORY, repository_commit: OTHER_COMMIT },
  { file: 'src/stale.ts', status: 'stale', summary: 'stale summary', entry_id: 'c2', repository: OTHER_REPOSITORY, repository_commit: OTHER_COMMIT },
  { file: 'src/plain.ts', status: 'fresh', summary: 'plain summary', entry_id: 'c3' },
];
const PRIME_RESULT = {
  session_warm: true, stale_files: [], fresh_summaries: [], recommended_code_calls: [], token_estimate: 0,
  top_entries: [
    serverEntry('p1', 'CONFIRMED', true), serverEntry('p2', 'CONFIRMED', true), serverEntry('p3', 'CONFIRMED', false),
  ],
};

function cannedResponse(pathname: string): unknown {
  if (pathname === '/api/kb/query') return { results: QUERY_RESULTS, total: QUERY_RESULTS.length, l1_only: true };
  if (pathname === '/api/kb/context') return { results: CONTEXT_RESULTS };
  if (pathname === '/api/kb/prime') return PRIME_RESULT;
  return { error: 'not found' };
}

let token: string;
let savedConfig: string | null;
let server: http.Server;
let recorded: RecordedRequest[] = [];
const tempDirs: string[] = [];

function makeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-all-repos-'));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['remote', 'add', 'origin', `https://example.test/kb-all-repos-${RUN}-${tempDirs.length}.git`], { cwd: dir, windowsHide: true });
  return dir;
}

beforeAll(async () => {
  token = loadTestToken();
  savedConfig = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH, 'utf-8') : null;
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      recorded.push({ method: req.method ?? '', pathname: url.pathname, search: url.searchParams, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cannedResponse(url.pathname)));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (savedConfig === null) fs.rmSync(KB_CONFIG_PATH, { force: true });
  else fs.writeFileSync(KB_CONFIG_PATH, savedConfig);
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
  recorded = [];
});

afterEach(() => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
});

function serverPort(): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('recording server has no TCP port');
  return address.port;
}

async function setupHttpKb(folder: string): Promise<void> {
  const result = JSON.parse(await kbSetup({ provider: 'http', remote: `http://127.0.0.1:${serverPort()}`, token }, { folder }));
  expect(result.success).toBe(true);
}

async function runReadTools(folder: string, allRepositories?: boolean): Promise<{ query: any; context: any; prime: any }> {
  const flag = allRepositories === undefined ? {} : { all_repositories: allRepositories };
  const anchor = { folder };
  const query = JSON.parse(await kbQuery({ query: 'origin', limit: 2, ...flag }, anchor));
  const context = JSON.parse(await kbContext({ files: ['src/fresh.ts', 'src/stale.ts', 'src/plain.ts'], ...flag }, anchor));
  const prime = JSON.parse(await kbSessionPrime({ session_files: ['src/fresh.ts'], ...flag }, anchor));
  return { query, context, prime };
}

describe('all_repositories transport', () => {
  it('kb_query (L1, wider retry, L2 ids fetch), kb_context and kb_session_prime send all_repositories=true on every request when asked', async () => {
    const repo = makeGitRepo();
    await setupHttpKb(repo);
    await runReadTools(repo, true);

    const routes = recorded.map(r => `${r.method} ${r.pathname}`);
    // L1 page, wider retry (limit*4) and L2 ids fetch, then context and prime.
    expect(routes).toEqual([
      'GET /api/kb/query', 'GET /api/kb/query', 'GET /api/kb/query', 'GET /api/kb/context', 'POST /api/kb/prime',
    ]);
    expect(recorded[0].search.get('limit')).toBe('2');
    expect(recorded[1].search.get('limit')).toBe('8');
    for (const request of recorded) {
      expect(request.search.get('all_repositories')).toBe('true');
    }
  });

  it.each([
    ['omitted', undefined],
    ['false', false],
  ])('sends no all_repositories parameter anywhere when the flag is %s', async (_label, flag) => {
    const repo = makeGitRepo();
    await setupHttpKb(repo);
    await runReadTools(repo, flag);
    expect(recorded).toHaveLength(5);
    for (const request of recorded) {
      expect(request.search.has('all_repositories')).toBe(false);
    }
  });

  it.each([true, false, undefined])('never puts all_repositories in the prime POST body (flag %s)', async (flag) => {
    const repo = makeGitRepo();
    await setupHttpKb(repo);
    await kbSessionPrime({ session_files: ['src/a.ts'], ...(flag === undefined ? {} : { all_repositories: flag }) }, { folder: repo });
    const prime = recorded.filter(r => r.pathname === '/api/kb/prime');
    expect(prime).toHaveLength(1);
    expect(Object.keys(JSON.parse(prime[0].body))).not.toContain('all_repositories');
    expect(prime[0].body).not.toContain('all_repositories');
  });

  it('prime\'s neighbour-expansion query carries all_repositories=true through the HTTP provider, and nothing without it', async () => {
    const repo = makeGitRepo();
    await setupHttpKb(repo);
    const providers = await getKbProviders(repo);
    expect(providers.project).toBeInstanceOf(HttpKbProvider);
    const filters = { confidence: ['CONFIRMED' as const], exclude_disputed: true };
    await providers.project.query(neighborQueryOptions(['neighbourA'], { ...filters, all_repositories: true }));
    await providers.project.query(neighborQueryOptions(['neighbourA'], filters));
    expect(recorded.map(r => r.search.get('all_repositories'))).toEqual(['true', null]);
  });
});

describe('repository origin pass-through', () => {
  it('kb_query, kb_context and kb_session_prime show repository and repository_commit per entry / per-file result; results without them render as before', async () => {
    const repo = makeGitRepo();
    await setupHttpKb(repo);
    const { query, context, prime } = await runReadTools(repo, true);

    const withOrigin = { repository: OTHER_REPOSITORY, repository_commit: OTHER_COMMIT };
    expect(query.l1_results).toEqual([expect.objectContaining({ id: 'with-origin', ...withOrigin })]);
    expect(query.l2_expanded[0]).toMatchObject({ id: 'with-origin', ...withOrigin });
    expect(query.l2_expanded[1].id).toBe('inferred');
    expect(query.l2_expanded[1]).not.toHaveProperty('repository');

    expect(context.fresh).toEqual([
      expect.objectContaining({ file: 'src/fresh.ts', ...withOrigin }),
      { file: 'src/plain.ts', status: 'fresh', summary: 'plain summary', entry_id: 'c3' },
    ]);
    expect(context.stale).toEqual([expect.objectContaining({ file: 'src/stale.ts', ...withOrigin })]);

    expect(prime.top_entries.map((e: any) => [e.id, e.repository, e.repository_commit])).toEqual([
      ['p1', OTHER_REPOSITORY, OTHER_COMMIT],
      ['p2', OTHER_REPOSITORY, OTHER_COMMIT],
      ['p3', undefined, undefined],
    ]);
  });
});

/** Tool output without the per-read telemetry (use_count, last_accessed) a read bumps. */
function withoutTelemetry(output: string): unknown {
  return JSON.parse(output, (key, value) => (key === 'use_count' || key === 'last_accessed' ? undefined : value));
}

describe('member sessions and the local SQLite provider', () => {
  let memberRepo: string;
  let memberId: string;

  beforeAll(() => {
    backupAndResetRegistry();
    resetMemberBibleViews();
    memberRepo = makeGitRepo();
    const agent = makeTestLocalAgent({ friendlyName: `kb-all-repos-${RUN}`, workFolder: memberRepo });
    addAgent(agent);
    memberId = agent.id;
  });

  afterAll(() => {
    resetMemberBibleViews();
    restoreRegistry();
  });

  const asMember = <T>(fn: () => Promise<T>): Promise<T> => runWithSessionMember(memberId, fn);

  async function settle(fn: () => Promise<string>): Promise<string> {
    try {
      return `ok:${await fn()}`;
    } catch (err) {
      return `error:${(err as Error).message}`;
    }
  }

  it('a member session accepts the flag and changes nothing: same CONFIRMED results, same INFERRED refusal, no HTTP request', async () => {
    await setupHttpKb(memberRepo);
    const reads: Array<[string, (flag: { all_repositories?: boolean }) => Promise<string>]> = [
      ['kb_query', flag => kbQuery({ query: 'origin', ...flag })],
      ['kb_query INFERRED', flag => kbQuery({ query: 'origin', confidence: ['INFERRED'], ...flag })],
      ['kb_context', flag => kbContext({ files: ['src/a.ts'], ...flag })],
      ['kb_context INFERRED', flag => kbContext({ files: ['src/a.ts'], confidence: ['INFERRED'], ...flag })],
      ['kb_session_prime', flag => kbSessionPrime({ session_files: ['src/a.ts'], ...flag })],
      ['kb_session_prime INFERRED', flag => kbSessionPrime({ confidence: ['INFERRED'], ...flag })],
    ];
    for (const [label, read] of reads) {
      const without = await asMember(() => settle(() => read({})));
      const withFlag = await asMember(() => settle(() => read({ all_repositories: true })));
      expect(withFlag, label).toBe(without);
    }
    const inferred = await asMember(() => settle(() => kbQuery({ query: 'origin', confidence: ['INFERRED'], all_repositories: true })));
    expect(inferred).toMatch(/^error:/);
    expect(recorded).toEqual([]);
  });

  it('the local SQLite provider accepts all_repositories=true and returns the same results', async () => {
    const repo = makeGitRepo();
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    await kbCapture({
      type: 'knowledge',
      title: 'Local sqlite all repositories entry',
      summary: 'An entry in the local SQLite KB used to compare reads with and without the flag.',
      content: 'Local sqlite content for the all_repositories comparison.',
      source_files: ['src/a.ts'],
      symbols: ['localSqliteAllRepositories'],
    }, { folder: repo });
    const anchor = { folder: repo };
    const query = { query: 'sqlite', confidence: ['INFERRED' as const] };
    const queryWith = withoutTelemetry(await kbQuery({ ...query, all_repositories: true }, anchor));
    expect(queryWith).toEqual(withoutTelemetry(await kbQuery(query, anchor)));
    expect((queryWith as { l1_results: unknown[] }).l1_results).toHaveLength(1);
    const context = { files: ['src/a.ts'], confidence: ['INFERRED' as const] };
    expect(withoutTelemetry(await kbContext({ ...context, all_repositories: true }, anchor)))
      .toEqual(withoutTelemetry(await kbContext(context, anchor)));
    const prime = { session_files: ['src/a.ts'], confidence: ['INFERRED' as const] };
    expect(withoutTelemetry(await kbSessionPrime({ ...prime, all_repositories: true }, anchor)))
      .toEqual(withoutTelemetry(await kbSessionPrime(prime, anchor)));
    expect(recorded).toEqual([]);
  });
});
