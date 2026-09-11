import { access, appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { CodexRpc } from './codex-rpc.mjs';
import { developerInstructions, userPrompt, DYNAMIC_TOOLS } from './workflow.mjs';
import { workerEnvironment } from './config.mjs';
import { validateReport, renderHtml, renderMarkdown } from './report.mjs';

const exec = promisify(execFile);
const ACTIVE = new Set(['queued', 'preparing', 'running', 'needs_input', 'validating']);
const now = () => new Date().toISOString();
const xml = text => String(text).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
const safeError = error => String(error?.message || error).replace(/(?:Bearer\s+)[\w.\-]+/gi, 'Bearer [redacted]').slice(0,3000);
const isPdfSearchConsent=(job,request)=>{
  const p=request.params||{},schema=p.requestedSchema;
  return typeof job.threadId==='string' && job.threadId.length>0 && request.method==='mcpServer/elicitation/request' && p.serverName==='cua_repl' && p.threadId===job.threadId &&
    p.message==='Allow Computer Use to use "PDF Search"?' && schema?.type==='object' &&
    schema.properties && typeof schema.properties==='object' && !Array.isArray(schema.properties) && Object.keys(schema.properties).length===0 &&
    (schema.required==null || (Array.isArray(schema.required) && schema.required.length===0));
};

export async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}

export function cleanRequest(body, defaults = {}) {
  if (!body || typeof body.topic !== 'string') throw new Error('請輸入研究主題。');
  const topic = body.topic.trim();
  if (!topic || topic.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(topic)) throw new Error('主題請填寫 1–500 個字元。');
  const sourceCount = body.sourceCount ?? null;
  const figureTarget = body.figureTarget ?? null;
  const model = body.model ?? defaults.defaultModel ?? 'gpt-5.6-luna';
  const reasoningEffort = body.reasoningEffort === undefined ? (defaults.defaultReasoningEffort ?? 'high') : body.reasoningEffort;
  if (sourceCount !== null && (!Number.isInteger(sourceCount) || sourceCount < 3 || sourceCount > 8)) throw new Error('來源份數需為自動或 3–8。');
  if (figureTarget !== null && (!Number.isInteger(figureTarget) || figureTarget < 4 || figureTarget > 16)) throw new Error('圖表目標需為自動或 4–16。');
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(model)) throw new Error('請選擇有效的 Codex 模型。');
  if (reasoningEffort !== null && !['none','minimal','low','medium','high','xhigh','max','ultra'].includes(reasoningEffort)) throw new Error('請選擇有效的思考深度。');
  return { topic, sourceCount, figureTarget, model, reasoningEffort };
}

export async function readModels(rpc) {
  const models=[], seen=new Set(); let cursor;
  do {
    const page=await rpc.request('model/list',{limit:100,...(cursor?{cursor}:{})});
    if (!Array.isArray(page.data)) throw new Error('Codex 沒有回傳有效模型清單。');
    models.push(...page.data.filter(m=>typeof m.model==='string' && (!m.inputModalities || m.inputModalities.includes('image'))));
    cursor=page.nextCursor;
    if(cursor && seen.has(cursor)) throw new Error('模型清單分頁重複。');
    seen.add(cursor);
  } while(cursor);
  if(!models.length) throw new Error('沒有可讀取圖片的 Codex 模型。');
  return models;
}

export function validateModel(input, models) {
  const model=models.find(m=>m.model===input.model);
  if(!model) throw new Error(`此 Codex 帳號目前無法選用 ${input.model}，請重新選擇模型。`);
  if(input.reasoningEffort!==null && !model.supportedReasoningEfforts?.some(e=>e.reasoningEffort===input.reasoningEffort)) throw new Error(`${input.model} 不支援 ${input.reasoningEffort} 思考深度。`);
  return model;
}

export class JobManager {
  constructor(config, { rpcFactory = options => new CodexRpc(options), artifactVerifier } = {}) {
    this.config = config;
    this.rpcFactory = rpcFactory;
    this.artifactVerifier = artifactVerifier || (report => this.verifyArtifacts(report));
    this.jobs = new Map();
    this.activeJobId = null;
    this.draining = false;
    this.shuttingDown = false;
    this.preflightPromise = null;
    this.status = { ready: false, version: config.version, checks: [{ key: 'codex', label: 'Codex', status: 'checking', detail: '正在確認本機執行環境' }] };
  }

