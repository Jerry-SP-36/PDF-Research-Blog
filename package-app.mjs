import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP_ROOT } from './lib/config.mjs';

const deploymentTarget = '13.5';
const architectures = ['arm64', 'x86_64'];

function assertUniversal2(bundle) {
  const executable = path.join(bundle, 'Contents/MacOS/PDFResearch');
  const actual = execFileSync('/usr/bin/lipo', ['-archs', executable], { encoding: 'utf8' }).trim().split(/\s+/).sort();
  const expected = [...architectures].sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`Expected Universal 2 (${expected.join(', ')}); found ${actual.join(', ') || 'no architectures'}.`);
  }

  const buildInfo = execFileSync('/usr/bin/vtool', ['-show-build', executable], { encoding: 'utf8' });
  const minimums = [...buildInfo.matchAll(/^\s*minos\s+(\S+)\s*$/gm)].map((match) => match[1]);
  if (minimums.length !== architectures.length || minimums.some((value) => value !== deploymentTarget)) {
    throw new Error(`Expected macOS ${deploymentTarget} deployment target for both architectures; found ${minimums.join(', ') || 'none'}.`);
  }

  const minimumSystemVersion = execFileSync('/usr/bin/plutil', [
    '-extract', 'LSMinimumSystemVersion', 'raw', '-o', '-', path.join(bundle, 'Contents/Info.plist'),
  ], { encoding: 'utf8' }).trim();
  if (minimumSystemVersion !== deploymentTarget) {
    throw new Error(`Expected LSMinimumSystemVersion ${deploymentTarget}; found ${minimumSystemVersion}.`);
  }
}

// Stage outside File Provider so the archive has no FinderInfo/resource-fork metadata.
const directory = await mkdtemp(path.join(tmpdir(), 'pdf-research-package-'));
const source = path.join(path.dirname(APP_ROOT), 'PDF Research.app');
const bundle = path.join(directory, 'PDF Research.app');
const output = path.join(path.dirname(APP_ROOT), 'PDF Research.zip');
try {
  assertUniversal2(source);
  execFileSync('/usr/bin/ditto', ['--norsrc', '--noextattr', source, bundle]);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', bundle]);
  execFileSync('/usr/bin/codesign', ['--verify', '--all-architectures', '--deep', '--strict', bundle]);
  assertUniversal2(bundle);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', '--noextattr', bundle, output]);

  const check = path.join(directory, 'read-back');
  execFileSync('/usr/bin/ditto', ['-x', '-k', output, check]);
  const readBack = path.join(check, 'PDF Research.app');
  execFileSync('/usr/bin/codesign', ['--verify', '--all-architectures', '--deep', '--strict', readBack]);
  assertUniversal2(readBack);
  process.stdout.write(`Packaged and verified Universal 2 ${output}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
