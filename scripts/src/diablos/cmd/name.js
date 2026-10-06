import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { requireBotAdmin } from "../lib/messenger.js";

const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 700;
const busyThreads = new Set();
const transientFailure =
  /(timeout|timed out|temporary|rate.?limit|busy|network|socket|econn|503|502)/i;

export function normalizeRequestedName(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function isNameDisplayRequest(value) {
  return ["عرض", "الحالي", "show", "current"].includes(
    value.trim().toLocaleLowerCase("ar"),
  );
}

export function currentNameFrom(info) {
  return typeof info?.threadName === "string" ? info.threadName : "";
}

export function isTransientNameFailure(error) {
  const message =
    typeof error?.message === "string"
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return (
    transientFailure.test(message) ||
    /^E(?:CONN|PIPE|HOST|TIMEDOUT)/i.test(String(error?.code ?? ""))
  );
}

export function shouldChangeName(currentName, requestedName) {
  return currentName !== requestedName;
}

export function nameFailureMessage(error) {
  const message =
    typeof error?.message === "string" ? error.message.toLowerCase() : "";

  if (message.includes("مشرفًا")) {
    return "اجعل حساب البوت مشرفًا في المجموعة أولًا.";
  }
  if (message.includes("permission") || message.includes("not allowed")) {
    return "رفض فيسبوك تغيير الاسم بسبب الصلاحيات.";
  }
  if (message.includes("not found") || message.includes("unknown thread")) {
    return "لم أتمكن من العثور على المجموعة.";
  }
  if (isTransientNameFailure(error)) {
    return "تعذر الاتصال مؤقتًا؛ لم أؤكد تغيير الاسم.";
  }
  return message
    ? `فشل تغيير الاسم: ${error.message}`
    : "حدث خطأ غير معروف أثناء تغيير الاسم.";
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function retryNameRequest(
  operation,
  attempts = RETRY_COUNT,
  delayMs = RETRY_DELAY_MS,
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isTransientNameFailure(error)) throw error;
      await pause(delayMs * attempt);
    }
  }
  throw lastError ?? new Error("Group-name request failed.");
}

async function verifyName(api, threadId, requestedName) {
  let observedName = "";
  for (let attempt = 0; attempt < RETRY_COUNT; attempt += 1) {
    const info = await retryNameRequest(
      () => api.getThreadInfo(threadId),
      RETRY_COUNT,
    );
    observedName = currentNameFrom(info);
    if (observedName === requestedName) return observedName;
    if (attempt < RETRY_COUNT - 1) await pause(RETRY_DELAY_MS);
  }
  throw new Error(
    `Facebook did not confirm the requested name. Current name: ${observedName || "(empty)"}`,
  );
}

export async function updateGroupName({ api, protection, threadId }, requestedName) {
  const normalizedThreadId = String(threadId ?? "").trim();
  if (!normalizedThreadId) throw new Error("معرّف المجموعة غير صالح.");
  if (busyThreads.has(normalizedThreadId)) {
    throw new Error("يوجد تغيير اسم قيد التنفيذ في هذه المجموعة.");
  }

  busyThreads.add(normalizedThreadId);
  try {
    const info = await requireBotAdmin(api, normalizedThreadId);
    const oldName = currentNameFrom(info);
    if (!shouldChangeName(oldName, requestedName)) {
      return { changed: false, name: oldName };
    }

    await retryNameRequest(
      () => api.gcname(requestedName, normalizedThreadId),
      RETRY_COUNT,
    );
    const confirmedName = await verifyName(
      api,
      normalizedThreadId,
      requestedName,
    );

    let protectionError = false;
    if (protection?.refreshFromCurrent) {
      try {
        await protection.refreshFromCurrent(normalizedThreadId);
      } catch {
        protectionError = true;
      }
    }
    return { changed: true, name: confirmedName, protectionError };
  } finally {
    busyThreads.delete(normalizedThreadId);
  }
}