  async init() {
    await mkdir(path.join(this.config.dataDir, 'jobs'), { recursive: true, mode: 0o700 });
    for (const dirent of await readdir(path.join(this.config.dataDir, 'jobs'), { withFileTypes: true })) {
      if (!dirent.isDirectory() || !/^[a-zA-Z0-9-]+$/.test(dirent.name)) continue;
      const dir = path.join(this.config.dataDir, 'jobs', dirent.name);
      try {
        const job = JSON.parse(await readFile(path.join(dir, 'job.json'), 'utf8'));
        if (job.id !== dirent.name || !Array.isArray(job.events)) continue;
        job.dir = dir;
        job._pending = new Map();
        job._save = Promise.resolve();
        job.pendingRequests = [];
        if (ACTIVE.has(job.status)) {
          job.status = 'interrupted';
          job.error = '上次程式結束時研究尚未完成；已保留當時資料，沒有自動重跑。';
          job.progress = { stage: 'interrupted', label: '研究已中斷' };
          job.updatedAt = now();
        }
        if (job.report?.available) {
          try { job._report = JSON.parse(await readFile(path.join(dir, 'report.normalized.json'), 'utf8')); }
          catch { job.report.available = false; job.status = 'failed'; job.error = '找不到已儲存的報告資料。'; }
        }
        this.jobs.set(job.id, job);
        await this.persist(job);
      } catch { /* An incomplete atomic write is not a completed job. */ }
    }
  }

  publicJob(job, detailed = true) {
    return {
      id: job.id, topic: job.topic, sourceCount: job.sourceCount, figureTarget: job.figureTarget,
      model:job.model ?? null, actualModel:job.actualModel ?? null, reasoningEffort:job.reasoningEffort ?? null, actualReasoningEffort:job.actualReasoningEffort ?? null,
      tokenUsage:job.tokenUsage ?? null,
      status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt,
      progress: job.progress, events: detailed ? job.events : job.events.slice(-1),
      error: job.error || null, stats: job.stats, report: job.report,
      pendingRequests: job.pendingRequests || [],
      finalMessage: job.finalMessage || null,
    };
  }
  list() { return [...this.jobs.values()].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(j => this.publicJob(j,false)); }
  get(id) { const job = this.jobs.get(id); if (!job) throw Object.assign(new Error('找不到這份研究。'), { statusCode: 404 }); return job; }
  getStatus() { return { ...this.status, defaultModel:this.config.defaultModel ?? 'gpt-5.6-luna', defaultReasoningEffort:this.config.defaultReasoningEffort ?? 'high', activeJobId: this.activeJobId }; }

  persist(job) {
    const value = { ...this.publicJob(job), threadId: job.threadId || null, turnId: job.turnId || null, runtimeEvidence: job.runtimeEvidence, validation: job.validation || null };
    job._save = (job._save || Promise.resolve()).catch(() => {}).then(() => atomicJson(path.join(job.dir, 'job.json'), value));
    return job._save;
  }
  event(job, kind, message) {
    job.updatedAt = now();
    job.events.push({ at: job.updatedAt, kind, message: String(message).slice(0,2000) });
    if (job.events.length > 500) job.events.splice(0,job.events.length-500);
    this.persist(job).catch(() => {});
  }

  rpcOptions(cwd) {
    return { executable: this.config.codexPath, cwd, args: this.config.codexArgs || [], env: workerEnvironment(this.config,cwd), timeoutMs: 45000 };
  }

  async preflight() {
    if (this.preflightPromise) return this.preflightPromise;
    if (this.activeJobId) return this.getStatus();
    this.preflightPromise = this.performPreflight().finally(() => { this.preflightPromise = null; });
    return this.preflightPromise;
  }

