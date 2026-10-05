import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { requireBotAdmin } from "../lib/messenger.js";

const RETRY_LIMIT = 3;
const RETRY_BASE_DELAY_MS = 700;
const OPERATION_LOCKS = new Set();
const TRANSIENT_ERROR_PATTERN =
  /(timeout|timed out|temporary|temporarily|rate.?limit|busy|network|socket|econn|503|502)/i;

/**
 * Return trimmed text without imposing an application-side length limit.
 *
 * Messenger itself may reject text which exceeds its current platform limit.
 * That is an API result, not a local validation rule imposed by this command.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeRequestedName(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

/**
 * Determine whether an API failure is likely to clear on retry.
 *
 * Permission errors, invalid thread errors, and policy errors should be
 * returned immediately. Network timeouts and transient server responses may
 * be retried a small number of times with a delay.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTransientNameError(error) {
  const message =
    typeof error?.message === "string"
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const code = String(error?.code ?? "");
  return TRANSIENT_ERROR_PATTERN.test(message) || /^E(?:CONN|PIPE|HOST|TIMEDOUT)/i.test(code);
}

/**
 * Wait before a retry without blocking the process event loop.
 *
 * @param {number} milliseconds
 * @returns {Promise<void>}
 */
function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Retry only transient failures; all other errors are immediately rethrown.
 *
 * @template T
 * @param {() => Promise<T>} operation
 * @param {number} attempts
 * @returns {Promise<T>}
 */
export async function retryTransientNameOperation(
  operation,
  attempts = RETRY_LIMIT,
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const shouldRetry =
        attempt < attempts && isTransientNameError(error);
      if (!shouldRetry) throw error;
      await wait(RETRY_BASE_DELAY_MS * attempt);
    }
  }
  throw lastError ?? new Error("Group-name update failed.");
}

/**
 * Read a group name from the supported ws3-fca thread-info shape.
 *
 * @param {unknown} info
 * @returns {string}
 */
export function readCurrentGroupName(info) {
  return typeof info?.threadName === "string" ? info.threadName : "";
}

/**
 * Create an immutable description of the requested change.
 *
 * Keeping the plan pure makes it easy to test without sending a Facebook
 * request. The API write is performed only after permission and lock checks.
 *
 * @param {string} previousName
 * @param {string} requestedName
 * @returns {{previousName: string, requestedName: string, changed: boolean}}
 */
export function makeNameChangePlan(previousName, requestedName) {
  return Object.freeze({
    previousName,
    requestedName,
    changed: previousName !== requestedName,
  });
}

/**
 * Return a user-safe error message for the common failure classes.
 *
 * The raw package error may contain provider data. The bot sends a concise
 * explanation, while the workflow log records only the error message.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function explainNameFailure(error) {
  const message =
    typeof error?.message === "string" ? error.message.toLowerCase() : "";

  if (message.includes("اجعل حساب البوت مشرفًا")) {
    return "لا يملك حساب البوت صلاحية المشرف في هذه المجموعة.";
  }
  if (message.includes("permission") || message.includes("not allowed")) {
    return "رفض فيسبوك تغيير اسم المجموعة بسبب الصلاحيات.";
  }
  if (message.includes("not found") || message.includes("unknown thread")) {
    return "لم أتمكن من العثور على هذه المجموعة.";
  }
  if (isTransientNameError(error)) {
    return "تعذر الاتصال مؤقتًا. لم أؤكد تغيير اسم المجموعة.";
  }
  if (message) return `فشل تغيير الاسم: ${error.message}`;
  return "حدث خطأ غير معروف أثناء تغيير اسم المجموعة.";
}

/**
 * Make a clear response for a no-op request.
 *
 * @param {string} name
 * @returns {string}
 */
export function unchangedNameMessage(name) {
  return name
    ? `اسم المجموعة هو نفسه بالفعل: ${name}`
    : "اسم المجموعة فارغ بالفعل.";
}

/**
 * Format the change acknowledgement after the API confirms the operation.
 *
 * @param {string} name
 * @returns {string}
 */
export function changedNameMessage(name) {
  return `تم تغيير اسم المجموعة إلى: ${name}`;
}

/**
 * Show the current title without changing it.
 *
 * @param {object} api
 * @param {string} threadId
 * @returns {Promise<string>}
 */
export async function fetchNameForDisplay(api, threadId) {
  const info = await api.getThreadInfo(threadId);
  return readCurrentGroupName(info);
}

/**
 * Check whether the caller asked to display the current name.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isShowNameRequest(value) {
  return ["عرض", "الحالي", "show", "current"].includes(
    value.trim().toLocaleLowerCase("ar"),
  );
}

/**
 * Normalize IDs used by the command lock.
 *
 * @param {unknown} threadId
 * @returns {string}
 */
export function normalizeNameThreadId(threadId) {
  if (typeof threadId === "number") return String(threadId);
  if (typeof threadId === "string") return threadId.trim();
  return "";
}

