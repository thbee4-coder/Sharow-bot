import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { delay } from "./messenger.js";

const nikeDirectory = fileURLToPath(new URL("../Nike/", import.meta.url));
const restoreDelayMs = 15_000;
const nicknameChangeDelayMs = 500;

function backupPath(threadId) {
  return path.join(nikeDirectory, `${threadId}.json`);
}

async function writeSnapshot(threadId, snapshot) {
  await mkdir(nikeDirectory, { recursive: true });
  const filePath = backupPath(threadId);
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, filePath);
}

function makeSnapshot(threadId, info, enabled) {
  return {
    threadId,
    enabled,
    groupName: info.threadName ?? "",
    nicknames: Object.fromEntries(
      Object.entries(info.nicknames ?? {}).map(([id, nickname]) => [
        id,
        nickname ?? "",
      ]),
    ),
    savedAt: new Date().toISOString(),
  };
}

export function createProtection(api, onError = () => {}) {
  const cache = new Map();
  const timers = new Map();
  const runningRestores = new Set();

  async function getSnapshot(threadId) {
    if (cache.has(threadId)) return cache.get(threadId);
    try {
      const snapshot = JSON.parse(await readFile(backupPath(threadId), "utf8"));
      if (
        snapshot?.threadId !== threadId ||
        typeof snapshot.enabled !== "boolean" ||
        typeof snapshot.nicknames !== "object"
      ) {
        throw new Error("Invalid protection backup format.");
      }
      cache.set(threadId, snapshot);
      return snapshot;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new Error(`Unable to read protection backup for ${threadId}: ${error.message}`);
    }
  }

  async function save(threadId, snapshot) {
    await writeSnapshot(threadId, snapshot);
    cache.set(threadId, snapshot);
  }

  async function enable(threadId) {
    const info = await api.getThreadInfo(threadId);
    const snapshot = makeSnapshot(threadId, info, true);
    await save(threadId, snapshot);
    return snapshot;
  }

  async function disable(threadId) {
    const snapshot = await getSnapshot(threadId);
    if (!snapshot) return false;
    snapshot.enabled = false;
    snapshot.savedAt = new Date().toISOString();
    await save(threadId, snapshot);
    const timer = timers.get(threadId);
    if (timer) clearTimeout(timer);
    timers.delete(threadId);
    return true;
  }

  async function refreshFromCurrent(threadId) {
    const previous = await getSnapshot(threadId);
    const info = await api.getThreadInfo(threadId);
    await save(threadId, makeSnapshot(threadId, info, previous?.enabled ?? false));
  }

  async function restore(threadId) {
    if (runningRestores.has(threadId)) return;
    runningRestores.add(threadId);
    try {
      const snapshot = await getSnapshot(threadId);
      if (!snapshot?.enabled) return;

      const info = await api.getThreadInfo(threadId);

      // Capture first-seen nicknames for new participants; keep the saved
      // values for existing members as the protected baseline.
      for (const participantId of info.participantIDs ?? []) {
        if (!(participantId in snapshot.nicknames)) {
          snapshot.nicknames[participantId] = info.nicknames?.[participantId] ?? "";
        }
      }
      await save(threadId, snapshot);

      if ((info.threadName ?? "") !== snapshot.groupName) {
        await api.gcname(snapshot.groupName, threadId);
        await delay(nicknameChangeDelayMs);
      }

      for (const [participantId, savedNickname] of Object.entries(snapshot.nicknames)) {
        const currentNickname = info.nicknames?.[participantId] ?? "";
        if (currentNickname !== savedNickname) {
          await api.nickname(savedNickname, threadId, participantId);
          await delay(nicknameChangeDelayMs);
        }
      }
    } catch (error) {
      onError(`تعذر استعادة حماية المجموعة ${threadId}: ${error.message}`);
    } finally {
      runningRestores.delete(threadId);
    }
  }

  async function scheduleRestore(threadId) {
    const snapshot = await getSnapshot(threadId);
    if (!snapshot?.enabled) return;
    const existing = timers.get(threadId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(threadId);
      void restore(threadId);
    }, restoreDelayMs);
    timers.set(threadId, timer);
  }

  async function status(threadId) {
    const snapshot = await getSnapshot(threadId);
    return {
      enabled: snapshot?.enabled ?? false,
      savedAt: snapshot?.savedAt ?? null,
    };
  }

  return { enable, disable, refreshFromCurrent, scheduleRestore, status };
}
