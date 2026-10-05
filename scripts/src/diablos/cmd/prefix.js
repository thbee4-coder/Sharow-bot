export default {
  name: "بادئة",
  aliases: ["prefix", "تغيير_البادئة", "تغيير-البادئة"],
  description: "تغيير بادئة الأوامر في هذه المجموعة",
  async execute({ args, send, state, threadId }) {
    const nextPrefix = args.trim();
    if (!nextPrefix) {
      await send("اكتب البادئة الجديدة بعد الأمر، مثل: !بادئة #");
      return;
    }
    if (/\s/.test(nextPrefix)) {
      await send("يجب ألا تحتوي البادئة على مسافات.");
      return;
    }
    await state.setPrefix(threadId, nextPrefix);
    await send(`تم تغيير البادئة في هذه المجموعة إلى: ${nextPrefix}`);
  },
};
