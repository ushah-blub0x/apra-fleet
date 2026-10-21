import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { kbContext } from '../../src/tools/kb-context.js';
import { kbSessionPrime } from '../../src/tools/kb-session-prime.js';
import { kbInvalidate } from '../../src/tools/kb-invalidate.js';
import { resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { FLEET_DIR } from '../../src/paths.js';

// End to end through the agent-facing kb tool handlers (kb_capture, kb_query,
// kb_context, kb_session_prime, kb_invalidate): repository identity headers,
// the all_repositories opt-in and the entry-origin pass-through working
// together. No mocks: real tool handlers, real kb_setup, a real temp git repo
// whose origin carries credentials, and a real local node http server that
// records method, path, query string, headers and body of every request.
//
// Revert checks (done when this file was written; both restored afterwards):
// - deleting the `headers['X-Repository'] = repository.identity` line in
//   src/services/knowledge/http-provider.ts sendRequest fails "flow carries
//   X-Repository ..." (expected undefined to be 'host.example/org/repo').
// - deleting the all_repositories pass-through in HttpKbProvider.query fails
//   "flow sends all_repositories=true ..." (expected null to be 'true').

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
// Deliberately fake userinfo: neither part may ever leave the process.
const SECRET_MARKER = 'SECRET_MARKER';
const RAW_REMOTE = `https://user:${SECRET_MARKER}@Host.Example:8443/org/repo.git`;
const IDENTITY = 'host.example/org/repo';
const SERVER_REPOSITORY = 'host.example/org/elsewhere';
const SERVER_COMMIT = 'fedcba9876543210fedcba9876543210fedcba98';

interface RecordedRequest {
  method: string;
  pathname: string;
  search: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function serverEntry(id: string, origin: boolean): Record<string, unknown> {
  return {
    id, type: 'knowledge', title: `Server entry ${id}`, summary: `Server summary ${id}.`, content: `Server content ${id}.`,
    source_files: ['src/widget.ts'], symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256',
    stale: false, flagged_for_review: false, author: 'doer', source: 'session', confidence: 'CONFIRMED',
    created_at: '2026-10-01T00:00:00.000Z', use_count: 0,
    ...(origin ? { repository: SERVER_REPOSITORY, repository_commit: SERVER_COMMIT } : {}),
  };
}

const ORIGIN = { repository: SERVER_REPOSITORY, repository_commit: SERVER_COMMIT };

function cannedResponse(pathname: string): unknown {
  switch (pathname) {
    case '/api/kb/capture': return { id: 'server-capture-id', audn_decision: 'add' };
    case '/api/kb/query': return { results: [serverEntry('q1', true), serverEntry('q2', true)], total: 2, l1_only: true };
    case '/api/kb/context': return {
      results: [
        { file: 'src/widget.ts', status: 'fresh', summary: 'widget summary', entry_id: 'c1', ...ORIGIN },
        { file: 'src/gadget.ts', status: 'stale', summary: 'gadget summary', entry_id: 'c2', ...ORIGIN },
      ],
    };
    case '/api/kb/prime': return {
      session_warm: true, stale_files: [], fresh_summaries: [], recommended_code_calls: [], token_estimate: 0,
      top_entries: [serverEntry('p1', true), serverEntry('p2', true), serverEntry('p3', true)],
    };
    case '/api/kb/invalidate': return { invalidated: 1 };
    default: return { error: 'not found' };
  }
}

let token: string;
let savedConfig: string | null;
let server: http.Server;
let recorded: RecordedRequest[] = [];
let stderrChunks: string[] = [];
let originalStderrWrite: typeof process.stderr.write;
let repo: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', windowsHide: true }).trim();
}

beforeAll(async () => {
  token = loadTestToken();
  savedConfig = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH, 'utf-8') : null;
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      recorded.push({ method: req.method ?? '', pathname: url.pathname, search: url.searchParams, headers: req.headers, body });
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
});

beforeEach(async () => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
  recorded = [];
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-repo-identity-e2e-'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'widget.ts'), 'export const widget = 1;\n');
  git(['init', '-q']);
  git(['remote', 'add', 'origin', RAW_REMOTE]);
  git(['add', '.']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'initial']);

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('recording server has no TCP port');
  const setup = JSON.parse(await kbSetup({ provider: 'http', remote: `http://127.0.0.1:${address.port}`, token }, { folder: repo }));
  expect(setup.success).toBe(true);

  stderrChunks = [];
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return (originalStderrWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = originalStderrWrite;
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
  fs.rmSync(repo, { recursive: true, force: true });
});

interface FlowOutputs {
  capture: string;
  query: string;
  context: string;
  prime: string;
  invalidate: string;
}

