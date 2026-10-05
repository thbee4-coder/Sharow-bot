function formatDuration(totalSeconds) {
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600) % 24;
  const days = Math.floor(totalSeconds / 86400);
  return [
    days ? `${days} يوم` : null,
    hours ? `${hours} ساعة` : null,
    minutes ? `${minutes} دقيقة` : null,
    `${seconds} ثانية`,
  ]
    .filter(Boolean)
    .join("، ");
}

export default {
  name: "uptime",
  aliases: ["ابتيم", "ابتime", "حالة"],
  description: "عرض حالة البوت ومدة تشغيله",
  async execute({ api, send, state, threadId, runtime }) {
    const protection = await runtime.protection.status(threadId);
    const memoryMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    await send(
      [
        `الاسم: ${runtime.config.botName}`,
        `حساب فيسبوك: ${api.getCurrentUserID()}`,
        `الحالة: متصل`,
        `مدة التشغيل: ${formatDuration(Math.floor(process.uptime()))}`,
        `البادئة هنا: ${state.getPrefix(threadId)}`,
        `المجموعة مسموح بها: نعم`,
        `الحماية: ${protection.enabled ? "مفعلة" : "متوقفة"}`,
        `رسائل بيس النشطة: ${runtime.baseLoops.has(threadId) ? "نعم" : "لا"}`,
        `استخدام الذاكرة: ${memoryMb} MB`,
      ].join("\n"),
    );
  },
};
