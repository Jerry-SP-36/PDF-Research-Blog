import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { JobManager, atomicJson } from './lib/jobs.mjs';

const isInside = (file, root) => { const relative=path.relative(root,file); return relative!=='' && relative!=='..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const equal = (a,b) => typeof a==='string' && Buffer.byteLength(a)===Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const fail = (message,statusCode=400) => Object.assign(new Error(message),{statusCode});

async function readBody(req) {
  if (!(req.headers['content-type']||'').toLowerCase().startsWith('application/json')) throw fail('此操作需要 JSON。',415);
  let size=0; const chunks=[];
  for await (const chunk of req) { size+=chunk.length; if(size>16000) throw fail('輸入資料太大。',413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'); } catch { throw fail('輸入不是有效 JSON。'); }
}

async function sendFile(req,res,file,type,{download}={}) {
  const info=await stat(file); if(!info.isFile()) throw fail('檔案不存在。',404);
  const headers={'Content-Type':type,'Content-Length':info.size,'Accept-Ranges':'bytes'};
  if(download) headers['Content-Disposition']=`attachment; filename="${download}"`;
  let start=0,end=info.size-1,status=200;
  if(req.headers.range) {
    const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if(!match || (!match[1]&&!match[2])) { res.writeHead(416,{'Content-Range':`bytes */${info.size}`}); res.end(); return; }
    if(!match[1]) start=Math.max(0,info.size-Number(match[2]));
    else { start=Number(match[1]); if(match[2]) end=Math.min(Number(match[2]),end); }
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=info.size) {res.writeHead(416,{'Content-Range':`bytes */${info.size}`});res.end();return;}
    status=206;headers['Content-Range']=`bytes ${start}-${end}/${info.size}`;headers['Content-Length']=end-start+1;
  }
  res.writeHead(status,headers);
  if(req.method==='HEAD'||info.size===0){res.end();return;}
  const stream=createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
}

/** Loopback only; a per-process bootstrap capability becomes an HttpOnly same-site cookie. */
export async function createServer(config,{manager=new JobManager(config),token=randomBytes(32).toString('hex')}={}) {
  await manager.init();
  const staticFiles=new Map([['/',['web/index.html','text/html; charset=utf-8']],['/app.js',['web/app.js','text/javascript; charset=utf-8']],['/styles.css',['web/styles.css','text/css; charset=utf-8']]]);
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const origin=`http://127.0.0.1:${server.address().port}`;
    const json=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    try {
      if(req.headers.host!==origin.slice(7)) throw fail('Host 不符合本機服務。',403);
      const url=new URL(req.url,origin);
      if(req.method==='GET' && url.pathname==='/' && equal(url.searchParams.get('bootstrap'),token)) {
        res.setHeader('Set-Cookie',`pdf_research_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
        res.writeHead(303,{Location:'/'});res.end();return;
      }
      const session=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('pdf_research_session='))?.slice(21);
      if(!equal(session,token)) throw fail('請從 PDF Research App 重新開啟介面。',401);
      if(req.method==='POST') {
        if(req.headers.origin!==origin) throw fail('只接受目前 App 介面的操作。',403);
        const body=await readBody(req);
        if(url.pathname==='/api/preflight'){json(200,await manager.preflight());return;}
        if(url.pathname==='/api/jobs'){json(201,{job:await manager.enqueue(body)});return;}
        const match=/^\/api\/jobs\/([A-Za-z0-9-]+)\/(cancel|respond)$/.exec(url.pathname);
        if(match){json(200,{job:match[2]==='cancel'?await manager.cancel(match[1]):await manager.respond(match[1],body)});return;}
      } else if(req.method==='GET'||req.method==='HEAD') {
        if(url.pathname==='/api/status'){json(200,manager.getStatus());return;}
        if(url.pathname==='/api/jobs'){json(200,{jobs:manager.list()});return;}
        if(staticFiles.has(url.pathname)) {const [file,type]=staticFiles.get(url.pathname);await sendFile(req,res,path.join(config.appRoot,file),type);return;}
        const match=/^\/api\/jobs\/([A-Za-z0-9-]+)(?:\/(report(?:\.md)?|sources|figures)(?:\/([A-Za-z0-9_-]+))?)?$/.exec(url.pathname);
        if(match){
          const job=manager.get(match[1]);
          if(!match[2]){json(200,{job:manager.publicJob(job)});return;}
          if(!job.report?.available||!job._report) throw fail('報告尚未產出。',404);
          if(match[2]==='report'||match[2]==='report.md'){
            await sendFile(req,res,path.join(job.dir,match[2]==='report'?'report.html':'report.md'),match[2]==='report'?'text/html; charset=utf-8':'text/markdown; charset=utf-8',match[2]==='report.md'?{download:`pdf-research-${job.id}.md`}:{});return;
          }
          const figure=match[2]==='figures';
          const record=(figure?job._report.figures:job._report.sources).find(x=>x.id===match[3]);
          if(!record) throw fail('找不到這個來源或圖片。',404);
          const file=await realpath(record.path);
          const roots=await Promise.all((figure?[path.join(job.dir,'report-assets')]:config.sourceRoots).map(p=>realpath(p)));
          if(!roots.some(root=>isInside(file,root))) throw fail('檔案超出此報告可讀取的範圍。',403);
          const type=figure?({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}[path.extname(file).toLowerCase()]):'application/pdf';
          if(!type||(!figure&&path.extname(file).toLowerCase()!=='.pdf')) throw fail('檔案格式不符。',403);
          await sendFile(req,res,file,type);return;
        }
      } else throw fail('不支援的操作。',405);
      throw fail('找不到這個頁面。',404);
    }catch(error){if(!res.headersSent)json(error.statusCode||500,{error:error.statusCode?error.message:'本機服務處理失敗，請稍後重試。'});else res.destroy();}
  });
  server.requestTimeout=120000;server.headersTimeout=15000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,'127.0.0.1',resolve);});
  const url=`http://127.0.0.1:${server.address().port}/?bootstrap=${token}`;
  return {server,manager,url,async close(){await manager.shutdown();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}

async function main(){
  const config=loadConfig();await mkdir(config.dataDir,{recursive:true,mode:0o700});
  const lock=path.join(config.dataDir,'.server-lock'),infoPath=path.join(lock,'owner.json');
  try{await mkdir(lock,{mode:0o700});}
  catch(error){
    if(error.code!=='EEXIST')throw error;
    let info;try{info=JSON.parse(await readFile(infoPath,'utf8'));}catch{throw new Error('App 正在啟動，請稍後重試。');}
    let alive=true;try{process.kill(info.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}
    if(alive){
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3000);
      try{const response=await fetch(info.url,{redirect:'manual',signal:controller.signal});if(response.status!==303)throw new Error('另一個 App 執行個體尚未就緒。');process.stdout.write(JSON.stringify({ready:true,url:info.url,reused:true})+'\n');return;}finally{clearTimeout(timer);}
    }
    await rm(lock,{recursive:true});await mkdir(lock,{mode:0o700});
  }
  await atomicJson(infoPath,{pid:process.pid,url:null});
  let service;
  try{service=await createServer(config);await atomicJson(infoPath,{pid:process.pid,url:service.url});}
  catch(error){await rm(lock,{recursive:true,force:true});throw error;}
  process.stdout.write(JSON.stringify({ready:true,url:service.url})+'\n');
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;await service.close();await rm(lock,{recursive:true,force:true});process.exit(0);};
  process.on('SIGTERM',()=>{void close();});process.on('SIGINT',()=>{void close();});
  void service.manager.preflight().catch(error=>{service.manager.status.ready=false;service.manager.status.checks.push({key:'startup',label:'啟動檢查',status:'error',detail:error.message});});
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
