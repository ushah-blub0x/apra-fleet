import { z } from 'zod';

/**
 * The cross-repository read opt-in shared by kb_query, kb_context and
 * kb_session_prime. Only a remote (HTTP) KB server acts on it; local
 * providers and MEMBER bible-view reads accept it and change nothing.
 */
export const allRepositoriesSchema = z.boolean().optional()
  .describe('Also return entries captured in other repositories; by default a server may limit results to the caller\'s repository and team-wide entries.');
