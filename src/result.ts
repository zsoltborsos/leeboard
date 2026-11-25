export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const result = (code: number, stdout: string): RunResult => ({ code, stdout, stderr: '' });
export const ok = (stdout = ''): RunResult => result(0, stdout);
export const jsonLine = (data: unknown): string => JSON.stringify(data) + '\n';
