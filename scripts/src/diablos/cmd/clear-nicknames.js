import { delay, requireBotAdmin } from "../lib/messenger.js";

export default {
  name: "إزالة_الكنيات",
  aliases: ["ازالة_الكنيات", "مسح_الكنيات", "clear-nicknames"],
  description: "إزالة كنيات جميع أعضاء المجموعة",
  async execute({ send, threadId, runtime }) {
    const info = await requireBotAdmin(runtime.api, threadId);
    const botId = runtime.api.getCurrentUserID();
    const participants = (info.participantIDs ?? []).filter((id) => id !== botId);
    for (const participantId of participants) {
      await runtime.api.nickname("", threadId, participantId);
      await delay(500);
    }
    await runtime.protection.refreshFromCurrent(threadId);
    await send(`تمت إزالة كنيات ${participants.length} عضوًا.`);
  },
};
