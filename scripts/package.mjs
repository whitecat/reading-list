import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const buildDir = resolve(root, 'build');
const distDir = resolve(root, 'dist');
const unpackedDir = resolve(distDir, 'unpacked');

const removals = {
  chrome: ['browser_specific_settings', 'background.scripts', 'sidebar_action'],
  edge: ['browser_specific_settings', 'background.scripts', 'sidebar_action'],
  opera: ['browser_specific_settings', 'background.scripts', 'side_panel', 'permissions[sidePanel]'],
  firefox: ['minimum_chrome_version', 'background.service_worker', 'side_panel', 'permissions[sidePanel]'],
};

const targets = Object.keys(removals);

const requested = process.argv.slice(2);
const selected = requested.length === 0 || requested.includes('all') ? targets : requested;

for (const name of selected) {
  if (!targets.includes(name)) {
    console.error(`Unknown target "${name}". Use one of: all, ${targets.join(', ')}`);
    process.exit(1);
  }
}

if (!existsSync(resolve(buildDir, 'manifest.json'))) {
  console.error('build/manifest.json not found. Run "npm run build" first.');
  process.exit(1);
}

function removeKey(manifest, path) {
  const element = path.match(/^(.+)\[(.+)\]$/);
  if (element) {
    const list = element[1].split('.').reduce((node, part) => node?.[part], manifest);
    const index = Array.isArray(list) ? list.indexOf(element[2]) : -1;
    if (index === -1) {
      throw new Error(`manifest.json is missing expected entry "${path}"`);
    }
    list.splice(index, 1);
    return;
  }
  const parts = path.split('.');
  const last = parts.pop();
  let parent = manifest;
  for (const part of parts) {
    parent = parent?.[part];
  }
  if (parent === undefined || parent === null || !(last in parent)) {
    throw new Error(`manifest.json is missing expected key "${path}"`);
  }
  delete parent[last];
}

function writeTargetManifest(name, dir) {
  const manifestPath = resolve(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const path of removals[name]) {
    removeKey(manifest, path);
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

mkdirSync(unpackedDir, { recursive: true });

for (const name of selected) {
  const dir = resolve(unpackedDir, name);
  rmSync(dir, { recursive: true, force: true });
  cpSync(buildDir, dir, { recursive: true, filter: (src) => !src.endsWith('.DS_Store') });
  writeTargetManifest(name, dir);

  const file = `reading-list-${name}.zip`;
  if (name === 'firefox') {
    execFileSync(
      'npx',
      ['web-ext', 'build', `--source-dir=dist/unpacked/${name}`, '--artifacts-dir=dist', '--overwrite-dest', `--filename=${file}`],
      { cwd: root, stdio: 'inherit' },
    );
  } else {
    const out = resolve(distDir, file);
    rmSync(out, { force: true });
    execFileSync('zip', ['-r', '-q', '-X', out, '.', '-x', '*.DS_Store'], { cwd: dir, stdio: 'inherit' });
  }
  console.log(`dist/${file}`);
}
