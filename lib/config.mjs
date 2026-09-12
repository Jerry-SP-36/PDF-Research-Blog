import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const firstExisting = (items) => items.find(p => p && existsSync(p)) || items[0];

export function loadConfig({ appRoot = APP_ROOT, dataDir } = {}) {
  const userHome = homedir();
  const codexHome = path.join(userHome, '.codex');
  const dependencyRoot = path.join(userHome, '.cache/codex-runtimes/codex-primary-runtime/dependencies');
  const defaults = {
    version: '0.6.2',
    defaultModel: 'gpt-5.6-luna',
    defaultReasoningEffort: 'high',
    codexPath: firstExisting(['/Applications/ChatGPT.app/Contents/Resources/codex', '/Applications/Codex.app/Contents/Resources/codex', path.join(userHome, '.local/bin/codex')]),
    skillPath: path.join(codexHome, 'skills/pdf-search-topic/SKILL.md'),
    pdfAppPath: firstExisting(['/Applications/Setapp/PDF Search.app', '/Applications/PDF Search.app']),
    sourceRoots: [path.join(userHome, 'Library/CloudStorage/OneDrive-個人/Reference')],
    dataDir: path.join(path.dirname(appRoot), 'pdf-research-data'),
    pythonPath: path.join(dependencyRoot, 'python/bin/python3'),
    pdfToolDir: path.join(dependencyRoot, 'bin/override'),
    maxJobMinutes: 45,
    port: 0,
  };
  const configPath = path.join(appRoot, 'config.local.json');
  let local = {};
  if (existsSync(configPath)) local = JSON.parse(readFileSync(configPath, 'utf8'));
  const config = { ...defaults, ...local };
  if (dataDir || process.env.PDF_RESEARCH_DATA_DIR) config.dataDir = path.resolve(dataDir || process.env.PDF_RESEARCH_DATA_DIR);
  if (process.env.PDF_RESEARCH_PORT) config.port = Number(process.env.PDF_RESEARCH_PORT);
  if (process.env.PDF_RESEARCH_CODEX_PATH) config.codexPath = path.resolve(process.env.PDF_RESEARCH_CODEX_PATH);
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('Invalid port.');
  if (!Array.isArray(config.sourceRoots) || !config.sourceRoots.length || config.sourceRoots.some(p => !path.isAbsolute(p))) throw new Error('sourceRoots must contain absolute local directories.');
  if (!Number.isFinite(config.maxJobMinutes) || config.maxJobMinutes < 1 || config.maxJobMinutes > 180) throw new Error('maxJobMinutes must be 1–180.');
  config.dataDir = path.resolve(config.dataDir);
  config.appRoot = appRoot;
  config.codexHome = codexHome;
  // These are invocation-only overrides; the user's config.toml is never edited.
  config.codexArgs = ['-c', 'web_search="disabled"', '-c', 'apps._default.enabled=false', '-c', 'mcp_servers.node_repl.enabled=false', '-c', 'mcp_servers.openaiDeveloperDocs.enabled=false'];
  try {
    const text = readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    const allowed = new Set(['unified-computer-use@openai-bundled', 'pdf@openai-primary-runtime']);
    for (const match of text.matchAll(/^\[plugins\."([^"\n]+)"\]\s*$/gm)) {
      if (!allowed.has(match[1])) config.codexArgs.push('-c', `plugins.${JSON.stringify(match[1])}.enabled=false`);
    }
  } catch { /* Codex itself will explain an unreadable configuration. */ }
  return config;
}

export function workerEnvironment(config, jobDir) {
  return {
    ...process.env,
    PATH: [config.pdfToolDir, path.dirname(config.pythonPath), '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin', process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].join(':'),
    FONTCONFIG_FILE: path.join(jobDir, 'work/fonts.conf'),
  };
}