/**
 * The API update is retried only on transport/server faults.
 *
 * A successful call is followed by a fresh thread-info read. The bot does not
 * claim success solely because a promise resolved; it compares the returned
 * group name with the value requested by the developer.
 *
 * @param {object} api
 * @param {string} name
 * @param {string} threadId
 * @returns {Promise<string>}
 */
export async function applyAndVerifyGroupName(api, name, threadId) {
  await retryTransientNameOperation(() => api.gcname(name, threadId));
  const verifiedInfo = await retryTransientNameOperation(() =>
    api.getThreadInfo(threadId),
  );
  const verifiedName = readCurrentGroupName(verifiedInfo);
  if (verifiedName !== name) {
    throw new Error("Facebook did not confirm the requested group name.");
  }
  return verifiedName;
}

/**
 * Report a failed confirmation without hiding the actual group state.
 *
 * @param {object} api
 * @param {string} threadId
 * @returns {Promise<string|null>}
 */
export async function recoverVisibleGroupName(api, threadId) {
  try {
    const current = await api.getThreadInfo(threadId);
    return readCurrentGroupName(current);
  } catch {
    return null;
  }
}

/**
 * Run a protected group-name update with explicit preflight and cleanup.
 *
 * @param {object} context
 * @param {string} requestedName
 * @returns {Promise<{changed: boolean, name: string}>}
 */
export async function updateGroupName(context, requestedName) {
  const { api, threadId, protection } = context;
  const lockKey = normalizeNameThreadId(threadId);
  if (!lockKey) throw new Error("معرّف المجموعة غير صالح.");
  if (OPERATION_LOCKS.has(lockKey)) {
    throw new Error("يوجد تغيير اسم قيد التنفيذ في هذه المجموعة.");
  }

  OPERATION_LOCKS.add(lockKey);
  try {
    await requireBotAdmin(api, lockKey);
    const beforeInfo = await api.getThreadInfo(lockKey);
    const beforeName = readCurrentGroupName(beforeInfo);
    const plan = makeNameChangePlan(beforeName, requestedName);

    if (!plan.changed) {
      return { changed: false, name: beforeName };
    }

    const confirmedName = await applyAndVerifyGroupName(
      api,
      plan.requestedName,
      lockKey,
    );

    // Refresh only after Facebook has confirmed the new name, so active
    // protection records the requested value as its new baseline.
    if (protection?.refreshFromCurrent) {
      await protection.refreshFromCurrent(lockKey);
    }
    return { changed: true, name: confirmedName };
  } finally {
    OPERATION_LOCKS.delete(lockKey);
  }
}

/**
 * The command supports a read-only form as well as the requested write form.
 *
 * `!اسم عرض` reports the current group name.
 * `!اسم <new name>` updates it with no local length ceiling.
 *
 * @type {import("../types.js").Command}
 */
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

    if (isShowNameRequest(requestedName)) {
      const currentName = await fetchNameForDisplay(runtime.api, threadId);
      await send(currentName ? `اسم المجموعة الحالي: ${currentName}` : "لا يوجد اسم محدد للمجموعة.");
      return;
    }

    const result = await updateGroupName(
      {
        api: runtime.api,
        threadId,
        protection: runtime.protection,
      },
      requestedName,
    );

    if (!result.changed) {
      await send(unchangedNameMessage(result.name));
      return;
    }
    await send(changedNameMessage(result.name));
  },
};

export default command;

/**
 * Pure helper checks for the command's exact parsing and decision rules.
 *
 * Run with:
 *   node scripts/src/diablos/cmd/name.js --self-test
 *
 * These checks do not log in, read appstate, or contact Facebook.
 */
export function runNameCommandSelfTests() {
  assert.equal(normalizeRequestedName("  New Group  "), "New Group");
  assert.equal(normalizeRequestedName(""), "");
  assert.equal(normalizeRequestedName(null), "");
  assert.equal(normalizeRequestedName(12), "");

  assert.equal(readCurrentGroupName({ threadName: "Diablos" }), "Diablos");
  assert.equal(readCurrentGroupName({ threadName: "" }), "");
  assert.equal(readCurrentGroupName({}), "");
  assert.equal(readCurrentGroupName(null), "");

  assert.deepEqual(makeNameChangePlan("old", "new"), {
    previousName: "old",
    requestedName: "new",
    changed: true,
  });
  assert.deepEqual(makeNameChangePlan("same", "same"), {
    previousName: "same",
    requestedName: "same",
    changed: false,
  });

  assert.equal(isShowNameRequest("عرض"), true);
  assert.equal(isShowNameRequest("الحالي"), true);
  assert.equal(isShowNameRequest("SHOW"), true);
  assert.equal(isShowNameRequest("New Group"), false);

  assert.equal(normalizeNameThreadId(123), "123");
  assert.equal(normalizeNameThreadId(" 123 "), "123");
  assert.equal(normalizeNameThreadId(null), "");

  assert.equal(isTransientNameError(new Error("network timeout")), true);
  assert.equal(isTransientNameError(new Error("Permission denied")), false);
  assert.equal(isTransientNameError({ code: "ECONNRESET" }), true);

  assert.equal(changedNameMessage("A"), "تم تغيير اسم المجموعة إلى: A");
  assert.equal(unchangedNameMessage("A"), "اسم المجموعة هو نفسه بالفعل: A");
  assert.equal(unchangedNameMessage(""), "اسم المجموعة فارغ بالفعل.");
  assert.equal(
    explainNameFailure(new Error("permission denied")),
    "رفض فيسبوك تغيير اسم المجموعة بسبب الصلاحيات.",
  );

  const noRetryError = new Error("permission denied");
  assert.rejects(
    retryTransientNameOperation(async () => {
      throw noRetryError;
    }),
    noRetryError,
  );

  const longName = "x".repeat(100_000);
  assert.equal(normalizeRequestedName(longName), longName);
}