/** kb_capture, kb_query, kb_context, kb_session_prime, kb_invalidate through their tool handlers. */
async function runFlow(allRepositories: boolean | undefined): Promise<FlowOutputs> {
  const anchor = { folder: repo };
  const flag = allRepositories === undefined ? {} : { all_repositories: allRepositories };
  return {
    capture: await kbCapture({
      type: 'knowledge',
      title: 'Widget constant is one',
      summary: 'The widget module exports a constant set to one.',
      content: 'src/widget.ts exports widget = 1.',
      source_files: ['src/widget.ts'],
      symbols: ['widget'],
    }, anchor),
    query: await kbQuery({ query: 'widget', ...flag }, anchor),
    context: await kbContext({ files: ['src/widget.ts', 'src/gadget.ts'], ...flag }, anchor),
    prime: await kbSessionPrime({ session_files: ['src/widget.ts'], ...flag }, anchor),
    invalidate: await kbInvalidate({ files: ['src/widget.ts'] }, anchor),
  };
}

const READ_ROUTES = new Set(['/api/kb/query', '/api/kb/context', '/api/kb/prime']);

describe('repository identity end to end through the kb tools', () => {
  it('flow carries X-Repository on every request and X-Repository-Commit (= HEAD) on the capture only', async () => {
    const head = git(['rev-parse', 'HEAD']);
    await runFlow(true);

    const routes = recorded.map(r => r.pathname);
    for (const route of ['/api/kb/capture', '/api/kb/query', '/api/kb/context', '/api/kb/prime', '/api/kb/invalidate']) {
      expect(routes).toContain(route);
    }
    for (const request of recorded) {
      expect(request.headers['x-repository'], `${request.method} ${request.pathname}`).toBe(IDENTITY);
      if (request.pathname === '/api/kb/capture') {
        expect(request.headers['x-repository-commit']).toBe(head);
      } else {
        expect(request.headers, `${request.method} ${request.pathname}`).not.toHaveProperty('x-repository-commit');
      }
    }
    expect(recorded.filter(r => r.pathname === '/api/kb/capture')).toHaveLength(1);
  });

  it('flow sends all_repositories=true on every query, context and prime request and never in the prime body; without the flag it is absent everywhere', async () => {
    await runFlow(true);
    const reads = recorded.filter(r => READ_ROUTES.has(r.pathname));
    expect(reads.map(r => `${r.method} ${r.pathname}`)).toEqual(expect.arrayContaining([
      'GET /api/kb/query', 'GET /api/kb/context', 'POST /api/kb/prime',
    ]));
    for (const request of reads) {
      expect(request.search.get('all_repositories'), `${request.method} ${request.pathname}`).toBe('true');
    }
    const prime = recorded.find(r => r.pathname === '/api/kb/prime')!;
    expect(Object.keys(JSON.parse(prime.body))).not.toContain('all_repositories');

    recorded = [];
    await runFlow(undefined);
    expect(recorded.length).toBeGreaterThanOrEqual(5);
    for (const request of recorded) {
      expect(request.search.has('all_repositories'), `${request.method} ${request.pathname}`).toBe(false);
      expect(request.body).not.toContain('all_repositories');
    }
  });

  it('kb_query, kb_context and kb_session_prime outputs show the server\'s repository and repository_commit for each entry / per-file result', async () => {
    const outputs = await runFlow(true);
    const query = JSON.parse(outputs.query);
    const context = JSON.parse(outputs.context);
    const prime = JSON.parse(outputs.prime);

    expect(query.l1_results.map((e: any) => e.id)).toEqual(['q1', 'q2']);
    for (const entry of [...query.l1_results, ...query.l2_expanded]) {
      expect(entry).toMatchObject(ORIGIN);
    }
    expect(context.fresh).toEqual([expect.objectContaining({ file: 'src/widget.ts', ...ORIGIN })]);
    expect(context.stale).toEqual([expect.objectContaining({ file: 'src/gadget.ts', ...ORIGIN })]);
    expect(prime.top_entries.map((e: any) => e.id)).toEqual(['p1', 'p2', 'p3']);
    for (const entry of prime.top_entries) {
      expect(entry).toMatchObject(ORIGIN);
    }
  });

  it('the credentials and the raw remote URL appear in no header, query string, body, tool output or stderr', async () => {
    const withFlag = await runFlow(true);
    const withoutFlag = await runFlow(undefined);
    const everything = [
      ...recorded.map(r => [JSON.stringify(r.headers), r.search.toString(), r.body].join('\n')),
      ...Object.values(withFlag),
      ...Object.values(withoutFlag),
      ...stderrChunks,
    ].join('\n');
    expect(recorded.length).toBeGreaterThanOrEqual(10);
    expect(everything).not.toContain(SECRET_MARKER);
    expect(everything).not.toContain(RAW_REMOTE);
    expect(everything).not.toContain('user');
  });
});
