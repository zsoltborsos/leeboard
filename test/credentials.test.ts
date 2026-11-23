import { describe, expect, it } from 'vitest';
import { EXIT, LeeboardError } from '../src/errors.js';
import { assertNoCredentials } from '../src/credentials.js';

function rejection(fields: Record<string, string | undefined>): LeeboardError {
  try {
    assertNoCredentials(fields);
  } catch (error) {
    expect(error).toBeInstanceOf(LeeboardError);
    return error as LeeboardError;
  }
  throw new Error('expected a credential rejection');
}

// Fake values shaped like the real thing.
const secrets: Record<string, string> = {
  'groq key': 'gsk_' + 'a1B2c3D4'.repeat(3),
  'hugging face token': 'hf_' + 'Zz9Yy8Xx'.repeat(3),
  'github fine-grained token': 'github_pat_' + '11AAAA_bbbb'.repeat(2),
  'github token': 'ghp_' + 'q1w2e3r4t5'.repeat(3),
  'api key': 'sk-' + 'abcDEF0123456789'.repeat(2),
  'private key block': '-----BEGIN RSA PRIVATE KEY-----',
  'private key block (bare)': '-----BEGIN PRIVATE KEY-----',
  'url with credentials': 'postgres://admin:hunter2secret@db.example.test:5432/app',
  'bearer token': 'Authorization: Bearer abcdefghijklmnop0123456789',
  'lowercase bearer token': 'bearer ABCDEFGHIJKLMNOP.0123456789-_~+/=',
};

describe('assertNoCredentials', () => {
  it.each(Object.entries(secrets))('rejects a %s in the body with exit 2, naming the field only', (_name, secret) => {
    const error = rejection({ title: 'Harmless title', body: `Some note with ${secret} inside it.` });
    expect(error.exitCode).toBe(EXIT.CREDENTIAL);
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain('body');
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain(secret.slice(0, 12));
  });

  it('names the title when the title matches', () => {
    const error = rejection({ title: `token ${secrets['github token']}`, body: 'fine' });
    expect(error.message).toContain('title');
    expect(error.message).not.toContain('body');
  });

  it('also checks other free-text fields it is given', () => {
    const error = rejection({ title: 'ok', release: `when ${secrets['api key']} rotates` });
    expect(error.message).toContain('release');
  });

  it.each([
    'Plain prose about sk-learn and ghp mentions',
    'sk-short',
    'See https://example.com/docs/page and ssh://git@github.com/acme/x.git',
    'Contact owner@example.com about Bearer tokens',
    'Bearer short',
    '-----BEGIN CERTIFICATE-----',
  ])('accepts %j', (text) => {
    expect(() => assertNoCredentials({ title: 'ok', body: text })).not.toThrow();
  });

  it('ignores fields that are absent', () => {
    expect(() => assertNoCredentials({ title: 'ok', body: undefined })).not.toThrow();
  });
});
