const express = require('express');
const multer = require('multer');
const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 4173;
const DEFAULT_RESOURCES_ROOT = '/mnt/c/Users/Jan Křístek/WebstormProjects/wcgames7/resources-games';
const CONFIG_FILE = path.join(__dirname, 'config.local.json');
const BACKUP_ROOT = path.join(__dirname, 'backups');
const AUDIO_EXTENSIONS = new Set(['.ogg', '.mp3', '.wav', '.flac', '.aac', '.m4a']);
const LOG_LIMIT = 500;

const uploadDir = path.join(__dirname, 'uploads');
if (!fssync.existsSync(uploadDir)) {
  fssync.mkdirSync(uploadDir, { recursive: true });
}
if (!fssync.existsSync(BACKUP_ROOT)) {
  fssync.mkdirSync(BACKUP_ROOT, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^\w.\-]/g, '_');
    cb(null, `${Date.now()}-${safeName}`);
  }
});

const upload = multer({ storage });

const uploadedFiles = new Map();
let runningStartProcess = null;
const logBuffer = [];
const logClients = new Set();

app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const state = {
  resourcesRoot: DEFAULT_RESOURCES_ROOT,
  wcgamesRoot: path.resolve(DEFAULT_RESOURCES_ROOT, '..'),
  propertiesPath: path.resolve(DEFAULT_RESOURCES_ROOT, '..', 'properties.build.json'),
  startScriptPath: path.resolve(DEFAULT_RESOURCES_ROOT, '..', 'start.js')
};

/**
 * Boot persisted config if present.
 */
async function loadConfigFromDisk() {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf8');
    const saved = JSON.parse(raw);
    if (saved.resourcesRoot) {
      await updateRoots(saved.resourcesRoot, false);
    }
  } catch {
    // ignore
  }
}

/**
 * Persist current resourcesRoot to disk.
 * @returns {Promise<void>}
 */
function saveConfigToDisk() {
  const payload = { resourcesRoot: state.resourcesRoot };
  return fs.writeFile(CONFIG_FILE, JSON.stringify(payload, null, 2));
}

/**
 * Push message to log buffer and SSE clients.
 * @param {string} message
 */
function pushLog(message) {
  const entry = `[${new Date().toISOString()}] ${message}`;
  logBuffer.push(entry);
  if (logBuffer.length > LOG_LIMIT) {
    logBuffer.splice(0, logBuffer.length - LOG_LIMIT);
  }
  for (const res of logClients) {
    res.write(`data: ${entry}\n\n`);
  }
  console.log(entry);
}

/**
 * Update resource root paths and derived wcgames paths.
 * @param {string} resourcesRoot
 * @param {boolean} [persist=true]
 */
async function updateRoots(resourcesRoot, persist = true) {
  const stats = await fs.stat(resourcesRoot);
  if (!stats.isDirectory()) throw new Error('resourcesRoot is not a directory');
  state.resourcesRoot = path.resolve(resourcesRoot);
  state.wcgamesRoot = path.resolve(state.resourcesRoot, '..');
  state.propertiesPath = path.join(state.wcgamesRoot, 'properties.build.json');
  state.startScriptPath = path.join(state.wcgamesRoot, 'start.js');
  if (persist) await saveConfigToDisk();
}

/**
 * List game folder names in resources root.
 * @returns {Promise<string[]>}
 */
async function listGames() {
  const dirents = await fs.readdir(state.resourcesRoot, { withFileTypes: true });
  return dirents.filter(d => d.isDirectory()).map(d => d.name);
}

/**
 * List audio files inside a game.
 * @param {string} gameName
 * @returns {Promise<Array<{id:string,name:string,relPath:string,size:number}>>}
 */
