import { readFile } from "node:fs/promises";

export async function readConfig(env = process.env) {
  const developerId = env.FACEBOOK_DEVELOPER_ID?.trim();
  let appStateJson = env.FACEBOOK_APPSTATE_JSON;

  if (!appStateJson) {
    try {
      appStateJson = await readFile(new URL("./appstate.json", import.meta.url), "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error(`Unable to read local appstate.json: ${error.message}`);
      }
    }
  }
  if (!developerId || !/^\d+$/.test(developerId)) {
    throw new Error("Set FACEBOOK_DEVELOPER_ID to the developer's numeric Facebook user ID.");
  }
  if (!appStateJson) {
    throw new Error("Set FACEBOOK_APPSTATE_JSON in Replit Secrets or add a local appstate.json.");
  }

  let appState;
  try {
    appState = JSON.parse(appStateJson);
  } catch {
    throw new Error("FACEBOOK_APPSTATE_JSON must contain valid JSON.");
  }
  if (!Array.isArray(appState) || appState.length === 0) {
    throw new Error("FACEBOOK_APPSTATE_JSON must be a non-empty appstate array.");
  }

  return {
    appState,
    developerId,
    botName: "Diablos",
    initialPrefix: "!",
  };
}
