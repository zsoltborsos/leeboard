export const EXIT = {
  USAGE: 1,
  CREDENTIAL: 2,
  CHECK_BLOCKED: 3,
  UNKNOWN_ID: 4,
  BAD_TRANSITION: 5,
  NOT_PERMITTED: 6,
} as const;

/** An error that maps to a specific CLI exit code. */
export class LeeboardError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = 'LeeboardError';
  }
}

export const usageError = (message: string): LeeboardError => new LeeboardError(message, EXIT.USAGE);
