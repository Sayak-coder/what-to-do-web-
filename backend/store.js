import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
const stateFile = path.join(dataDir, 'state.json');

const defaultState = {
  reminders: [],
  subscriptions: [],
};

async function ensureDataFile() {
  await fs.mkdir(dataDir, { recursive: true });

  try {
    await fs.access(stateFile);
  } catch {
    await fs.writeFile(stateFile, JSON.stringify(defaultState, null, 2));
  }
}

export async function loadState() {
  await ensureDataFile();

  try {
    const raw = await fs.readFile(stateFile, 'utf8');
    const parsed = JSON.parse(raw);

    return {
      reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
      subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
    };
  } catch {
    await fs.writeFile(stateFile, JSON.stringify(defaultState, null, 2));
    return structuredClone(defaultState);
  }
}

export async function saveState(state) {
  await ensureDataFile();
  const nextState = {
    reminders: Array.isArray(state.reminders) ? state.reminders : [],
    subscriptions: Array.isArray(state.subscriptions) ? state.subscriptions : [],
  };

  await fs.writeFile(stateFile, JSON.stringify(nextState, null, 2));
  return nextState;
}

export function getStateFilePath() {
  return stateFile;
}
