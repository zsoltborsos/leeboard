// A real writer process with controllable pauses before history append, entry
// rename or recovery claim. These make races deterministic without production hooks.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const [runModule, releaseFile] = process.argv.slice(2);
const stat = fs.fstatSync;
const rename = fs.renameSync;
const mkdir = fs.mkdirSync;
let pause = false;
function pauseWriter(details = {}) {
  pause = false;
  process.send({ type: 'sampled', ...details });
  const deadline = performance.now() + 5000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(releaseFile)) {
    if (performance.now() >= deadline) throw new Error('test writer was not released');
    Atomics.wait(wait, 0, 0, 10);
  }
}
fs.fstatSync = (...args) => {
  const result = stat(...args);
  if (pause === true) pauseWriter({ offset: result.size });
  return result;
};
fs.renameSync = (...args) => {
  if (pause === 'write' && String(args[1]).endsWith('.md')) pauseWriter();
  return rename(...args);
};
fs.mkdirSync = (...args) => {
  if (pause === 'recovery' && String(args[0]).endsWith('/.recovering')) pauseWriter();
  return mkdir(...args);
};
syncBuiltinESMExports();
const { run } = await import(runModule);
process.once('message', async (message) => {
  pause = message.pause;
  process.send({ type: 'started' });
  const result = await run(message.args, process.env, process.cwd());
  process.send({ type: 'done', result });
  process.disconnect();
});
process.send({ type: 'ready' });
