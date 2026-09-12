import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP_ROOT } from './lib/config.mjs';

const deploymentTarget = '13.5';
const architectures = ['arm64', 'x86_64'];
const manifest = JSON.parse(await readFile(path.join(APP_ROOT, 'package.json'), 'utf8'));
const version = manifest.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('package.json version must use x.y.z.');

const bundle = process.env.PDF_RESEARCH_BUNDLE_PATH
  ? path.resolve(process.env.PDF_RESEARCH_BUNDLE_PATH)
  : path.join(path.dirname(APP_ROOT), 'PDF Research.app');
const bundleIdentifier = process.env.PDF_RESEARCH_BUNDLE_IDENTIFIER || 'local.sipitogether.pdf-research';
const executable = path.join(bundle, 'Contents/MacOS/PDFResearch');

function assertUniversal2(binary) {
  const actual = execFileSync('/usr/bin/lipo', ['-archs', binary], { encoding: 'utf8' }).trim().split(/\s+/).sort();
  const expected = [...architectures].sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`Expected Universal 2 (${expected.join(', ')}); found ${actual.join(', ') || 'no architectures'}.`);
  }

  const buildInfo = execFileSync('/usr/bin/vtool', ['-show-build', binary], { encoding: 'utf8' });
  const minimums = [...buildInfo.matchAll(/^\s*minos\s+(\S+)\s*$/gm)].map((match) => match[1]);
  if (minimums.length !== architectures.length || minimums.some((value) => value !== deploymentTarget)) {
    throw new Error(`Expected macOS ${deploymentTarget} deployment target for both architectures; found ${minimums.join(', ') || 'none'}.`);
  }
}

function assertMinimumSystemVersion(appBundle) {
  const value = execFileSync('/usr/bin/plutil', [
    '-extract', 'LSMinimumSystemVersion', 'raw', '-o', '-', path.join(appBundle, 'Contents/Info.plist'),
  ], { encoding: 'utf8' }).trim();
  if (value !== deploymentTarget) throw new Error(`Expected LSMinimumSystemVersion ${deploymentTarget}; found ${value}.`);
}

await mkdir(path.join(bundle, 'Contents/MacOS'), { recursive: true });
const resources = path.join(bundle, 'Contents/Resources/app');
await mkdir(resources, { recursive: true });
for (const file of ['server.mjs', 'lib', 'web', 'package.json']) {
  await cp(path.join(APP_ROOT, file), path.join(resources, file), { recursive: true });
}
if (existsSync(path.join(APP_ROOT, 'config.local.json'))) {
  await cp(path.join(APP_ROOT, 'config.local.json'), path.join(resources, 'config.local.json'));
}
await writeFile(path.join(bundle, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>PDF Research</string><key>CFBundleDisplayName</key><string>PDF Research</string><key>CFBundleIdentifier</key><string>${bundleIdentifier}</string><key>CFBundleExecutable</key><string>PDFResearch</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string><key>LSMinimumSystemVersion</key><string>${deploymentTarget}</string><key>NSHighResolutionCapable</key><true/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>`);

const buildDirectory = await mkdtemp(path.join(tmpdir(), 'pdf-research-native-'));
const moduleCache = path.resolve(APP_ROOT, '../../work/swift-module-cache');
await mkdir(moduleCache, { recursive: true });
try {
  const slices = [];
  for (const architecture of architectures) {
    const output = path.join(buildDirectory, `PDFResearch-${architecture}`);
    execFileSync('/usr/bin/swiftc', [
      '-O',
      '-target', `${architecture}-apple-macos${deploymentTarget}`,
      '-module-cache-path', path.join(moduleCache, architecture),
      '-framework', 'Cocoa',
      '-framework', 'WebKit',
      path.join(APP_ROOT, 'native/App.swift'),
      '-o', output,
    ], { stdio: 'inherit' });
    slices.push(output);
  }
  execFileSync('/usr/bin/lipo', ['-create', ...slices, '-output', executable]);
  assertUniversal2(executable);
} finally {
  await rm(buildDirectory, { recursive: true, force: true });
}

// File Provider may add empty FinderInfo to a newly generated bundle in Documents.
try { execFileSync('/usr/bin/xattr', ['-d', 'com.apple.FinderInfo', bundle], { stdio: 'ignore' }); } catch {}
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', bundle], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', ['--verify', '--all-architectures', '--deep', bundle]);
assertUniversal2(executable);
assertMinimumSystemVersion(bundle);
console.log(`Built Universal 2 ${bundle} (arm64 + x86_64, macOS ${deploymentTarget}+)`);
