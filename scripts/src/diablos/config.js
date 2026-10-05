import { readFile } from "node:fs/promises";

const localAppStateUrl = new URL("./appstate.json", import.meta.url);

function parseAppState(json, source) {
  let appState;
  try {
    appState = JSON.parse(json);
  } catch {
    throw new Error(`${source} must contain valid JSON.`);
  }
  if (
    !Array.isArray(appState) ||
    appState.length === 0 ||
    appState.some(
      (cookie) =>
        !cookie ||
        typeof cookie !== "object" ||
        typeof cookie.key !== "string" ||
        typeof cookie.value !== "string",
    )
  ) {
    throw new Error(`${source} must contain a non-empty appstate array of key/value entries.`);
  }
  return appState;
}

export async function readConfig(env = process.env, appStateUrl = localAppStateUrl) {
  const developerId = env.FACEBOOK_DEVELOPER_ID?.trim();
  let appState;
  let appStateSource;

  try {
    const localJson = await readFile(appStateUrl, "utf8");
    if (localJson.trim() && localJson.trim() !== "[]") {
      appState = parseAppState(localJson, "Local appstate.json");
      appStateSource = "file";
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (!appState && env.FACEBOOK_APPSTATE_JSON) {
    appState = parseAppState(env.FACEBOOK_APPSTATE_JSON, "FACEBOOK_APPSTATE_JSON");
    appStateSource = "Replit Secret";
  }

  if (!developerId || !/^\d+$/.test(developerId)) {
    throw new Error("Set FACEBOOK_DEVELOPER_ID to the developer's numeric Facebook user ID.");
  }
  if (!appState) {
    throw new Error("Set FACEBOOK_APPSTATE_JSON in Replit Secrets or add a local appstate.json.");
  }

  return {
    appState,
    appStateSource,
    developerId,
    botName: "Diablos",
    initialPrefix: "!",
  };
}
