const express = require('express');
const multer = require('multer');
const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 4173;
const DEFAULT_RESOURCES_ROOT = '/mnt/c/Users/Jan Křístek/WebstormProjects/wcgames7/resources-games';
const CONFIG_FILE = path.join(__dirname, 'config.local.json');
const AUDIO_EXTENSIONS = new Set(['.ogg', '.mp3', '.wav', '.flac', '.aac', '.m4a']);

const uploadDir = path.join(__dirname, 'uploads');
if (!fssync.existsSync(uploadDir)) {
  fssync.mkdirSync(uploadDir, { recursive: true });
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

app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const state = {
  resourcesRoot: DEFAULT_RESOURCES_ROOT,
  wcgamesRoot: path.resolve(DEFAULT_RESOURCES_ROOT, '..'),
  propertiesPath: path.resolve(DEFAULT_RESOURCES_ROOT, '..', 'properties.build.json'),
  startScriptPath: path.resolve(DEFAULT_RESOURCES_ROOT, '..', 'start.js')
};

async function loadConfigFromDisk() {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf8');
    const saved = JSON.parse(raw);
    if (saved.resourcesRoot) {
      await updateRoots(saved.resourcesRoot, false);
    }
  } catch {
    // ignore missing/invalid config
  }
}

function saveConfigToDisk() {
  const payload = { resourcesRoot: state.resourcesRoot };
  return fs.writeFile(CONFIG_FILE, JSON.stringify(payload, null, 2));
}

async function updateRoots(resourcesRoot, persist = true) {
  const stats = await fs.stat(resourcesRoot);
  if (!stats.isDirectory()) {
    throw new Error('resourcesRoot is not a directory');
  }
  state.resourcesRoot = path.resolve(resourcesRoot);
  state.wcgamesRoot = path.resolve(state.resourcesRoot, '..');
  state.propertiesPath = path.join(state.wcgamesRoot, 'properties.build.json');
  state.startScriptPath = path.join(state.wcgamesRoot, 'start.js');
  if (persist) {
    await saveConfigToDisk();
  }
}

async function listGames() {
  const dirents = await fs.readdir(state.resourcesRoot, { withFileTypes: true });
  return dirents.filter(d => d.isDirectory()).map(d => d.name);
}

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
        sounds.push({
          id: relPath,
          name: entry.name,
          relPath,
          size
        });
      }
    }
  }
  return sounds.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

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

async function writeProperties(gameName) {
  let data = {};
  try {
    const raw = await fs.readFile(state.propertiesPath, 'utf8');
    data = JSON.parse(raw);
  } catch {
    // file missing or invalid, recreate
    data = {};
  }
  data.gameBuildList = gameName;
  await fs.writeFile(state.propertiesPath, JSON.stringify(data, null, 2));
}

function startStartJs() {
  if (!fssync.existsSync(state.startScriptPath)) {
    return { started: false, reason: 'start.js not found' };
  }
  if (runningStartProcess && !runningStartProcess.killed) {
    return { started: false, reason: 'start.js already running', pid: runningStartProcess.pid };
  }
  const proc = spawn('node', ['start.js'], {
    cwd: state.wcgamesRoot,
    stdio: 'inherit',
    detached: false
  });
  runningStartProcess = proc;
  proc.on('exit', () => {
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
  if (!resourcesRoot) {
    return res.status(400).json({ error: 'resourcesRoot is required' });
  }
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

app.post('/api/uploads', upload.array('files'), (req, res) => {
  if (!req.files || !req.files.length) {
    return res.status(400).json({ error: 'No files uploaded' });
  }
  const records = rememberUploads(req.files);
  res.json({ uploaded: records });
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
    const replaced = [];

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
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.copyFile(uploadRecord.storedPath, destPath);
      replaced.push({ target, source: uploadRecord.originalName });
    }

    await writeProperties(game);
    let startInfo = null;
    if (runStart) {
      startInfo = startStartJs();
    }

    res.json({ ok: true, replaced, startInfo });
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
  });
});
