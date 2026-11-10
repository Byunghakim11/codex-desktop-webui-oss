const bounded = (value, limit) => typeof value === "string" && value.trim().length > 0 && value.length <= limit;

export function asyncQuestions(item) {
  if (item?.delivery !== "async" || !bounded(item.id, 256) || !Array.isArray(item.questions) || item.questions.length < 1 || item.questions.length > 10) return null;
  if (!item.questions.every(q => q && bounded(q.title, 16000) && (q.options == null || (Array.isArray(q.options) && q.options.length <= 20 && q.options.every(option => bounded(option, 1000)))))) return null;
  return item.questions.map(q => ({title:q.title, options:q.options ? [...q.options] : []}));
}

export function questionReply(item, answers) {
  const questions = asyncQuestions(item);
  if (!questions || !Array.isArray(answers) || answers.length !== questions.length || !answers.every(a => bounded(a, 16000))) throw new Error("Answer every question before sending.");
  const entries = questions.map((q,index) => ({questionItemId:JSON.stringify(["request_user_input_async",item.id,index]),question:q.title,answer:answers[index].trim()}));
  return `<send_user_message_question_reply>\n${JSON.stringify(entries)}\n</send_user_message_question_reply>`;
}

export function parseQuestionReply(text) {
  if (typeof text !== "string" || text.length > 350000) return null;
  const match = text.trim().match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/);
  if (!match) return null;
  try {
    const entries = JSON.parse(match[1]);
    if (!Array.isArray(entries) || !entries.length || entries.length > 10) return null;
    const ids = new Set();
    for (const entry of entries) {
      if (!entry || !bounded(entry.questionItemId, 600) || !bounded(entry.question, 16000) || !bounded(entry.answer, 16000)) return null;
      const id = JSON.parse(entry.questionItemId);
      if (!Array.isArray(id) || id.length !== 3 || id[0] !== "request_user_input_async" || !bounded(id[1],256) || !Number.isInteger(id[2]) || id[2] < 0 || id[2] > 9 || ids.has(entry.questionItemId)) return null;
      ids.add(entry.questionItemId);
    }
    return entries;
  } catch { return null; }
}

export function groupTimeline(messages, compact = true) {
  const groups = [];
  let activity = [];
  const flush = () => { if (activity.length) { groups.push({type:"activity",messages:activity}); activity=[]; } };
  for (const message of messages) {
    if (message.pendingReply) continue;
    const canGroup = !message.questions && !message.imageGeneration && !message.images?.length && !["retryFailed","retrying","retryRecovered","contextCompaction"].includes(message.kind) && (message.kind === "reasoning" || message.role === "tool" || (message.role === "assistant" && message.phase === "commentary"));
    if (compact && canGroup) {
      if (activity.length && message.turnId && activity.at(-1).turnId && message.turnId !== activity.at(-1).turnId) flush();
      activity.push(message);
    } else { flush(); groups.push({type:"message",message}); }
  }
  flush();
  return groups;
}