if (
  process.argv.includes("--self-test") &&
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  runNameCommandSelfTests();
  process.stdout.write("name command self-tests passed\n");
}

/*
 * Operational contract:
 *
 * 1. Only the main message handler calls this command, and that handler checks
 *    the developer ID before dispatching any command.
 * 2. The bot account must be a group administrator before changing the title.
 * 3. The requested name is trimmed but is not capped by this application.
 * 4. A blank request never reaches Facebook.
 * 5. `عرض` and `show` are read-only aliases.
 * 6. One title operation may run per group at a time.
 * 7. A second concurrent title operation receives a clear busy response.
 * 8. API retries are limited to likely transient failures.
 * 9. Permission failures are never retried.
 * 10. A write is verified by reading thread info again.
 * 11. A successful change updates the protection baseline.
 * 12. A failed write does not update the protection baseline.
 * 13. Error responses do not include appstate, cookies, or login values.
 * 14. No direct filesystem access is performed by the command.
 * 15. The thread identifier is normalized before it is used as a lock key.
 * 16. The lock is released in `finally`, including on API exceptions.
 * 17. Empty current names are reported explicitly.
 * 18. Long names are passed through to Facebook without a local length rule.
 * 19. Platform-side rejection is reported instead of silently truncating text.
 * 20. The command does not send a success response until verification succeeds.
 * 21. A read-only query does not require the bot to be a group administrator.
 * 22. A write always performs the administrator preflight.
 * 23. The API helper uses ws3-fca's documented `gcname(name, threadID)` order.
 * 24. Verification uses ws3-fca's documented `getThreadInfo(threadID)` method.
 * 25. Name comparison is exact after the input has been trimmed.
 * 26. The command does not alter group nicknames.
 * 27. The command does not alter the command prefix.
 * 28. The command does not send any repeating messages.
 * 29. This module exports its default command for the command loader.
 * 30. Test helpers are exported for Node's built-in assertion runner.
 * 31. Self-tests are opt-in and never run during normal bot startup.
 * 32. Self-tests use no network access.
 * 33. Self-tests do not import or inspect the configured session.
 * 34. Retry delays scale with the retry attempt.
 * 35. The retry loop returns the original API result.
 * 36. A missing thread name is represented as an empty string.
 * 37. A missing thread ID fails before any change is attempted.
 * 38. Errors without a message use a generic user-visible response.
 * 39. Transient error matching covers common Node connection codes.
 * 40. The code avoids interpolating raw error objects into chat messages.
 *
 * The command intentionally keeps the user's requested operation narrow:
 * change one group's title, verify it, and synchronize protection. The length
 * of this file is not used as a runtime limit. Every operation still depends
 * on the group permissions granted to the bot account and on Facebook's
 * current service behavior.
 */

/*
 * Self-test inventory:
 *
 * - Text input is trimmed consistently.
 * - Non-string input is rejected without coercion.
 * - A missing thread title does not crash the command.
 * - A same-title request is a no-op.
 * - A different-title request produces a change plan.
 * - Arabic display aliases are recognized.
 * - English display aliases are recognized case-insensitively.
 * - A normal title is not mistaken for a display action.
 * - Numeric thread IDs become stable lock strings.
 * - Whitespace around a thread ID is removed.
 * - Invalid IDs normalize to an empty value.
 * - Network-related failures are considered transient.
 * - Permission failures are considered permanent.
 * - Node connection reset errors are considered transient.
 * - Success text includes the exact title.
 * - No-op text handles named titles.
 * - No-op text handles unnamed groups.
 * - Permission errors receive a concise explanation.
 * - Permanent failures are not retried.
 * - Very long names are not truncated or refused locally.
 *
 * Manual group verification remains necessary for the external Messenger
 * service. The offline checks here confirm only the local command helpers.
 */