async function listSounds(gameName) {
  const gameDir = path.join(state.resourcesRoot, gameName);
  const resolvedGameDir = path.resolve(gameDir);
  if (!resolvedGameDir.startsWith(path.resolve(state.resourcesRoot))) {
    throw new Error('Invalid game name');
  }
  const sounds = [];
  const queue = [''];
  while (queue.length) {
    const relative = queue.pop();
    const absolute = path.join(resolvedGameDir, relative);
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = path.join(relative, entry.name);
      const fullPath = path.join(resolvedGameDir, relPath);
      if (entry.isDirectory()) {
        queue.push(relPath);
      } else if (AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const { size } = await fs.stat(fullPath);
        sounds.push({ id: relPath, name: entry.name, relPath, size });
      }
    }
  }
  return sounds.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/**
 * Ensure game folder exists and return absolute path.
 * @param {string} gameName
 * @returns {Promise<string>}
 */
async function ensureGameExists(gameName) {
  const gameDir = path.join(state.resourcesRoot, gameName);
  const resolvedGameDir = path.resolve(gameDir);
  if (!resolvedGameDir.startsWith(path.resolve(state.resourcesRoot))) {
    throw new Error('Invalid game name');
  }
  const stat = await fs.stat(resolvedGameDir);
  if (!stat.isDirectory()) {
    throw new Error('Game folder missing');
  }
  return resolvedGameDir;
}

/**
 * Remember uploaded files in memory map.
 * @param {Array<{path:string, originalname:string, size:number}>} files
 * @returns {Array<{id:string,originalName:string,size:number,uploadedAt:number}>}
 */
function rememberUploads(files) {
  const result = [];
  for (const file of files) {
    const id = crypto.randomUUID();
    const record = {
      id,
      storedPath: file.path,
      originalName: file.originalname,
      size: file.size,
      uploadedAt: Date.now()
    };
    uploadedFiles.set(id, record);
    result.push({
      id: record.id,
      originalName: record.originalName,
      size: record.size,
      uploadedAt: record.uploadedAt
    });
  }
  return result;
}

/**
 * Compute md5 hash of a file.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function hashFile(filePath) {
  const data = await fs.readFile(filePath);
  const hash = crypto.createHash('md5').update(data).digest('hex');
  return hash;
}

/**
 * Backup current game targets before replacement.
 * @param {string} gameName
 * @param {Array<{target:string}>} mappings
 * @param {string} gameDir
 * @returns {Promise<number>} number of files backed up
 */
async function backupFiles(gameName, mappings, gameDir) {
  const uniqueTargets = Array.from(new Set(mappings.map(m => m.target).filter(Boolean)));
  if (!uniqueTargets.length) return 0;
  const gameBackupDir = path.join(BACKUP_ROOT, gameName);
  await fs.mkdir(gameBackupDir, { recursive: true });
  let count = 0;
  for (const target of uniqueTargets) {
    const src = path.resolve(gameDir, target);
    if (!src.startsWith(gameDir)) continue;
    if (!fssync.existsSync(src)) continue;
    const dest = path.join(gameBackupDir, target);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
    count++;
  }
  if (count) pushLog(`Záloha ${count} souborů pro ${gameName}`);
  return count;
}

/**
 * Restore backup files for a game.
 * @param {string} gameName
 * @param {string} gameDir
 * @returns {Promise<number>} number of files restored
 */
async function restoreBackup(gameName, gameDir) {
  const gameBackupDir = path.join(BACKUP_ROOT, gameName);
  const backupRootResolved = path.resolve(gameBackupDir);
  if (!fssync.existsSync(backupRootResolved)) {
    throw new Error('Záloha nenalezena');
  }
  const relFiles = [];
  const queue = [''];
  while (queue.length) {
    const rel = queue.pop();
    const abs = path.join(gameBackupDir, rel);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        queue.push(childRel);
      } else {
        relFiles.push(childRel);
      }
    }
  }
  let restored = 0;
  for (const rel of relFiles) {
    const src = path.join(gameBackupDir, rel);
    const dest = path.resolve(gameDir, rel);
    if (!dest.startsWith(gameDir)) continue;
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
    restored++;
  }
  return restored;
}

/**
 * Run git checkout -- resources-games/<game> to revert to repo state.
 * Streams output to log.
 * @param {string} gameName
 */
