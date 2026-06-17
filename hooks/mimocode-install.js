#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");
const { readJsonFile, writeJsonAtomic, writeJsonAtomicWithBackup, asarUnpackedPath } = require("./json-utils");

const PLUGIN_DIR_NAME = "mimocode-plugin";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".config", "mimocode");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "mimocode.jsonc");

function resolvePluginDir(baseDir) {
  const dir = path.resolve(baseDir || __dirname, PLUGIN_DIR_NAME).replace(/\\/g, "/");
  return asarUnpackedPath(dir);
}

function normalizePluginEntry(value) {
  return String(value || "").replace(/\\/g, "/");
}

function entryIsExactManagedPlugin(entry, pluginDir) {
  return typeof entry === "string" && normalizePluginEntry(entry) === normalizePluginEntry(pluginDir);
}

function readJsonC(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const stripped = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    return JSON.parse(stripped);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function registerMiMoCodePlugin(options = {}) {
  const configDir = path.join(os.homedir(), ".config", "mimocode");
  const configPath = options.configPath || path.join(configDir, "mimocode.jsonc");
  const pluginDir = options.pluginDir || resolvePluginDir();

  if (!options.configPath) {
    let exists = false;
    try { exists = fs.statSync(configDir).isDirectory(); } catch {}
    if (!exists) {
      if (!options.silent) {
        console.log("Clawd: ~/.config/mimocode/ not found — skipping mimocode plugin registration");
      }
      return {
        added: false,
        skipped: true,
        created: false,
        reason: "mimocode-not-found",
        configPath,
        pluginDir,
      };
    }
  }

  let settings = {};
  let created = false;
  try {
    settings = readJsonC(configPath);
    if (!settings || typeof settings !== "object") settings = {};
  } catch (err) {
    if (err.code === "ENOENT") {
      settings = { "$schema": "https://mimo.xiaomi.com//config.json" };
      created = true;
    } else {
      throw new Error(`Failed to read ${configPath}: ${err.message}`);
    }
  }

  if (!Array.isArray(settings.plugin)) settings.plugin = [];

  let matchIndex = -1;
  for (let i = 0; i < settings.plugin.length; i++) {
    const entry = settings.plugin[i];
    if (typeof entry !== "string") continue;
    if (entry === pluginDir) {
      matchIndex = i;
      break;
    }
    const normalized = entry.replace(/\\/g, "/");
    const isAbsolute = path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized);
    if (isAbsolute && path.posix.basename(normalized) === PLUGIN_DIR_NAME) {
      matchIndex = i;
      break;
    }
  }

  let added = false;
  let skipped = false;
  if (matchIndex === -1) {
    settings.plugin.push(pluginDir);
    added = true;
  } else if (settings.plugin[matchIndex] !== pluginDir) {
    settings.plugin[matchIndex] = pluginDir;
    added = true;
  } else {
    skipped = true;
  }

  if (!skipped) {
    writeJsonAtomic(configPath, settings);
  }

  if (!options.silent) {
    console.log(`Clawd mimocode plugin → ${configPath}`);
    if (created) console.log("  Created mimocode.jsonc");
    if (added) console.log(`  Registered: ${pluginDir}`);
    if (skipped) console.log(`  Already registered: ${pluginDir}`);
  }

  return { added, skipped, created, configPath, pluginDir };
}

function unregisterMiMoCodePlugin(options = {}) {
  const configDir = path.join(options.homeDir || os.homedir(), ".config", "mimocode");
  const configPath = options.configPath || path.join(configDir, "mimocode.jsonc");
  const pluginDir = options.pluginDir || resolvePluginDir();

  let settings = {};
  try {
    settings = readJsonC(configPath);
    if (!settings || typeof settings !== "object") settings = {};
  } catch (err) {
    if (err.code === "ENOENT") return { removed: 0, changed: false, skipped: true, configPath, pluginDir };
    throw new Error(`Failed to read ${configPath}: ${err.message}`);
  }

  if (!Array.isArray(settings.plugin)) {
    return { removed: 0, changed: false, skipped: true, configPath, pluginDir };
  }

  const before = settings.plugin.length;
  settings.plugin = settings.plugin.filter((entry) => !entryIsExactManagedPlugin(entry, pluginDir));
  const removed = before - settings.plugin.length;
  const changed = removed > 0;

  let backupPath = null;
  if (changed) backupPath = writeJsonAtomicWithBackup(configPath, settings, options);
  if (!options.silent) console.log(`Clawd mimocode plugin entries removed: ${removed}`);
  const result = { removed, changed, skipped: !changed, configPath, pluginDir };
  if (options.backup === true) result.backupPath = backupPath;
  return result;
}

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  registerMiMoCodePlugin,
  unregisterMiMoCodePlugin,
  resolvePluginDir,
  __test: { entryIsExactManagedPlugin, normalizePluginEntry },
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterMiMoCodePlugin({});
    else registerMiMoCodePlugin({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
