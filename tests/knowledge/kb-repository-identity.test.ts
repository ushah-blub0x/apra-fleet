import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { getSelfKbProviders } from '../../src/services/knowledge/kb-self.js';
import { normaliseRemoteForIdentity } from '../../src/services/knowledge/repository-identity.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { FLEET_DIR } from '../../src/paths.js';
import type { KBEntryInput, MemoryProvider } from '../../src/services/knowledge/types.js';

// Repository identity on HTTP KB requests. No mocks: real kb_setup, real
// getKbProviders/HttpKbProvider, real git repos in temp dirs and a real local
// node http server that records every request's method, url, headers and body.

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

// Deliberately fake userinfo: the marker must never leave the process.
const SECRET_MARKER = 'SECRET_MARKER_7c1e4b';
const ORIGIN_WITH_CREDENTIALS = `https://user:${SECRET_MARKER}@Host.Example:8443/org/repo.git`;
const ORIGIN_IDENTITY = 'host.example/org/repo';

interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function cannedResponse(pathname: string): unknown {
  if (pathname === '/api/kb/capture') return { id: 'server-id', audn_decision: 'add' };
  if (pathname === '/api/kb/query') return { l1_results: [], l2_expanded: [] };
  if (pathname === '/api/kb/context') return { results: [] };
  if (pathname === '/api/kb/invalidate') return { invalidated: 0 };
  if (pathname === '/api/kb/prime') {
    return {
      session_warm: false, stale_files: [], top_entries: [], fresh_summaries: [],
      recommended_code_calls: [], token_estimate: 0,
    };
  }
  return { error: 'not found' };
}

function startRecordingServer(recorded: RecordedRequest[], listenPort = 0): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      recorded.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cannedResponse(pathname)));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', () => resolve(server));
  });
}

function portOf(server: http.Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('recording server has no TCP port');
  return address.port;
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-repo-identity-'));
  tempDirs.push(dir);
  return dir;
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', windowsHide: true }).trim();
}

function commit(dir: string, message: string): string {
  git(dir, ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

/** A real git repo with the given origin and one commit; returns its folder. */
function makeGitRepo(origin: string): string {
  const dir = makeTempDir();
  git(dir, ['init', '-q']);
  git(dir, ['remote', 'add', 'origin', origin]);
  commit(dir, 'initial');
  return dir;
}

function makeEntry(): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'kb-repository-identity entry',
    summary: 'Entry captured to prove repository identity headers.',
    content: 'kb-repository-identity content.',
    source_files: [],
    symbols: ['kbRepositoryIdentity'],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'doer',
    source: 'session',
    confidence: 'INFERRED',
  };
}

async function exerciseAllRoutes(provider: MemoryProvider): Promise<void> {
  await provider.capture(makeEntry());
  await provider.query({ query: 'identity' });
  await provider.context(['src/a.ts']);
  await provider.invalidate(['src/a.ts']);
  await provider.prime({});
}

function routeOf(request: RecordedRequest): string {
  return new URL(request.url, 'http://localhost').pathname;
}

let token: string;
let savedConfig: string | null;
let recorded: RecordedRequest[];
let server: http.Server;
let stderrChunks: string[];
let originalStderrWrite: typeof process.stderr.write;

beforeAll(async () => {
  token = loadTestToken();
  savedConfig = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH, 'utf-8') : null;
});