function gitRollback(gameName) {
  if (!fssync.existsSync(path.join(state.wcgamesRoot, '.git'))) {
    throw new Error('Nenalezen .git v kořeni wcgames');
  }
  const target = `resources-games/${gameName}`;
  pushLog(`Git rollback start: ${target}`);
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['checkout', '--', target], {
      cwd: state.wcgamesRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    proc.stdout.on('data', chunk => pushLog(chunk.toString().trimEnd()));
    proc.stderr.on('data', chunk => pushLog(`ERR ${chunk.toString().trimEnd()}`));
    proc.on('close', code => {
      if (code === 0) {
        pushLog(`Git rollback hotov: ${target}`);
        resolve({ ok: true });
      } else {
        const msg = `Git rollback selhal (code ${code})`;
        pushLog(msg);
        reject(new Error(msg));
      }
    });
  });
}

/**
 * Get list of games with git changes under resources-games.
 * @returns {Promise<Array<{name:string, files:number}>>}
 */
async function getChangedGames() {
  const gitDir = path.join(state.wcgamesRoot, '.git');
  if (!fssync.existsSync(gitDir)) return [];
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['status', '--porcelain', '--', 'resources-games'], {
      cwd: state.wcgamesRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let errBuf = '';
    proc.stdout.on('data', chunk => { out += chunk.toString(); });
    proc.stderr.on('data', chunk => { errBuf += chunk.toString(); });
    proc.on('close', code => {
      if (code !== 0) {
        return reject(new Error(errBuf || `git status exited ${code}`));
      }
      const gameMap = new Map();
      out.split('\n').filter(Boolean).forEach(line => {
        const rel = line.slice(3).trim(); // status chars + space
        if (!rel.startsWith('resources-games/')) return;
        const parts = rel.split('/');
        if (parts.length < 2) return;
        const game = parts[1];
        gameMap.set(game, (gameMap.get(game) || 0) + 1);
      });
      resolve(Array.from(gameMap.entries()).map(([name, files]) => ({ name, files })));
    });
  });
}

/**
 * Set gameBuildList to selected game in properties file.
 * @param {string} gameName
 * @returns {Promise<void>}
 */
async function writeProperties(gameName) {
  let data = {};
  try {
    const raw = await fs.readFile(state.propertiesPath, 'utf8');
    data = JSON.parse(raw);
  } catch {
    data = {};
  }
  data.gameBuildList = gameName;
  await fs.writeFile(state.propertiesPath, JSON.stringify(data, null, 2));
}

/**
 * Write build list for multiple games.
 * @param {string|string[]} games
 */
async function writeBuildList(games) {
  const list = Array.isArray(games) ? games.filter(Boolean) : [games].filter(Boolean);
  let data = {};
  try {
    const raw = await fs.readFile(state.propertiesPath, 'utf8');
    data = JSON.parse(raw);
  } catch {
    data = {};
  }
  data.gameBuildList = list.join(',');
  await fs.writeFile(state.propertiesPath, JSON.stringify(data, null, 2));
}

/**
 * Stop running start.js process.
 * @param {string} [reason]
 * @returns {Promise<{stopped:boolean, reason?:string, code?:number, signal?:string}>}
 */
function stopStartJs(reason = 'stop') {
  if (!runningStartProcess || runningStartProcess.killed) {
    return Promise.resolve({ stopped: false, reason: 'not running' });
  }
  pushLog(`Killing start.js (PID ${runningStartProcess.pid}) – ${reason}`);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      if (runningStartProcess && !runningStartProcess.killed) {
        runningStartProcess.kill('SIGKILL');
      }
    }, 3000);
    runningStartProcess.once('exit', (code, signal) => {
      clearTimeout(timer);
      pushLog(`start.js ukončen (code ${code}, signal ${signal || 'none'})`);
      resolve({ stopped: true, code, signal });
    });
    runningStartProcess.kill('SIGTERM');
  });
}

/**
 * Start start.js process, wiring logs to SSE.
 * @returns {{started:boolean, pid?:number, reason?:string}}
 */
