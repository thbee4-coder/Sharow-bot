const parseList = (value) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export function readConfig(env = process.env) {
  const developerId = env.FACEBOOK_DEVELOPER_ID?.trim();
  const allowedThreadIds = parseList(env.FACEBOOK_ALLOWED_THREAD_IDS);
  const appStateJson = env.FACEBOOK_APPSTATE_JSON;

  if (!appStateJson) {
    throw new Error("FACEBOOK_APPSTATE_JSON is missing from Replit Secrets.");
  }
  if (!developerId || !/^\d+$/.test(developerId)) {
    throw new Error("Set FACEBOOK_DEVELOPER_ID to the developer's numeric Facebook user ID.");
  }
  if (allowedThreadIds.length === 0) {
    throw new Error("Set FACEBOOK_ALLOWED_THREAD_IDS to one or more approved group IDs.");
  }
  if (allowedThreadIds.some((threadId) => !/^\d+$/.test(threadId))) {
    throw new Error("FACEBOOK_ALLOWED_THREAD_IDS must contain numeric Facebook group IDs.");
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
    allowedThreadIds: new Set(allowedThreadIds),
    botName: "Diablos",
    initialPrefix: "!",
  };
}
