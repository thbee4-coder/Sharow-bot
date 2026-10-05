import { delay, requireBotAdmin } from "../lib/messenger.js";

export default {
  name: "كنيات",
  aliases: ["nicknames"],
  description: "تغيير كنيات أعضاء المجموعة",
  async execute({ args, send, threadId, runtime }) {
    const nickname = args.trim();
    if (!nickname) {
      await send("اكتب الكنية الجديدة بعد الأمر.");
      return;
    }
    if (nickname.length > 50) {
      await send("الكنية طويلة جدًا؛ الحد الأقصى 50 حرفًا.");
      return;
    }
    const info = await requireBotAdmin(runtime.api, threadId);
    const botId = runtime.api.getCurrentUserID();
    const participants = (info.participantIDs ?? []).filter((id) => id !== botId);
    for (const participantId of participants) {
      await runtime.api.nickname(nickname, threadId, participantId);
      await delay(500);
    }
    await runtime.protection.refreshFromCurrent(threadId);
    await send(`تم تحديث كنيات ${participants.length} عضوًا.`);
  },
};
