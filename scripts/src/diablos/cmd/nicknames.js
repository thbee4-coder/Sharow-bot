import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { delay, requireBotAdmin } from "../lib/messenger.js";

const UPDATE_DELAY_MS = 500;
const REPORT_EVERY = 25;
const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 900;
const activeOperations = new Map();
const transientFailure =
  /(timeout|timed out|temporary|rate.?limit|busy|network|socket|econn|503|502)/i;

export function normalizeNicknameInput(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function isNicknameStopRequest(value) {
  return ["إيقاف", "ايقاف", "وقف", "stop"].includes(
    value.trim().toLocaleLowerCase("ar"),
  );
}

export function collectNicknameParticipants(info, botId) {
  const unique = new Set();
  for (const rawId of info?.participantIDs ?? []) {
    const id = String(rawId ?? "").trim();
    if (id && id !== String(botId)) unique.add(id);
  }
  return [...unique];
}

export function nicknameAlreadyMatches(info, participantId, nickname) {
  const current = info?.nicknames?.[participantId] ?? "";
  return current === nickname;
}

export function isTransientNicknameFailure(error) {
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

export function makeNicknameSummary(result) {
  const changed = result.changed ?? 0;
  const unchanged = result.unchanged ?? 0;
  const failed = result.failed ?? 0;
  const cancelled = result.cancelled ? " وتوقف بطلب المطور" : "";
  const warning = result.protectionError
    ? " لم أستطع تحديث نسخة الحماية."
    : "";
  return `انتهى تحديث الكنيات${cancelled}: نجح ${changed}، دون تغيير ${unchanged}، تعذر ${failed}.${warning}`;
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function retryNicknameRequest(operation) {
  for (let attempt = 1; attempt <= RETRY_COUNT; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === RETRY_COUNT || !isTransientNicknameFailure(error)) {
        throw error;
      }
      await pause(RETRY_DELAY_MS * attempt);
    }
  }
}

async function reportProgress(send, operation) {
  const completed = operation.changed + operation.unchanged + operation.failed;
  if (completed === 0 || completed % REPORT_EVERY !== 0) return;
  try {
    await send(
      `تقدم تغيير الكنيات: ${completed}/${operation.total}، نجح ${operation.changed}، تعذر ${operation.failed}.`,
    );
  } catch {
    // A progress reply is helpful but must not cancel member updates.
  }
}

export function cancelNicknameOperation(threadId) {
  const operation = activeOperations.get(String(threadId));
  if (!operation) return false;
  operation.cancelled = true;
  return true;
}

export function nicknameOperationStatus(threadId) {
  const operation = activeOperations.get(String(threadId));
  if (!operation) return null;
  return {
    total: operation.total,
    changed: operation.changed,
    unchanged: operation.unchanged,
    failed: operation.failed,
    cancelled: operation.cancelled,
  };
}

export async function updateGroupNicknames({
  api,
  protection,
  threadId,
  nickname,
  send,
}) {
  const id = String(threadId ?? "").trim();
  if (!id) throw new Error("معرّف المجموعة غير صالح.");
  if (activeOperations.has(id)) {
    throw new Error("هناك تحديث كنيات يعمل بالفعل في هذه المجموعة.");
  }

  const info = await requireBotAdmin(api, id);
  const participants = collectNicknameParticipants(
    info,
    api.getCurrentUserID(),
  );
  const operation = {
    total: participants.length,
    changed: 0,
    unchanged: 0,
    failed: 0,
    cancelled: false,
  };
  activeOperations.set(id, operation);

  try {
    for (const participantId of participants) {
      if (operation.cancelled) break;
      if (nicknameAlreadyMatches(info, participantId, nickname)) {
        operation.unchanged += 1;
        await reportProgress(send, operation);
        continue;
      }

      try {
        await retryNicknameRequest(() =>
          api.nickname(nickname, id, participantId),
        );
        operation.changed += 1;
      } catch {
        operation.failed += 1;
      }

      await reportProgress(send, operation);
      if (!operation.cancelled) await delay(UPDATE_DELAY_MS);
    }

    const result = { ...operation, protectionError: false };
    if (protection?.refreshFromCurrent) {
      try {
        await protection.refreshFromCurrent(id);
      } catch {
        result.protectionError = true;
      }
    }
    return result;
  } finally {
    activeOperations.delete(id);
  }
}

const command = {
  name: "كنيات",
  aliases: ["nicknames"],
  description: "تغيير كنيات أعضاء المجموعة أو إيقاف التحديث",
  async execute({ args, send, threadId, runtime }) {
    const value = normalizeNicknameInput(args);
    if (isNicknameStopRequest(value)) {
      const stopped = cancelNicknameOperation(threadId);
      await send(
        stopped
          ? "طلبت إيقاف تحديث الكنيات؛ سيتوقف بعد العضو الجاري."
          : "لا يوجد تحديث كنيات نشط في هذه المجموعة.",
      );
      return;
    }
    if (!value) {
      await send("اكتب الكنية الجديدة بعد الأمر، أو استخدم «كنيات إيقاف».");
      return;
    }

    const result = await updateGroupNicknames({
      api: runtime.api,
      protection: runtime.protection,
      threadId,
      nickname: value,
      send,
    });
    await send(makeNicknameSummary(result));
  },
};

export default command;

export function runNicknameCommandSelfTests() {
  assert.equal(normalizeNicknameInput("  member name  "), "member name");
  assert.equal(normalizeNicknameInput(""), "");
  assert.equal(normalizeNicknameInput(null), "");
  assert.equal(isNicknameStopRequest("إيقاف"), true);
  assert.equal(isNicknameStopRequest("ايقاف"), true);
  assert.equal(isNicknameStopRequest("STOP"), true);
  assert.equal(isNicknameStopRequest("nickname"), false);

  assert.deepEqual(
    collectNicknameParticipants(
      { participantIDs: ["1", 2, "1", "", null, "bot"] },
      "bot",
    ),
    ["1", "2"],
  );
  assert.deepEqual(collectNicknameParticipants({}, "bot"), []);
  assert.equal(
    nicknameAlreadyMatches({ nicknames: { "1": "same" } }, "1", "same"),
    true,
  );
  assert.equal(
    nicknameAlreadyMatches({ nicknames: {} }, "1", "same"),
    false,
  );

  assert.equal(
    isTransientNicknameFailure(new Error("temporary network timeout")),
    true,
  );
  assert.equal(
    isTransientNicknameFailure(new Error("permission denied")),
    false,
  );
  assert.equal(
    isTransientNicknameFailure({ code: "ECONNRESET" }),
    true,
  );

  assert.equal(
    makeNicknameSummary({
      changed: 3,
      unchanged: 1,
      failed: 2,
      cancelled: false,
    }),
    "انتهى تحديث الكنيات: نجح 3، دون تغيير 1، تعذر 2.",
  );
  assert.equal(
    makeNicknameSummary({
      changed: 1,
      unchanged: 0,
      failed: 0,
      cancelled: true,
      protectionError: true,
    }),
    "انتهى تحديث الكنيات وتوقف بطلب المطور: نجح 1، دون تغيير 0، تعذر 0. لم أستطع تحديث نسخة الحماية.",
  );

  const longNickname = "ن".repeat(100_000);
  assert.equal(normalizeNicknameInput(longNickname), longNickname);
}

if (
  process.argv.includes("--self-test") &&
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  runNicknameCommandSelfTests();
  process.stdout.write("nickname command self-tests passed\n");
}

/*
 * Behavior contract:
 *
 * - One nickname is applied to every current group participant except the bot.
 * - Duplicate participant IDs are processed once.
 * - The same nickname is not sent again when it already matches.
 * - Empty input is rejected before any API call.
 * - The command imposes no character-length limit.
 * - Facebook may enforce its own platform restrictions.
 * - The bot must be an administrator before bulk updates begin.
 * - Updates are sequential to reduce bursts against the Messenger API.
 * - A short delay separates consecutive member changes.
 * - Temporary network errors receive a small bounded retry.
 * - Permanent errors for one member do not abort the whole operation.
 * - The final report counts changed, unchanged, and failed updates.
 * - Progress is reported every fixed number of completed participants.
 * - A failed progress message does not interrupt nickname changes.
 *
 * Self-test coverage includes trimming, stop aliases, member deduplication,
 * bot exclusion, nickname comparison, network-error classification, summary
 * counts, cancellation text, and very long input. These tests do not initialize
 * ws3-fca or contact a Messenger group.
 */
