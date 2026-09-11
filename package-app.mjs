import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP_ROOT } from './lib/config.mjs';

// Stage outside File Provider so the archive has no FinderInfo/resource-fork metadata.
const directory=await mkdtemp(path.join(tmpdir(),'pdf-research-package-'));
const bundle=path.join(directory,'PDF Research.app');
const output=path.join(path.dirname(APP_ROOT),'PDF Research.zip');
try {
  execFileSync('/usr/bin/ditto',['--norsrc','--noextattr',path.join(path.dirname(APP_ROOT),'PDF Research.app'),bundle]);
  execFileSync('/usr/bin/codesign',['--force','--sign','-',bundle]);
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
  execFileSync('/usr/bin/ditto',['-c','-k','--keepParent','--norsrc','--noextattr',bundle,output]);
  const check=path.join(directory,'read-back');
  execFileSync('/usr/bin/ditto',['-x','-k',output,check]);
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',path.join(check,'PDF Research.app')]);
  process.stdout.write(`Packaged and verified ${output}\n`);
} finally { await rm(directory,{recursive:true,force:true}); }
