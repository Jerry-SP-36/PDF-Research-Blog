import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP_ROOT } from './lib/config.mjs';

const manifest=JSON.parse(await readFile(path.join(APP_ROOT,'package.json'),'utf8'));
const version=manifest.version;
if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('package.json version must use x.y.z.');
const bundle=process.env.PDF_RESEARCH_BUNDLE_PATH ? path.resolve(process.env.PDF_RESEARCH_BUNDLE_PATH) : path.join(path.dirname(APP_ROOT),'PDF Research.app');
const bundleIdentifier=process.env.PDF_RESEARCH_BUNDLE_IDENTIFIER || 'local.sipitogether.pdf-research';
await mkdir(path.join(bundle,'Contents/MacOS'),{recursive:true});
const resources=path.join(bundle,'Contents/Resources/app');
await mkdir(resources,{recursive:true});
for(const file of ['server.mjs','lib','web','package.json']) await cp(path.join(APP_ROOT,file),path.join(resources,file),{recursive:true});
if(existsSync(path.join(APP_ROOT,'config.local.json'))) await cp(path.join(APP_ROOT,'config.local.json'),path.join(resources,'config.local.json'));
await writeFile(path.join(bundle,'Contents/Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>PDF Research</string><key>CFBundleDisplayName</key><string>PDF Research</string><key>CFBundleIdentifier</key><string>${bundleIdentifier}</string><key>CFBundleExecutable</key><string>PDFResearch</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string><key>LSMinimumSystemVersion</key><string>13.0</string><key>NSHighResolutionCapable</key><true/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>`);
const cache=path.resolve(APP_ROOT,'../../work/swift-module-cache');await mkdir(cache,{recursive:true});
execFileSync('/usr/bin/swiftc',['-O','-module-cache-path',cache,'-framework','Cocoa','-framework','WebKit',path.join(APP_ROOT,'native/App.swift'),'-o',path.join(bundle,'Contents/MacOS/PDFResearch')],{stdio:'inherit'});
// File Provider may add empty FinderInfo to a newly generated bundle in Documents.
try { execFileSync('/usr/bin/xattr',['-d','com.apple.FinderInfo',bundle],{stdio:'ignore'}); } catch {}
execFileSync('/usr/bin/codesign',['--force','--sign','-',bundle],{stdio:'inherit'});
console.log(`Built ${bundle}`);
