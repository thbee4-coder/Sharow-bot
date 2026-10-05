import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDirectory = fileURLToPath(new URL("../data/", import.meta.url));
const stateFile = path.join(dataDirectory, "state.json");

async function writeJsonAtomically(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, filePath);
}

export async function createStateStore(initialPrefix = "!") {
  let state;
  try {
    state = JSON.parse(await readFile(stateFile, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`Unable to read bot settings: ${error.message}`);
    }
    state = { prefixes: {} };
  }

  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("Bot settings file has an invalid format.");
  }
  if (!state.prefixes || typeof state.prefixes !== "object") {
    state.prefixes = {};
  }

  return {
    getPrefix(threadId) {
      return state.prefixes[threadId] || initialPrefix;
    },
    async setPrefix(threadId, prefix) {
      state.prefixes[threadId] = prefix;
      await writeJsonAtomically(stateFile, state);
    },
  };
}

export { dataDirectory, writeJsonAtomically };
