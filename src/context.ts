import type { Author } from './entry.js';

/** What every command needs: where the store is, the clock, the working directory and who is acting. */
export interface Ctx {
  home: string;
  now: Date;
  cwd: string;
  identity: Author;
}