function startStartJs() {
  if (!fssync.existsSync(state.startScriptPath)) {
    const reason = 'start.js not found';
    pushLog(reason);
    return { started: false, reason };
  }
  const proc = spawn('node', ['start.js'], {
    cwd: state.wcgamesRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  });
  runningStartProcess = proc;
  pushLog(`Spouštím start.js (PID ${proc.pid})`);

  proc.stdout.on('data', chunk => pushLog(chunk.toString().trimEnd()));
  proc.stderr.on('data', chunk => pushLog(`ERR ${chunk.toString().trimEnd()}`));
  proc.on('exit', (code, signal) => {
    pushLog(`start.js skončil (code ${code}, signal ${signal || 'none'})`);
    runningStartProcess = null;
  });
  return { started: true, pid: proc.pid };
}

app.get('/api/config', async (_req, res) => {
  res.json({
    resourcesRoot: state.resourcesRoot,
    wcgamesRoot: state.wcgamesRoot,
    propertiesPath: state.propertiesPath,
    startScriptPath: state.startScriptPath
  });
});

app.post('/api/config/path', async (req, res) => {
  const { resourcesRoot } = req.body || {};
  if (!resourcesRoot) return res.status(400).json({ error: 'resourcesRoot is required' });
  try {
    await updateRoots(resourcesRoot, true);
    res.json({
      ok: true,
      resourcesRoot: state.resourcesRoot,
      wcgamesRoot: state.wcgamesRoot,
      propertiesPath: state.propertiesPath,
      startScriptPath: state.startScriptPath
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/logs', (_req, res) => {
  res.json({ logs: logBuffer });
});

app.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  logClients.add(res);
  for (const entry of logBuffer) {
    res.write(`data: ${entry}\n\n`);
  }
  req.on('close', () => {
    logClients.delete(res);
  });
});

app.get('/api/games', async (_req, res) => {
  try {
    const games = await listGames();
    res.json({ games });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/games/:game/sounds', async (req, res) => {
  try {
    const { game } = req.params;
    await ensureGameExists(game);
    const sounds = await listSounds(game);
    res.json({ sounds });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/changes', async (_req, res) => {
  try {
    const games = await getChangedGames();
    res.json({ games });
  } catch (err) {
    res.status(400).json({ error: err.message, games: [] });
  }
});

app.get('/api/games/:game/audio', async (req, res) => {
  try {
    const { game } = req.params;
    const { file } = req.query;
    if (!file) return res.status(400).json({ error: 'file is required' });
    const gameDir = await ensureGameExists(game);
    const target = path.resolve(gameDir, file);
    if (!target.startsWith(gameDir)) return res.status(400).json({ error: 'Invalid file path' });
    if (!fssync.existsSync(target)) return res.status(404).json({ error: 'File not found' });
    res.sendFile(target);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/games/:game/zip', async (req, res) => {
  try {
    const { game } = req.params;
    const gameDir = await ensureGameExists(game);
    const sounds = await listSounds(game);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="sfx-${game}.zip"`);

    const archive = archiver('zip', { zlib: { level: 0 } });
    archive.on('error', err => {
      pushLog(`ZIP error: ${err.message}`);
      res.status(500).end();
    });
    archive.on('warning', err => {
      if (err.code === 'ENOENT') pushLog(`ZIP warning: ${err.message}`);
      else pushLog(`ZIP error: ${err.message}`);
    });

    archive.pipe(res);
    for (const sound of sounds) {
      const fullPath = path.join(gameDir, sound.relPath);
      archive.file(fullPath, { name: sound.relPath.replace(/\\/g, '/') });
    }
    archive.finalize();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/uploads', upload.array('files'), (req, res) => {
  if (!req.files || !req.files.length) {
    return res.status(400).json({ error: 'No files uploaded' });
  }
  const records = rememberUploads(req.files);
  res.json({ uploaded: records });
});

app.get('/api/uploads/:id/audio', async (req, res) => {
  const record = uploadedFiles.get(req.params.id);
  if (!record || !record.storedPath || !fssync.existsSync(record.storedPath)) {
    return res.status(404).json({ error: 'Upload not found' });
  }
  res.sendFile(path.resolve(record.storedPath));
});

app.post('/api/rollback', async (req, res) => {
  const { game } = req.body || {};
  if (!game) {
    return res.status(400).json({ error: 'game is required' });
  }
  try {
    const gameDir = await ensureGameExists(game);
    const restored = await restoreBackup(game, gameDir);
    if (!restored) {
      return res.status(404).json({ error: 'Žádné zálohy k obnovení' });
    }
    pushLog(`Rollback: obnovení ${restored} souborů pro ${game}`);
    res.json({ ok: true, restored });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/git-rollback', async (req, res) => {
  const { game, runStart = true } = req.body || {};
  if (!game) return res.status(400).json({ error: 'game is required' });
  try {
    const gameDir = await ensureGameExists(game);
    pushLog(`Požadavek git rollback pro ${game}`);
    await gitRollback(game);
    await writeBuildList([game]);
    pushLog(`properties.build.json -> gameBuildList=${game}`);

    let startInfo = null;
    if (runStart) {
      await stopStartJs('git-rollback');
      startInfo = startStartJs();
    }
    res.json({ ok: true, startInfo });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/build-run', async (req, res) => {
  const { games, runStart = true } = req.body || {};
  if (!Array.isArray(games) || !games.length) {
    return res.status(400).json({ error: 'games must be a non-empty array' });
  }
  try {
    await Promise.all(games.map(ensureGameExists));
    await writeBuildList(games);
    pushLog(`properties.build.json -> gameBuildList=${games.join(',')}`);
    let startInfo = null;
    if (runStart) {
      await stopStartJs('build-run');
      startInfo = startStartJs();
    }
    res.json({ ok: true, startInfo });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/apply', async (req, res) => {
  const { game, mappings, runStart = true } = req.body || {};
  if (!game) {
    return res.status(400).json({ error: 'game is required' });
  }
  if (!Array.isArray(mappings)) {
    return res.status(400).json({ error: 'mappings must be an array' });
  }
  try {
    const gameDir = await ensureGameExists(game);
    await backupFiles(game, mappings, gameDir);
    const replaced = [];
    const duplicates = [];

    for (const mapping of mappings) {
      const { target, replacementId } = mapping;
      if (!target || !replacementId) continue;
      const uploadRecord = uploadedFiles.get(replacementId);
      if (!uploadRecord) {
        throw new Error(`Replacement ${replacementId} not found (upload missing)`);
      }
      const destPath = path.resolve(gameDir, target);
      if (!destPath.startsWith(gameDir)) {
        throw new Error(`Invalid target path: ${target}`);
      }
      if (fssync.existsSync(destPath)) {
        const [hashSrc, hashDest] = await Promise.all([
          hashFile(uploadRecord.storedPath),
          hashFile(destPath)
        ]);
        if (hashSrc === hashDest) {
          duplicates.push(target);
          continue;
        }
      }
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.copyFile(uploadRecord.storedPath, destPath);
      replaced.push({ target, source: uploadRecord.originalName });
    }

    if (duplicates.length && !replaced.length) {
      throw new Error(`Náhrady selhaly – shodné soubory: ${duplicates.join(', ')}`);
    }
    if (duplicates.length) {
      pushLog(`Přeskočeno (shodné): ${duplicates.join(', ')}`);
    }

    await writeBuildList([game]);
    let startInfo = null;
    if (runStart) {
      await stopStartJs('apply');
      startInfo = startStartJs();
    }
    pushLog(`Výměna zvuků pro ${game}: ${replaced.length} souborů`);

    res.json({ ok: true, replaced, duplicates, startInfo });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/uploads', (_req, res) => {
  const uploads = Array.from(uploadedFiles.values()).map(u => ({
    id: u.id,
    originalName: u.originalName,
    size: u.size,
    uploadedAt: u.uploadedAt
  }));
  res.json({ uploads });
});

loadConfigFromDisk().finally(() => {
  app.listen(PORT, () => {
    console.log(`SFX HotSwap server running on http://localhost:${PORT}`);
    console.log(`Resources: ${state.resourcesRoot}`);
    pushLog('Server nastartován');
  });
});
