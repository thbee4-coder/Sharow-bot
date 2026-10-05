import { sendMessage } from "../lib/messenger.js";

const intervals = [15, 19, 29, 34];

export default {
  name: "بيس",
  aliases: ["base"],
  description: "تكرار نص بفاصل عشوائي حتى الإيقاف",
  async execute({ args, event, send, threadId, runtime }) {
    const text = args.trim();
    if (["إيقاف", "ايقاف", "stop"].includes(text.toLocaleLowerCase("ar"))) {
      const loop = runtime.baseLoops.get(threadId);
      if (!loop) {
        await send("لا يوجد تكرار نشط في هذه المجموعة.");
        return;
      }
      loop.stopped = true;
      clearTimeout(loop.timer);
      runtime.baseLoops.delete(threadId);
      await send("🌀تم إيقاف التكرار.");
      return;
    }

    if (!text) {
      await send("اكتب النص بعد الأمر، أو استخدم «بيس إيقاف» لإيقاف التكرار.");
      return;
    }
    if (text.length > 1500) {
      await send("النص طويل جدًا؛ الحد الأقصى 1500 حرف.");
      return;
    }
    if (runtime.baseLoops.has(threadId)) {
      await send("يوجد تكرار نشط بالفعل. أوقفه أولًا باستخدام «بيس إيقاف».");
      return;
    }

    const loop = { stopped: false, timer: null, text };
    runtime.baseLoops.set(threadId, loop);
    const schedule = () => {
      const seconds = intervals[Math.floor(Math.random() * intervals.length)];
      loop.timer = setTimeout(async () => {
        if (loop.stopped) return;
        try {
          await sendMessage(runtime.api, loop.text, threadId);
          if (!loop.stopped) schedule();
        } catch {
          loop.stopped = true;
          runtime.baseLoops.delete(threadId);
          await send("توقف التكرار بسبب تعذر إرسال رسالة.");
        }
      }, seconds * 1000);
    };
    schedule();
    await send(
      `بدأ التكرار في هذه المجموعة. سيُرسل النص كل 15 أو 19 أو 29 أو 34 ثانية. للإيقاف: ${runtime.state.getPrefix(threadId)}بيس إيقاف`,
      event.messageID,
    );
  },
};