const command = {
  name: "اسم",
  aliases: ["تغيير_الاسم", "اسم_المجموعة", "name"],
  description: "تغيير اسم المجموعة أو عرض الاسم الحالي",
  async execute({ args, send, threadId, runtime }) {
    const requestedName = normalizeRequestedName(args);
    if (!requestedName) {
      await send("اكتب الاسم الجديد بعد الأمر، أو استخدم «اسم عرض».");
      return;
    }

    if (isNameDisplayRequest(requestedName)) {
      const info = await runtime.api.getThreadInfo(threadId);
      const currentName = currentNameFrom(info);
      await send(
        currentName
          ? `اسم المجموعة الحالي: ${currentName}`
          : "لا يوجد اسم محدد للمجموعة.",
      );
      return;
    }

    let result;
    try {
      result = await updateGroupName(
        {
          api: runtime.api,
          protection: runtime.protection,
          threadId,
        },
        requestedName,
      );
    } catch (error) {
      await send(nameFailureMessage(error));
      return;
    }
    if (!result.changed) {
      await send(
        result.name
          ? `اسم المجموعة هو نفسه بالفعل: ${result.name}`
          : "اسم المجموعة فارغ بالفعل.",
      );
      return;
    }
    await send(
      result.protectionError
        ? `تم تغيير الاسم إلى ${result.name}، لكن تعذر تحديث نسخة الحماية.`
        : `تم تغيير اسم المجموعة إلى: ${result.name}`,
    );
  },
};

export default command;

export async function runNameCommandSelfTests() {
  assert.equal(normalizeRequestedName("  New Group  "), "New Group");
  assert.equal(normalizeRequestedName(""), "");
  assert.equal(normalizeRequestedName(null), "");
  assert.equal(normalizeRequestedName(1), "");
  assert.equal(isNameDisplayRequest("عرض"), true);
  assert.equal(isNameDisplayRequest("SHOW"), true);
  assert.equal(isNameDisplayRequest("اسم طويل"), false);
  assert.equal(currentNameFrom({ threadName: "Group" }), "Group");
  assert.equal(currentNameFrom({}), "");
  assert.equal(shouldChangeName("old", "new"), true);
  assert.equal(shouldChangeName("same", "same"), false);
  assert.equal(isTransientNameFailure(new Error("network timeout")), true);
  assert.equal(isTransientNameFailure(new Error("permission denied")), false);
  assert.equal(isTransientNameFailure({ code: "ECONNRESET" }), true);
  assert.equal(
    nameFailureMessage(new Error("permission denied")),
    "رفض فيسبوك تغيير الاسم بسبب الصلاحيات.",
  );
  assert.equal(
    nameFailureMessage(new Error("network timeout")),
    "تعذر الاتصال مؤقتًا؛ لم أؤكد تغيير الاسم.",
  );
  assert.equal(
    nameFailureMessage(new Error("unknown thread not found")),
    "لم أتمكن من العثور على المجموعة.",
  );
  assert.equal(
    nameFailureMessage({}),
    "حدث خطأ غير معروف أثناء تغيير الاسم.",
  );
  assert.equal(shouldChangeName("", "New"), true);
  assert.equal(shouldChangeName("Old", ""), true);

  let tries = 0;
  const result = await retryNameRequest(
    async () => {
      tries += 1;
      if (tries < 2) throw new Error("temporary network failure");
      return "ok";
    },
    2,
    0,
  );
  assert.equal(result, "ok");
  assert.equal(tries, 2);
  await assert.rejects(
    retryNameRequest(
      async () => {
        throw new Error("permission denied");
      },
      3,
      0,
    ),
    /permission denied/,
  );

  const unrestrictedName = "x".repeat(100_000);
  assert.equal(normalizeRequestedName(unrestrictedName), unrestrictedName);
}

if (
  process.argv.includes("--self-test") &&
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  await runNameCommandSelfTests();
  process.stdout.write("name command self-tests passed\n");
}

/*
 * Contract for callers:
 *
 * - The command does not accept a different group ID in its arguments.
 * - The command does not change members' nicknames.
 * - The command does not change the group prefix.
 * - The command never sends a message to an unrelated thread.
 * - One write is allowed per group at a time.
 * - The in-memory lock is removed even when an API call fails.
 * - A same-name request is reported as a no-op.
 * - A requested update uses `gcname(name, threadID)`.
 * - The current title is read again after the update.
 * - Success is reported only after the title matches exactly.
 * - A mismatch is reported as an unconfirmed update.
 * - Protection data is refreshed only after confirmation.
 * - Permission errors are not retried.
 * - Likely transport errors are retried up to three times.
 * - Retry delays increase gradually.
 * - Raw cookies and appstate are never included in output.
 * - The command imposes no name-length limit.
 * - Facebook can still reject a title under its own rules.
 *
 * The command keeps input handling separate from API operations:
 * `normalizeRequestedName` prepares text, `isNameDisplayRequest` selects the
 * read-only path, and `updateGroupName` performs the protected write.
 * Keeping these steps distinct makes failures easier to identify and test.
 */

/*
 * Self-test coverage:
 *
 * - Very long strings pass normalization unchanged.
 *
 * These tests use only local helpers. They do not load the session, initialize
 * ws3-fca, send messages, or modify a real group.
 */