afterAll(() => {
  if (savedConfig === null) fs.rmSync(KB_CONFIG_PATH, { force: true });
  else fs.writeFileSync(KB_CONFIG_PATH, savedConfig);
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
  recorded = [];
  server = await startRecordingServer(recorded);
  stderrChunks = [];
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return (originalStderrWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
});

afterEach(async () => {
  process.stderr.write = originalStderrWrite;
  await closeServer(server);
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
});

async function setupHttpKb(folder: string, listenPort = portOf(server)): Promise<void> {
  const result = JSON.parse(await kbSetup({ provider: 'http', remote: `http://127.0.0.1:${listenPort}`, token }, { folder }));
  expect(result.success).toBe(true);
}

describe('normaliseRemoteForIdentity', () => {
  it.each([
    ['https://host/org/repo.git', 'host/org/repo'],
    ['https://user:secret@Host.example:8443/org/repo/', 'host.example/org/repo'],
    ['ssh://git@host/org/repo.git', 'host/org/repo'],
    ['git@host:org/repo.git', 'host/org/repo'],
    ['https://tok@host/org/My%20Project/_git/repo', 'host/org/My%20Project/_git/repo'],
    ['https://host/org/My Project/_git/r\u00e9p', 'host/org/My%20Project/_git/r%C3%A9p'],
  ])('%s -> %s', (input, expected) => {
    const output = normaliseRemoteForIdentity(input);
    expect(output).toBe(expected);
    expect(output).not.toMatch(/user|secret|tok/);
  });

  it.each([
    ['empty', ''],
    ['not a url', 'not a url'],
    ['a result over 512 characters', `https://host/${'a'.repeat(600)}`],
  ])('returns undefined for %s', (_label, input) => {
    expect(normaliseRemoteForIdentity(input)).toBeUndefined();
  });

  it('always yields printable ASCII without spaces', () => {
    const output = normaliseRemoteForIdentity('https://host/a b/\u0001c/\u4e2d')!;
    expect(output).toBe('host/a%20b/%01c/%E4%B8%AD');
  });
});

describe('HTTP KB provider sends repository identity', () => {
  it('sends X-Repository on capture, query, context, invalidate and prime, and X-Repository-Commit equal to HEAD on capture only', async () => {
    const repo = makeGitRepo(ORIGIN_WITH_CREDENTIALS);
    const head = git(repo, ['rev-parse', 'HEAD']);
    await setupHttpKb(repo);

    const providers = await getKbProviders(repo);
    expect(providers.project).toBeInstanceOf(HttpKbProvider);
    await exerciseAllRoutes(providers.project);

    expect(recorded.map(routeOf)).toEqual([
      '/api/kb/capture', '/api/kb/query', '/api/kb/context', '/api/kb/invalidate', '/api/kb/prime',
    ]);
    for (const request of recorded) {
      expect(request.headers['x-repository']).toBe(ORIGIN_IDENTITY);
    }
    expect(recorded[0].headers['x-repository-commit']).toBe(head);
    for (const request of recorded.slice(1)) {
      expect(request.headers).not.toHaveProperty('x-repository-commit');
    }
  });

  it('reads the commit at capture time, so a moved HEAD is reflected on the next capture', async () => {
    const repo = makeGitRepo(ORIGIN_WITH_CREDENTIALS);
    await setupHttpKb(repo);
    const providers = await getKbProviders(repo);
    await providers.project.capture(makeEntry());
    const movedHead = commit(repo, 'second');
    await providers.project.capture(makeEntry());
    expect(recorded[1].headers['x-repository-commit']).toBe(movedHead);
    expect(recorded[0].headers['x-repository-commit']).not.toBe(movedHead);
  });

  it('sends no X-Repository header (absent, not empty) for a non-git folder', async () => {
    const folder = makeTempDir();
    await setupHttpKb(folder);
    const providers = await getKbProviders(folder);
    await exerciseAllRoutes(providers.project);
    expect(recorded).toHaveLength(5);
    for (const request of recorded) {
      expect(request.headers).not.toHaveProperty('x-repository');
      expect(request.headers).not.toHaveProperty('x-repository-commit');
    }
  });

  it('gives each of two repos served by one process its own identity', async () => {
    const repoA = makeGitRepo('https://host.example/org/alpha.git');
    const repoB = makeGitRepo('git@host.example:org/beta.git');
    await setupHttpKb(repoA);
    const providersA = await getKbProviders(repoA);
    const providersB = await getKbProviders(repoB);

    await providersA.project.query({ query: 'a' });
    await providersB.project.query({ query: 'b' });
    await providersA.project.capture(makeEntry());
    await providersB.project.capture(makeEntry());

    expect(recorded.map(r => r.headers['x-repository'])).toEqual([
      'host.example/org/alpha', 'host.example/org/beta', 'host.example/org/alpha', 'host.example/org/beta',
    ]);
    expect(recorded[2].headers['x-repository-commit']).toBe(git(repoA, ['rev-parse', 'HEAD']));
    expect(recorded[3].headers['x-repository-commit']).toBe(git(repoB, ['rev-parse', 'HEAD']));
  });

  it('replays a capture queued while the server was down with its original identity and commit, after HEAD moved', async () => {
    const repo = makeGitRepo(ORIGIN_WITH_CREDENTIALS);
    const queuedHead = git(repo, ['rev-parse', 'HEAD']);
    // A port with nothing listening: bind, read it, close.
    const probe = await startRecordingServer([]);
    const downPort = portOf(probe);
    await closeServer(probe);
    await setupHttpKb(repo, downPort);

    const providers = await getKbProviders(repo);
    const http = providers.project as HttpKbProvider;
    const result = await http.capture(makeEntry());
    expect(result.id).toMatch(/^offline-/);
    expect(http.offlineQueue).toHaveLength(1);

    const movedHead = commit(repo, 'after queue');
    expect(movedHead).not.toBe(queuedHead);

    const replayed: RecordedRequest[] = [];
    const upServer = await startRecordingServer(replayed, downPort);
    try {
      await http.query({ query: 'flush' });
    } finally {
      await closeServer(upServer);
    }
    expect(http.offlineQueue).toHaveLength(0);
    expect(replayed.map(routeOf)).toEqual(['/api/kb/capture', '/api/kb/query']);
    expect(replayed[0].headers['x-repository']).toBe(ORIGIN_IDENTITY);
    expect(replayed[0].headers['x-repository-commit']).toBe(queuedHead);
  });

  it('for a remote-member anchor takes X-Repository from remoteUrl and sends no commit, never reading the anchor folder', async () => {
    // The anchor folder is a real repo with a DIFFERENT origin and a commit: if
    // git ran against it, the identity would be its origin and a commit would be sent.
    const folder = makeGitRepo('https://other.example/local/checkout.git');
    await setupHttpKb(folder);
    const providers = await getSelfKbProviders({
      folder,
      remoteUrl: ORIGIN_WITH_CREDENTIALS,
      memberId: 'remote-member-id',
    });
    await exerciseAllRoutes(providers.project);
    expect(recorded).toHaveLength(5);
    for (const request of recorded) {
      expect(request.headers['x-repository']).toBe(ORIGIN_IDENTITY);
      expect(request.headers).not.toHaveProperty('x-repository-commit');
    }
  });

  it('never puts the raw remote URL or its credentials in a header, error or stderr', async () => {
    const repo = makeGitRepo(ORIGIN_WITH_CREDENTIALS);
    await setupHttpKb(repo);
    const providers = await getKbProviders(repo);
    await exerciseAllRoutes(providers.project);
    const remoteMember = await getSelfKbProviders({ folder: repo, remoteUrl: ORIGIN_WITH_CREDENTIALS, memberId: 'm' });
    await remoteMember.project.query({ query: 'x' });

    // A provider error path: id-level discard is refused by the HTTP provider.
    let errorText = '';
    try {
      await (providers.project as HttpKbProvider).discard(['x']);
    } catch (err) {
      errorText = String(err);
    }

    const everything = [
      ...recorded.map(r => JSON.stringify(r.headers) + r.url + r.body),
      errorText,
      ...stderrChunks,
    ].join('\n');
    expect(everything).not.toContain(SECRET_MARKER);
    expect(everything).not.toContain(ORIGIN_WITH_CREDENTIALS);
    expect(everything).not.toContain('user:');
  });
});
