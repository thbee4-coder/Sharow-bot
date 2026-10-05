import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import path from "node:path";

const directory = fileURLToPath(new URL("./", import.meta.url));
const entry = path.join(directory, "index.js");
const watchedFile = "appstate.json";
const debounceMs = 800;

let child = null;
let restartTimer = null;
let restarting = false;
let shuttingDown = false;

function log(message) {
  process.stdout.write(`[Diablos runner] ${message}\n`);
}

function startBot() {
  if (shuttingDown) return;
  child = spawn(process.execPath, [entry], {
    cwd: directory,
    env: process.env,
    stdio: "inherit",
  });

  const currentChild = child;
  currentChild.once("error", (error) => {
    log(`Could not start the bot process: ${error.message}`);
  });
  currentChild.once("exit", (code, signal) => {
    if (child !== currentChild) return;
    child = null;
    if (!shuttingDown && !restarting) {
      log(
        code === 0
          ? "The bot process stopped."
          : `The bot process exited (${signal ?? code}). Save appstate.json to retry.`,
      );
    }
  });
}

async function stopBot() {
  const currentChild = child;
  if (!currentChild || currentChild.exitCode !== null) return;

  currentChild.kill("SIGTERM");
  await Promise.race([
    once(currentChild, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);

  if (currentChild.exitCode === null) {
    currentChild.kill("SIGKILL");
  }
}

async function restartBot() {
  if (restarting || shuttingDown) return;
  restarting = true;
  log("appstate.json changed; reconnecting with the saved session.");
  try {
    await stopBot();
    if (!shuttingDown) startBot();
  } finally {
    restarting = false;
  }
}

function scheduleRestart() {
  if (shuttingDown) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    void restartBot();
  }, debounceMs);
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(restartTimer);
  watcher.close();
  log(`Stopping on ${signal}.`);
  void stopBot().finally(() => process.exit(0));
}

let watcher;
try {
  watcher = watch(directory, (_eventType, filename) => {
    if (filename?.toString() === watchedFile) scheduleRestart();
  });
} catch (error) {
  log(`Could not watch appstate.json: ${error.message}`);
  process.exitCode = 1;
  process.exit();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startBot();
