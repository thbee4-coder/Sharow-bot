import { createRequire } from "node:module";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readConfig } from "./config.js";
import { createStateStore } from "./lib/state.js";
import { createProtection } from "./lib/protection.js";
import { sendMessage } from "./lib/messenger.js";

const require = createRequire(import.meta.url);
const { login } = require("ws3-fca");
const commandsDirectory = fileURLToPath(new URL("./cmd/", import.meta.url));
const joinMessage = "majin ****en fu";

function log(message) {
  process.stdout.write(`[Diablos] ${message}\n`);
}

function asParticipantId(value) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const candidate =
      value.userID ?? value.userFbId ?? value.user_fb_id ?? value.uid ?? value.id;
    if (candidate !== undefined) return String(candidate);
  }
  return null;
}

function addedParticipantIds(event) {
  const data = event.logMessageData ?? {};
  const candidates = [
    data.addedParticipants,
    data.addedUserIDs,
    data.participantsAdded,
    data.participantIDs,
    data.added_participants,
  ];
  return new Set(
    candidates
      .flatMap((value) => (Array.isArray(value) ? value : value ? [value] : []))
      .map(asParticipantId)
      .filter(Boolean),
  );
}

async function loadCommands() {
  const files = (await readdir(commandsDirectory))
    .filter((file) => file.endsWith(".js"))
    .sort();
  const commands = new Map();
  for (const file of files) {
    const { default: command } = await import(
      new URL(`./cmd/${file}`, import.meta.url).href
    );
    if (!command?.name || typeof command.execute !== "function") {
      throw new Error(`Invalid command module: ${file}`);
    }
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      commands.set(name.toLocaleLowerCase("ar"), command);
    }
  }
  return commands;
}

function parseCommand(body, prefix) {
  const content = body.slice(prefix.length).trim();
  if (!content) return null;
  const splitAt = content.search(/\s/);
  const name = splitAt === -1 ? content : content.slice(0, splitAt);
  const args = splitAt === -1 ? "" : content.slice(splitAt + 1).trim();
  return { name: name.toLocaleLowerCase("ar"), args };
}

function connect(credentials) {
  return new Promise((resolve, reject) => {
    login(
      { appState: credentials.appState },
      {
        online: true,
        updatePresence: true,
        selfListen: false,
        listenEvents: true,
        autoReconnect: true,
        randomUserAgent: false,
      },
      (error, api) => {
        if (error || !api) reject(new Error("Facebook login failed. Check the saved appstate."));
        else resolve(api);
      },
    );
  });
}

async function main() {
  let config;
  try {
    config = await readConfig();
  } catch (error) {
    log(error.message);
    process.exitCode = 1;
    return;
  }

  const [state, commands] = await Promise.all([
    createStateStore(config.initialPrefix),
    loadCommands(),
  ]);
  const api = await connect(config);
  const botId = api.getCurrentUserID();
  const runtime = {
    api,
    config,
    state,
    baseLoops: new Map(),
    protection: null,
  };
  runtime.protection = createProtection(api, log);

  log(`Logged in as Diablos (${botId}); commands are restricted to the configured developer.`);
  try {
    await runtime.protection.resumeSavedProtections();
  } catch (error) {
    log(`Could not resume saved protection backups: ${error.message}`);
  }

  const onEvent = async (error, event) => {
    if (error) {
      log("Messenger listener reported a connection error.");
      return;
    }
    if (!event?.threadID) return;

    if (event.type === "event") {
      const logType = String(event.logMessageType ?? "").toLowerCase();
      const isGroupJoin = logType.includes("subscribe") || logType.includes("participant");
      if (isGroupJoin && addedParticipantIds(event).has(botId)) {
        try {
          await sendMessage(api, joinMessage, event.threadID);
        } catch {
          log(`Could not send the join message in group ${event.threadID}.`);
        }
      }
      void runtime.protection
        .scheduleRestore(String(event.threadID))
        .catch((protectionError) => {
          log(`Could not schedule protection restore: ${protectionError.message}`);
        });
      return;
    }

    if (
      event.type !== "message" ||
      event.isGroup !== true ||
      !event.body ||
      event.senderID !== config.developerId
    ) {
      return;
    }

    const threadId = String(event.threadID);
    const prefix = state.getPrefix(threadId);
    if (!event.body.startsWith(prefix)) return;
    const parsed = parseCommand(event.body, prefix);
    if (!parsed) return;
    const command = commands.get(parsed.name);
    if (!command) return;

    const send = (text, replyToMessageId = event.messageID) =>
      sendMessage(api, text, threadId, replyToMessageId);
    try {
      await command.execute({
        api,
        event,
        args: parsed.args,
        send,
        prefix,
        threadId,
        state,
        runtime,
      });
    } catch (commandError) {
      log(`Command ${command.name} failed in group ${threadId}: ${commandError.message}`);
      try {
        await send(commandError.message || "حدث خطأ أثناء تنفيذ الأمر.");
      } catch {
        log(`Could not send a command error response in group ${threadId}.`);
      }
    }
  };

  const listen = api.listenMqtt ?? api.listen;
  if (typeof listen !== "function") {
    throw new Error("ws3-fca did not expose a supported Messenger listener.");
  }
  listen.call(api, onEvent);

  process.on("SIGINT", () => {
    for (const loop of runtime.baseLoops.values()) {
      loop.stopped = true;
      clearTimeout(loop.timer);
    }
    log("Stopped.");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    for (const loop of runtime.baseLoops.values()) {
      loop.stopped = true;
      clearTimeout(loop.timer);
    }
    log("Stopped.");
    process.exit(0);
  });
}

main().catch((error) => {
  log(`Startup failed: ${error.message}`);
  process.exitCode = 1;
});
