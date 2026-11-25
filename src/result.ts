export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
export const json = (data: unknown): string => JSON.stringify(data) + '\n';
