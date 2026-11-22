#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
    printf 'Usage: %s <major.minor.patch>\nExample: %s 1.0.3\n' "$0" "$0" >&2
    exit 2
fi

VERSION=$1
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$ROOT_DIR"

node - "$VERSION" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const version = process.argv[2];
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error('Version must be major.minor.patch, for example 1.0.3.');
}

const [major, minor, patch] = version.split('.').map(Number);
const gameVersion = `${major}.${minor}.${patch}.0`;
const packageFile = path.join(process.cwd(), 'package.json');
const lockFile = path.join(process.cwd(), 'package-lock.json');
const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
const current = pkg.version.split('.').map(Number);
let isNewer = false;
for (let index = 0; index < 3; index++) {
  if ([major, minor, patch][index] === current[index]) continue;
  isNewer = [major, minor, patch][index] > current[index];
  break;
}

if (!isNewer) throw new Error(`Target ${version} must be newer than package version ${pkg.version}.`);
if (!lock.packages?.['']) throw new Error('package-lock.json is missing its root package entry.');

const replacements = [
  ['public/Alone.html', /(<meta\s+name=["']game-version["']\s+content=["'])\d+(?:\.\d+){3}(["'])/, (_match, prefix, suffix) => `${prefix}${gameVersion}${suffix}`],
  ['public/Alone.html', /(id=["']game-version-label["'][^>]*>\s*VERSION\s+)\d+(?:\.\d+){3}/, (_match, prefix) => `${prefix}${gameVersion}`],
  ['public/js/state.js', /(\?\.\s*content\s*\|\|\s*["'])\d+(?:\.\d+){3}(["'])/, (_match, prefix, suffix) => `${prefix}${gameVersion}${suffix}`],
  ['launcher.html', /(id=["']latest-version-label["'][^>]*>CURRENT\s*·\s*)\d+(?:\.\d+){3}/, (_match, prefix) => `${prefix}${gameVersion}`],
  ['launcher.html', /(id=["']launcher-version-label["'][^>]*>)\d+(?:\.\d+){3}/, (_match, prefix) => `${prefix}${gameVersion}`]
];

const updates = new Map([
  [packageFile, `${JSON.stringify({
    ...pkg,
    version,
    gameVersion,
    build: { ...pkg.build, buildVersion: gameVersion }
  }, null, 2)}\n`],
  [lockFile, `${JSON.stringify({
    ...lock,
    version,
    packages: {
      ...lock.packages,
      '': { ...lock.packages[''], version }
    }
  }, null, 2)}\n`]
]);

for (const [relativeFile, expression, replacement] of replacements) {
  const file = path.join(process.cwd(), relativeFile);
  let contents = updates.get(file) ?? fs.readFileSync(file, 'utf8');
  let count = 0;
  contents = contents.replace(expression, (...args) => {
    count++;
    return replacement(...args);
  });
  if (count !== 1) throw new Error(`Expected one version field in ${relativeFile}; found ${count}.`);
  updates.set(file, contents);
}

for (const [file, contents] of updates) fs.writeFileSync(file, contents);
console.log(`Prepared release versions: ${version} (game/build ${gameVersion}).`);
NODE

for file in electron-main.js electron-preload.js launcher.js public/js/*.js; do
    node --check "$file"
done

npm run desktop:build

printf '\nBuild complete. Review the changes, then commit and push the intended release files to main.\n'
printf 'After main contains the release commit, create and push the tag:\n'
printf '  git tag v%s\n' "$VERSION"
printf '  git push origin v%s\n' "$VERSION"
printf 'This script did not commit, tag, or push anything.\n'
