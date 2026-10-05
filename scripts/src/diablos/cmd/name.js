import { requireBotAdmin } from "../lib/messenger.js";

export default {
  name: "اسم",
  aliases: ["تغيير_الاسم", "اسم_المجموعة", "name"],
  description: "تغيير اسم المجموعة",
  async execute({ args, send, threadId, runtime }) {
    const name = args.trim();
    if (!name) {
      await send("اكتب الاسم الجديد بعد الأمر.");
      return;
    }
    if (name.length > 100) {
      await send("اسم المجموعة طويل جدًا؛ الحد الأقصى 100 حرف.");
      return;
    }
    await requireBotAdmin(runtime.api, threadId);
    await runtime.api.gcname(name, threadId);
    await runtime.protection.refreshFromCurrent(threadId);
    await send(`تم تغيير اسم المجموعة إلى: ${name}`);
  },
};