  async performPreflight() {
    const checks = [];
    this.status = { ready: false, version: this.config.version, checks };
    for (const [key,label,file] of [
      ['codex','Codex',this.config.codexPath], ['skill','PDF Search 工作流程',this.config.skillPath],
      ['pdfSearch','PDF Search',this.config.pdfAppPath], ['pdfTools','PDF 圖像工具',path.join(this.config.pdfToolDir,'pdftoppm')],
      ['python','報告驗證工具',this.config.pythonPath],
    ]) {
      try { await access(file); checks.push({ key,label,status:'ok',detail:key==='pdfSearch'?'已安裝；操作權限於研究時確認':file }); }
      catch { checks.push({ key,label,status:'error',detail:`找不到：${file}` }); }
    }
    const missingRoots = this.config.sourceRoots.filter(p => !existsSync(p));
    checks.push({key:'sources',label:'本地 PDF 來源',status:missingRoots.length?'error':'ok',detail:this.config.sourceRoots.join('\n')});
    if (checks.some(c => c.status==='error')) return this.getStatus();
    try {
      const version = await exec(this.config.codexPath,['--version'],{timeout:5000,maxBuffer:65536});
      checks.find(c=>c.key==='codex').detail = version.stdout.trim();
    } catch (error) { checks.find(c=>c.key==='codex').status='error'; checks.find(c=>c.key==='codex').detail=safeError(error); return this.getStatus(); }
    const cwd = path.join(this.config.dataDir,'preflight');
    await mkdir(cwd,{recursive:true});
    const rpc = this.rpcFactory(this.rpcOptions(cwd));
    rpc.on('serverRequest', request => { try { rpc.rejectRequest(request.id,'Capability checks cannot grant new permissions.'); } catch {} });
    checks.push({key:'connection',label:'Codex 連線',status:'checking',detail:'正在讀取登入狀態與工具清單'});
    try {
      await rpc.start();
      const account = await rpc.request('account/read',{refreshToken:false});
      if (!account.account) throw new Error('請先在 Codex 完成登入，再按重新檢查。');
      this.status.models=await readModels(rpc);
      const started = await rpc.request('thread/start',{cwd,ephemeral:true,sandbox:'read-only',approvalPolicy:'on-request'});
      const inventory = await rpc.request('mcpServerStatus/list',{threadId:started.thread.id,detail:'toolsAndAuthOnly',limit:100});
      const cua = inventory.data?.find(s => s.name==='cua_repl' && s.tools?.js);
      if (!cua) throw new Error('此 Codex 執行環境未載入 cua_repl。請在 Codex 啟用 Computer Use 後重試。');
      const check = checks.find(c=>c.key==='connection');
      check.status='ok'; check.detail='已登入，Computer Use 工具已載入';
      this.status.ready=true;
    } catch (error) {
      const check = checks.find(c=>c.key==='connection'); check.status='error'; check.detail=safeError(error);
      this.status.ready=false;
    } finally { rpc.close(); }
    this.status.checkedAt=now();
    return this.getStatus();
  }

  async enqueue(body) {
    if (this.shuttingDown) throw new Error('程式正在結束，請稍後重新開啟。');
    const input=cleanRequest(body,this.config);
    if(this.status.models) validateModel(input,this.status.models);
    if ([...this.jobs.values()].filter(j=>ACTIVE.has(j.status)).length>=8) throw new Error('目前已有 8 個待處理研究，請等待或取消後再新增。');
    const id=`${new Date().toISOString().slice(0,10).replaceAll('-','')}-${randomUUID()}`;
    const dir=path.join(this.config.dataDir,'jobs',id);
    await mkdir(path.join(dir,'work/evidence'),{recursive:true,mode:0o700});
    await mkdir(path.join(dir,'report-assets'),{recursive:true});
    const job={id,dir,...input,status:'queued',createdAt:now(),updatedAt:now(),progress:{stage:'queued',label:'等待研究'},events:[],error:null,stats:{sources:0,figures:0},report:{available:false,markdownUrl:`/api/jobs/${id}/report.md`,htmlUrl:`/api/jobs/${id}/report`},pendingRequests:[],runtimeEvidence:{cuaCalls:0,screenshotCalls:0,screenshotsSaved:0},_pending:new Map(),_save:Promise.resolve()};
    const instructions=developerInstructions(this.config,job);
    await writeFile(path.join(dir,'work/workflow.txt'),instructions,{mode:0o600});
    await writeFile(path.join(dir,'work/request.txt'),userPrompt(job),{mode:0o600});
    await writeFile(path.join(dir,'work/fonts.conf'),`<?xml version="1.0"?><fontconfig><dir>/System/Library/Fonts</dir><dir>/Library/Fonts</dir><cachedir>${xml(path.join(dir,'work/fontcache'))}</cachedir></fontconfig>`);
    this.jobs.set(id,job);
    this.event(job,'queued',this.activeJobId?'已排入佇列；PDF Search 一次處理一個研究。':'已建立研究，準備連接 Codex。');
    await this.persist(job);
    void this.drain();
    return this.publicJob(job);
  }

