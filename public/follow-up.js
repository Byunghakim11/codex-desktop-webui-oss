export function buildPromptRequest({ threadId, activeTurnId, input, clientUserMessageId, queue = false }) {
  if (activeTurnId && queue) {
    return {
      mode: "queue",
      method: "thread/queue/add",
      params: { threadId, input, clientUserMessageId }
    };
  }
  if (activeTurnId) {
    return {
      mode: "steer",
      method: "turn/steer",
      params: { threadId, expectedTurnId: activeTurnId, input, clientUserMessageId }
    };
  }
  return {
    mode: "start",
    method: "turn/start",
    params: { threadId, input, clientUserMessageId }
  };
}

export function buildInterruptRequest({ threadId, activeTurnId }) {
  if (!threadId || !activeTurnId) throw new Error("An active thread and turn are required to stop a response");
  return {
    method: "turn/interrupt",
    params: { threadId, turnId: activeTurnId }
  };
}

export function shouldAdvanceQueueAfterTurn(status) {
  return !["interrupted", "cancelled", "canceled"].includes(String(status || "").toLowerCase());
}

export async function waitForPendingImageUploads(images = []) {
  const uploads = images
    .filter((image) => image?.status === "preparing" || image?.status === "uploading")
    .map((image) => image.readyPromise)
    .filter(Boolean);
  if (!uploads.length) return false;
  await Promise.allSettled(uploads);
  return true;
}
