import { requireBotAdmin } from "../lib/messenger.js";

export default {
  name: "حماية",
  aliases: ["protect"],
  description: "حفظ اسم المجموعة وكنياتها أو إيقاف الاستعادة التلقائية",
  async execute({ args, send, threadId, runtime }) {
    const choice = args.trim().toLocaleLowerCase("ar");
    if (["إيقاف", "ايقاف", "off", "تعطيل"].includes(choice)) {
      const existed = await runtime.protection.disable(threadId);
      await send(existed ? "تم إيقاف الحماية." : "الحماية غير مفعلة في هذه المجموعة.");
      return;
    }

    await requireBotAdmin(runtime.api, threadId);
    const snapshot = await runtime.protection.enable(threadId);
    await send(
      `تم تفعيل الحماية وحفظ اسم المجموعة وكنياتها في Nike. ستتم الاستعادة بعد 15 ثانية من أي تغيير. عدد الكنيات المحفوظة: ${Object.keys(snapshot.nicknames).length}.`,
    );
  },
};
