// Repository identity sent to a remote (HTTP) KB server.
//
// The identity is derived by fleet from the repo's origin remote -- never
// chosen by the agent -- and normalised to a credential-free host/path form so
// it can travel in a request header. The raw remote URL can carry credentials
// (userinfo, tokens), so it must never be logged or sent anywhere; only the
// normalised value leaves this module.

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const MAX_IDENTITY_LENGTH = 512;
const GIT_TIMEOUT_MS = 3000;

/** Identity and commit-resolution handed to the HTTP KB provider. */
export interface RepositoryIdentity {
  /** Normalised origin remote (host/path), never empty. */
  identity: string;
  /**
   * Returns the repo's current HEAD at call time (HEAD moves, so it is never
   * cached). Absent when the folder is not local to this process (a remote
   * member's folder): git must never run against such a path.
   */
  resolveCommit?: () => string | undefined;
}

// URL form: scheme://[userinfo@]host[:port][/path][?query][#fragment]
const URL_FORM = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)/i;
// scp-like form: [user@]host:path (the path must not start with '//').
const SCP_FORM = /^(?:[^@/\s]+@)?([^@/:\s]+):(?!\/\/)([^?#]+)/;

/**
 * Percent-encode every byte that is not printable ASCII (space, control,
 * non-ASCII, DEL) plus any '%' that does not already start a %XX escape.
 * Existing %XX escapes are kept as given.
 */
function encodeIdentityPart(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '%' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      out += ch;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (ch !== '%' && code > 0x20 && code < 0x7f) {
      out += ch;
      continue;
    }
    // Encode the whole code point (a surrogate pair is one character).
    const cp = text.codePointAt(i)!;
    const char = String.fromCodePoint(cp);
    if (char.length === 2) i++;
    for (const byte of Buffer.from(char, 'utf-8')) {
      out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

/** Host without userinfo or port, lowercased; '' when there is none. */
function hostOf(authority: string): string {
  const withoutUser = authority.slice(authority.lastIndexOf('@') + 1);
  const withoutPort = withoutUser.startsWith('[')
    ? withoutUser.slice(0, withoutUser.indexOf(']') + 1)
    : withoutUser.replace(/:[^:]*$/, '');
  return withoutPort.toLowerCase();
}

function trimRepoPath(repoPath: string): string {
  return repoPath
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
}

/**
 * Normalise an origin remote URL to host/path: lowercase host; scheme,
 * userinfo (credentials are never kept), port, query, fragment, trailing .git
 * and trailing '/' stripped. Spaces, non-ASCII and control bytes are
 * percent-encoded (UTF-8). Returns undefined for empty or unparseable input,
 * or a result longer than 512 characters. No vendor-specific rules.
 */
export function normaliseRemoteForIdentity(remoteUrl: string): string | undefined {
  const input = remoteUrl.trim();
  if (!input) return undefined;
  let host: string;
  let repoPath: string;
  const url = URL_FORM.exec(input);
  if (url) {
    host = hostOf(url[1]);
    repoPath = url[2];
  } else {
    const scp = SCP_FORM.exec(input);
    // A one-letter "host" is a Windows drive letter (C:\repo), a local path.
    if (!scp || scp[1].length === 1) return undefined;
    host = scp[1].toLowerCase();
    repoPath = scp[2];
  }
  const trimmed = trimRepoPath(repoPath);
  if (!host || !trimmed) return undefined;
  const identity = `${encodeIdentityPart(host)}/${encodeIdentityPart(trimmed)}`;
  return identity.length > MAX_IDENTITY_LENGTH ? undefined : identity;
}

function gitOutput(repoPath: string, args: string[]): string | undefined {
  // Same ceiling as resolveProjectSlug: the folder itself must be the repo.
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(repoPath) };
  try {
    const out = execFileSync('git', args, {
      cwd: repoPath, env, encoding: 'utf-8', timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
    return out || undefined;
  } catch {
    // Not a git repo, no origin, or git missing: no identity / no commit.
    return undefined;
  }
}

/** The current HEAD commit of a local repo folder, or undefined. */
export function readRepositoryCommit(repoPath: string): string | undefined {
  return gitOutput(repoPath, ['rev-parse', 'HEAD']);
}

/**
 * Repository identity for a KB anchor, same precedence as resolveProjectSlug:
 * a supplied remoteUrl first (the folder is on another host: no commit is
 * ever read), otherwise the local folder's origin remote (commit read from
 * HEAD at call time). No remote -> undefined.
 */
export function resolveRepositoryIdentity(repoPath: string, remoteUrl?: string): RepositoryIdentity | undefined {
  if (remoteUrl && remoteUrl.trim()) {
    const identity = normaliseRemoteForIdentity(remoteUrl);
    return identity ? { identity } : undefined;
  }
  const origin = gitOutput(repoPath, ['remote', 'get-url', 'origin']);
  const identity = origin ? normaliseRemoteForIdentity(origin) : undefined;
  if (!identity) return undefined;
  return { identity, resolveCommit: () => readRepositoryCommit(repoPath) };
}
