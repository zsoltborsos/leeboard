import { EXIT, LeeboardError } from './errors.js';

// Patterns for text that looks like a credential: provider key prefixes, private key
// blocks, URLs with embedded passwords and similar.
const CREDENTIAL_PATTERNS: RegExp[] = [
  /\b(?:gsk_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})\b/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/"<>:]+:[^\s/"<>@]+@/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
];

/** Throws (exit 2) naming the first field that looks like a credential; never echoes the value. */
export function assertNoCredentials(fields: Record<string, string | undefined>): void {
  for (const [name, text] of Object.entries(fields)) {
    if (text !== undefined && CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))) {
      throw new LeeboardError(`credential-like text in ${name}; nothing was written`, EXIT.CREDENTIAL);
    }
  }
}