  async drain() {
    if (this.draining || this.shuttingDown) return;
    this.draining=true;
    try {
      if (this.preflightPromise) await this.preflightPromise;
      for (;;) {
        if (this.shuttingDown) break;
        const next=[...this.jobs.values()].filter(j=>j.status==='queued').sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0];
        if (!next) break;
        this.activeJobId=next.id;
        try { await this.run(next); }
        catch (error) {
          if (!['cancelled','interrupted'].includes(next.status)) { next.status='failed'; next.error=safeError(error); next.progress={stage:'failed',label:'研究未完成'}; this.event(next,'error',next.error); }
        } finally { this.activeJobId=null; await this.persist(next); }
      }
    } finally { this.draining=false; }
  }

  async run(job) {
    job._runEnded=false;
    job._transportFailed=false;
    job.status='preparing'; job.progress={stage:'preparing',label:'連接 Codex 與 PDF Search 工具'};
    this.event(job,'progress','正在載入本次研究的工具與輸出要求。');
    const rpc=this.rpcFactory(this.rpcOptions(job.dir)); job._rpc=rpc;
    let settle;
    const finished=new Promise(resolve=>{settle=resolve;});
    job._settle=settle;
    job._notificationChain=Promise.resolve();
    rpc.on('notification',message=>{
      job._notificationChain=job._notificationChain.then(()=>this.handleNotification(job,message)).catch(error=>this.event(job,'diagnostic',safeError(error)));
    });
    rpc.on('serverRequest',request=>{void this.handleServerRequest(job,request).catch(error=>{try{rpc.rejectRequest(request.id,safeError(error));}catch{} this.event(job,'error',safeError(error));});});
    rpc.on('exit',()=>{job._transportFailed=true;settle({status:'transportError'});});
    try {
      await rpc.start();
      if (job._cancelRequested) return;
      const account=await rpc.request('account/read',{refreshToken:false});
      if (!account.account) throw new Error('Codex 尚未登入；請先登入再開始研究。');
      validateModel(job,await readModels(rpc));
      const started=await rpc.request('thread/start',{
        model:job.model, ...(job.reasoningEffort ? {config:{model_reasoning_effort:job.reasoningEffort}} : {}),
        cwd:job.dir,ephemeral:true,sandbox:'workspace-write',approvalPolicy:'on-request',approvalsReviewer:'auto_review',
        developerInstructions:developerInstructions(this.config,job),dynamicTools:DYNAMIC_TOOLS,
      });
      job.threadId=started.thread.id;
      job.actualModel=started.model; job.actualReasoningEffort=started.reasoningEffort ?? null;
      if(started.model!==job.model) throw new Error(`要求 ${job.model}，但 Codex 回傳 ${started.model || '未知模型'}；已停止，沒有偷偷替換。`);
      if(job.reasoningEffort && started.reasoningEffort!==job.reasoningEffort) throw new Error('Codex 回傳的思考深度與選擇不同，已停止研究。');
      this.event(job,'model',`本次使用 ${job.actualModel}／${job.actualReasoningEffort || '模型預設'}。`);
      if (job._cancelRequested) return;
      const inventory=await rpc.request('mcpServerStatus/list',{threadId:job.threadId,detail:'toolsAndAuthOnly',limit:100});
      if (!inventory.data?.some(s=>s.name==='cua_repl' && s.tools?.js)) throw new Error('Computer Use 工具未載入，沒有開始研究。');
      if (job._cancelRequested) return;
      job.status='running'; job.progress={stage:'searching',label:'Codex 開始搜尋 PDF'};
      this.event(job,'progress','Codex 已接收研究主題，開始透過 PDF Search 蒐集。');
      const startedTurn=await rpc.request('turn/start',{
        threadId:job.threadId,
        model:job.model, effort:job.actualReasoningEffort,
        input:[{type:'text',text:userPrompt(job)},{type:'skill',name:'pdf-search-topic',path:this.config.skillPath}],
        sandboxPolicy:{type:'workspaceWrite',writableRoots:[job.dir],networkAccess:false},
      });
      job.turnId=startedTurn.turn.id;
      await this.persist(job);
      if (job._cancelRequested) { await this.cancel(job.id); return; }
      job._deadline=setTimeout(()=>{void this.cancel(job.id,{reason:`已達 ${this.config.maxJobMinutes} 分鐘的研究時間上限，已停止並保留資料。`});},this.config.maxJobMinutes*60000);
      const turn=await finished;
      await job._notificationChain;
      if (job._cancelRequested || this.shuttingDown) return;
      if (turn.status!=='completed') throw new Error(turn.error?.message || (turn.status==='transportError'?'Codex 連線中斷；已保留當時資料。':`Codex 任務結束狀態：${turn.status}`));
      if (!job.validation?.valid && existsSync(path.join(job.dir,'report.json'))) await this.publish(job,path.join(job.dir,'report.json'));
      if (!job.validation?.valid || !job.report.available) throw new Error(job.validation?.errors?.join('\n') || job.finalMessage || 'Codex 已結束，但沒有產生通過驗證的研究報告。');
      job.status=job._report.completeness==='partial'?'partial':'completed';
      job.progress={stage:job.status,label:job.status==='partial'?'已整理現有資料，仍有缺口':'研究完成'};
      this.event(job,'complete',`報告已儲存並驗證：${job.stats.sources} 份來源、${job.stats.figures} 張原圖。${job.status==='partial'?'請查看報告中的限制。':''}`);
    } finally {
      job._runEnded=true;
      clearTimeout(job._deadline);
      clearTimeout(job._toolDeadline);
      rpc.close(); job._rpc=null; job._settle=null;
      job.pendingRequests=[]; job._pending.clear();
      await this.persist(job);
    }
  }

  watchCua(job) {
    clearTimeout(job._toolDeadline);
    if(!job._activeCuaId || job.pendingRequests?.length)return;
    job._toolDeadline=setTimeout(()=>{
      if(job._runEnded || job._cancelRequested || job._transportFailed || job.pendingRequests?.length)return;
      job._transportFailed=true;
      const message='PDF Search 操作超過 3 分鐘沒有回應；已停止本次研究並保留資料，請確認 PDF Search 可操作後再重試。';
      this.event(job,'error',message);job._settle?.({status:'failed',error:{message}});
    },180000);
    job._toolDeadline.unref();
  }

  async handleNotification(job,{method,params:p={}}) {
    if (p.threadId && job.threadId && p.threadId!==job.threadId) return;
    if(method==='thread/tokenUsage/updated'){job.tokenUsage=p.tokenUsage;await this.persist(job);return;}
    if(method==='model/rerouted'){job._transportFailed=true;job._settle?.({status:'failed',error:{message:'Codex 在執行中切換模型；已停止，這次結果不視為所選模型的成果。'}});return;}
    if (method==='turn/started') { job.turnId=p.turn?.id || job.turnId; }
    if (method==='turn/completed') { job._settle?.(p.turn || {status:'unknown'}); return; }
    if (method==='error') { this.event(job,'error',p.error?.message || p.message || 'Codex 回報執行錯誤。'); return; }
    if(method==='item/started' && p.item?.type==='mcpToolCall' && p.item.server==='cua_repl') {
      job._activeCuaId=p.item.id;this.watchCua(job);return;
    }
    if (method!=='item/completed') return;
    const item=p.item || {};
    if (item.type==='agentMessage' && item.text) {
      if (item.phase==='commentary') this.event(job,'commentary',item.text);
      else job.finalMessage=item.text.slice(0,8000);
    }
    if (item.type==='mcpToolCall' && item.server==='cua_repl') {
      if(job._activeCuaId===item.id){clearTimeout(job._toolDeadline);job._activeCuaId=null;}
      const args=typeof item.arguments==='string'?JSON.parse(item.arguments):item.arguments || {};
      const content=item.result?.content || [];
      const successful=item.status==='completed' && !item.error && !content.some(c=>c.type==='text' && /^Computer Use server error|^Error:/i.test(c.text || ''));
      const imageBlocks=content.filter(c=>c.type==='image' && typeof c.data==='string');
      if (successful) {
        job.runtimeEvidence.cuaCalls++;
        const screenshot=/\.get(?:Screenshot|AXStateAndScreenshot)\s*\(/.test(args.code || '');
        const hashes=new Set(job.runtimeEvidence.screenshotHashes || []);
        for (const [i,block] of imageBlocks.entries()) {
          const bytes=Buffer.from(block.data,'base64');
          if (bytes.length>10 && bytes.length<30*1024*1024) {
            const hash=createHash('sha256').update(bytes).digest('hex');
            if(screenshot && !hashes.has(hash)){hashes.add(hash);job.runtimeEvidence.screenshotCalls++;}
            const ext=block.mimeType==='image/jpeg'?'jpg':'png';
            await writeFile(path.join(job.dir,'work/evidence',`${String(item.id).replace(/[^a-zA-Z0-9-]/g,'_')}-${i}.${ext}`),bytes);
            job.runtimeEvidence.screenshotsSaved++;
          }
        }
        job.runtimeEvidence.screenshotHashes=[...hashes];
      }
      const errorDetail=successful ? null : content.filter(c=>c.type==='text').map(c=>c.text || '').join('\n').slice(0,6000);
      await appendFile(path.join(job.dir,'work/cua-trace.jsonl'),JSON.stringify({at:now(),id:item.id,tool:item.tool,code:args.code,status:item.status,error:item.error || null,errorDetail,images:imageBlocks.length,successful})+'\n',{mode:0o600});
      if(successful && /\.(?:getApp|getAXState|getScreenshot|getAXStateAndScreenshot|click|setValue|pressKey|scroll|performSecondaryAction)\s*\(/.test(args.code || ''))job._cuaFailures=0;
      if(!successful && !job._cancelRequested && !job._runEnded){
        job._cuaFailures=(job._cuaFailures || 0)+1;
        this.event(job,'diagnostic',`PDF Search 操作未成功（連續 ${job._cuaFailures} 次），已保留錯誤供檢查。`);
        if(job._cuaFailures>=3){
          job._transportFailed=true;
          const message='PDF Search 連續三次操作失敗；已停止研究並保留資料。請確認 App 回應正常後重試。';
          job._settle?.({status:'failed',error:{message}});
        }
      }
      await this.persist(job);
    }
  }

  async handleServerRequest(job,request) {
    const rpc=job._rpc, p=request.params || {};
    if (!rpc || rpc.closed || job._cancelRequested || job._runEnded || job._transportFailed) return;
    if (request.method==='item/tool/call') {
      let args=p.arguments;
      if (typeof args==='string') args=JSON.parse(args);
      try {
        let output;
        if (p.tool==='research_progress') {
          const labels={searching:'搜尋相關 PDF',reading:'閱讀與核對來源',writing:'整理原圖與研究報告',validating:'驗證來源與圖片'};
          if (!labels[args.stage] || typeof args.message!=='string') throw new Error('Invalid progress fields.');
          job.progress={stage:args.stage,label:labels[args.stage]};
          this.event(job,'progress',args.message);
          output={saved:true};
        } else if (p.tool==='research_publish') {
          output=await this.publish(job,args.reportPath);
        } else throw new Error('Unknown research tool.');
        rpc.respond(request.id,{success:output.valid!==false,contentItems:[{type:'inputText',text:JSON.stringify(output)}]});
      } catch(error) { rpc.respond(request.id,{success:false,contentItems:[{type:'inputText',text:safeError(error)}]}); }
      return;
    }
    if (request.method==='item/tool/requestUserInput' || request.method==='tool/requestUserInput') {
      const group={request,answers:{},remaining:new Set((p.questions||[]).map(q=>q.id))};
      if (!group.remaining.size) { rpc.respond(request.id,{answers:{}}); return; }
      for (const q of p.questions) {
        const id=`${request.id}:${q.id}`;
        job._pending.set(id,{kind:'question',group,questionId:q.id});
        job.pendingRequests.push({id,kind:'question',title:q.question,description:q.header || '',choices:(q.options||[]).map(o=>({label:o.label,value:o.label}))});
      }
    } else if (/requestApproval$/.test(request.method) || request.method==='mcpServer/elicitation/request') {
      const pdfSearchConsent=isPdfSearchConsent(job,request);
      if(pdfSearchConsent && job._pdfSearchConsent){rpc.respond(request.id,{action:'accept',content:{}});return;}
      const id=String(request.id);
      job._pending.set(id,{kind:'approval',request,pdfSearchConsent});
      job.pendingRequests.push({id,kind:'approval',title:pdfSearchConsent?'允許本次研究使用 PDF Search':p.reason || p.message || 'Codex 需要操作授權',description:pdfSearchConsent?'允許 Codex 在本次研究中搜尋、翻閱並截圖核對 PDF Search。相同操作會沿用此許可，任務結束即失效；不授權其他 App 或修改原始 PDF。':[p.command,p.cwd?`工作目錄：${p.cwd}`:'',p.permissions?JSON.stringify(p.permissions):'',p.requestedSchema&&Object.keys(p.requestedSchema.properties||{}).length?JSON.stringify(p.requestedSchema):''].filter(Boolean).join('\n').slice(0,6000)});
    } else {
      rpc.rejectRequest(request.id,'PDF Research does not implement this request.');
      this.event(job,'diagnostic',`尚未支援的 Codex 請求：${request.method}`);
      return;
    }
    job.status='needs_input';
    clearTimeout(job._toolDeadline);
    this.event(job,'needs_input','研究正在等待你的回覆或操作授權。');
  }

  async respond(id,body) {
    const job=this.get(id), pending=job._pending.get(String(body.requestId));
    if (!pending || !job._rpc || job._rpc.closed || job._cancelRequested || job._runEnded || job._transportFailed) throw Object.assign(new Error('這個問題已失效，請重新整理狀態。'),{statusCode:409});
    if (!['accept','decline'].includes(body.decision)) throw new Error('請選擇允許或拒絕。');
    if (pending.kind==='question') {
      const answer=typeof body.answer==='string'?body.answer.trim():'';
      if (body.decision==='accept' && (!answer || answer.length>5000)) throw new Error('請填入回覆（最多 5,000 個字元）。');
      pending.group.answers[pending.questionId]={answers:body.decision==='accept'?[answer]:[]};
      pending.group.remaining.delete(pending.questionId);
      if (!pending.group.remaining.size) job._rpc.respond(pending.group.request.id,{answers:pending.group.answers});
    } else {
      const {request}=pending, p=request.params || {};
      if (request.method==='mcpServer/elicitation/request') {
        let content=null;
        if (body.decision==='accept' && p.requestedSchema) {
          if (body.answer) { try { content=JSON.parse(body.answer); } catch { throw new Error('這項表單需要有效 JSON 回覆。'); } }
          else if (!(p.requestedSchema.required||[]).length) content={};
          else throw new Error('這項表單需要補充資料；請先提供回覆，或拒絕此次操作。');
        }
        job._rpc.respond(request.id,{action:body.decision==='accept'?'accept':'decline',content});
        if(pending.pdfSearchConsent && body.decision==='accept')job._pdfSearchConsent=true;
      } else if (request.method==='item/permissions/requestApproval') {
        job._rpc.respond(request.id,{permissions:body.decision==='accept'?(p.permissions || {}):{},scope:'turn'});
      } else job._rpc.respond(request.id,{decision:body.decision});
    }
    job._pending.delete(String(body.requestId));
    job.pendingRequests=job.pendingRequests.filter(r=>r.id!==String(body.requestId));
    if (!job.pendingRequests.length) {job.status='running';this.watchCua(job);}
    this.event(job,'response',body.decision==='accept'?'已送出回覆，Codex 繼續研究。':'已拒絕此次操作，Codex 將依回覆處理。');
    await this.persist(job);
    return this.publicJob(job);
  }

  async verifyArtifacts(report) {
    const input=JSON.stringify({sources:report.sources,figures:report.figures,pdfinfo:path.join(this.config.pdfToolDir,'pdfinfo')});
    return new Promise((resolve,reject)=>{
      const child=spawn(this.config.pythonPath,[path.join(this.config.appRoot,'lib/artifact-check.py')],{stdio:['pipe','pipe','pipe']});
      let stdout='',stderr='';
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('PDF／圖片驗證逾時。'));},90000);
      child.stdout.on('data',chunk=>{stdout+=chunk;}); child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2000);});
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('close',code=>{clearTimeout(timer);if(code!==0){reject(new Error(`圖文驗證失敗：${stderr}`));return;}try{resolve(JSON.parse(stdout));}catch{reject(new Error('圖文驗證沒有回傳有效資料。'));}});
      child.stdin.end(input);
    });
  }

  async publish(job,reportPath) {
    const cancelled=()=>{if(job._cancelRequested||this.shuttingDown||job._runEnded||job._transportFailed)throw new Error('研究已停止或連線中斷，沒有將此結果標示為完成。');};
    await job._notificationChain;
    cancelled();
    const file=path.resolve(reportPath || '');
    if (file!==path.join(job.dir,'report.json')) throw new Error('reportPath 必須是本次工作目錄的 report.json。');
    if ((await stat(file)).size>2*1024*1024) throw new Error('Report JSON exceeds 2 MB.');
    cancelled();
    job.status='validating'; job.progress={stage:'validating',label:'核對引用、原圖與檔案'};
    this.event(job,'progress','正在驗證原始 PDF、引用頁碼、圖片檔案與閱讀證據。');
    let report;
    try { report=JSON.parse(await readFile(file,'utf8')); }
    catch { throw new Error('report.json 不是有效 JSON。'); }
    const result=await validateReport(report,{jobDir:job.dir,allowedSourceRoots:this.config.sourceRoots,sourceTarget:job.sourceCount,figureTarget:job.figureTarget,requireEvidence:true});
    const usedPages=new Set((result.report?.evidence || []).map(e=>`${e.sourceId}:${e.page}`));
    if (job.runtimeEvidence.cuaCalls===0) result.errors.push('沒有觀察到成功的 cua_repl 操作，不能聲稱已在 PDF Search 蒐集。');
    if (job.runtimeEvidence.screenshotCalls<usedPages.size) result.errors.push(`App 實際記錄到 ${job.runtimeEvidence.screenshotCalls} 次截圖核對，少於 evidence 的 ${usedPages.size} 個頁面；請完成缺少的可見頁面核對。`);
    if (result.valid && !result.errors.length) {
      const decoded=await this.artifactVerifier(result.report);
      result.errors.push(...decoded.errors);
    }
    result.valid=result.errors.length===0;
    cancelled();
    job.validation={valid:false,errors:result.errors,warnings:result.warnings,checkedAt:now()};
    if (!result.valid) {
      job.status='running';
      this.event(job,'validation',`驗證未通過：${result.errors.join('；')}`);
      return {valid:false,errors:result.errors,warnings:result.warnings};
    }
    job._report=result.report; job.stats=result.stats;
    await atomicJson(path.join(job.dir,'report.normalized.json'),result.report);
    const expectedMd=renderMarkdown(result.report),expectedHtml=renderHtml(result.report,{jobId:job.id});
    await writeFile(path.join(job.dir,'report.md'),expectedMd,{mode:0o600});
    await writeFile(path.join(job.dir,'report.html'),expectedHtml,{mode:0o600});
    // Read-back of rendered deliverables is part of completion, not just write success.
    const [md,html]=await Promise.all([readFile(path.join(job.dir,'report.md'),'utf8'),readFile(path.join(job.dir,'report.html'),'utf8')]);
    if (md!==expectedMd || html!==expectedHtml) throw new Error('報告讀回驗證失敗。');
    cancelled();
    job.validation.valid=true;
    job.report.available=true;
    job.status='running';
    this.event(job,'saved',`已驗證並儲存 ${result.stats.sources} 份來源、${result.stats.figures} 張圖。`);
    await this.persist(job);
    return {valid:true,completeness:result.report.completeness,stats:result.stats,warnings:result.warnings,markdownPath:path.join(job.dir,'report.md')};
  }

  async cancel(id,{reason,shutdown=false}={}) {
    const job=this.get(id);
    if (!ACTIVE.has(job.status) && !job._cancelRequested) return this.publicJob(job);
    job._cancelRequested=true;
    clearTimeout(job._toolDeadline);
    job._pending.clear();job._pdfSearchConsent=false;
    job.status=shutdown?'interrupted':'cancelled';
    job.error=reason || null;
    job.progress={stage:job.status,label:shutdown?'研究已中斷':'已停止研究'};
    job.pendingRequests=[];
    this.event(job,'cancelled',reason || '已要求停止研究，保留目前收集的資料。');
    if (job._rpc && job.threadId && job.turnId) {
      try { await job._rpc.request('turn/interrupt',{threadId:job.threadId,turnId:job.turnId},5000); } catch {}
    }
    job._settle?.({status:'interrupted'});
    job._rpc?.close();
    await this.persist(job);
    return this.publicJob(job);
  }

  async shutdown() {
    this.shuttingDown=true;
    for (const job of this.jobs.values()) if (ACTIVE.has(job.status)) await this.cancel(job.id,{shutdown:true,reason:'程式已結束；研究尚未完成，已保留資料。'});
    await Promise.all([...this.jobs.values()].map(j=>j._save));
  }
}
