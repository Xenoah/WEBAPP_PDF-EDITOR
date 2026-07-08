import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function rel(file) {
  return path.relative(root, file).replaceAll(path.sep, '/');
}

function checkWithNode(file, args, input) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    input,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    failures.push(`${rel(file)}\n${result.stderr || result.stdout}`);
  }
}

async function checkJson(file) {
  try {
    JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    failures.push(`${rel(file)}\n${error.message}`);
  }
}

async function checkModule(file) {
  const source = await readFile(file, 'utf8');
  checkWithNode(file, ['--check', '--input-type=module'], source);
}

async function checkScript(file) {
  checkWithNode(file, ['--check', file], undefined);
}

await checkJson(path.join(root, 'package.json'));
await checkJson(path.join(root, 'manifest.json'));
await checkScript(path.join(root, 'server.js'));
await checkScript(path.join(root, 'sw.js'));

const jsDir = path.join(root, 'js');
for (const name of (await readdir(jsDir)).filter(name => name.endsWith('.js')).sort()) {
  await checkModule(path.join(jsDir, name));
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('Syntax check passed.');
