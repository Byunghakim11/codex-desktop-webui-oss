// Synthetic, deterministic and intentionally public test values only.
export function workflowFixtureTurns(threadId) {
  const prefix = threadId === "thread-workflow-b" ? "B" : "A";
  return [{ id: `${prefix}-turn`, status: "completed", completedAt: 2, items: [
    { id: `${prefix}-user`, type: "userMessage", content: [{ type: "text", text: `${prefix} request 한국어 literal [a+b]? and English.\n\nPlease inspect the loaded messages only.` }] },
    { id: `${prefix}-answer`, type: "agentMessage", phase: "final_answer", text: `${prefix} final answer 한국어 literal [a+b]?\n\n- First item\n- Second item\n\n\`\`\`js\n  const value = '[a+b]?';\n\n  console.log(value);\n\`\`\`\n\n\`\`\`text\nSecond code block only\n\`\`\`\n\nSYNTHETIC_API_KEY=synthetic-test-value-never-a-real-secret\n\n| Item | Value |\n| --- | --- |\n| Unicode | 한글 |` },
    { id: `${prefix}-question`, type: "agentMessage", delivery: "async", text: "NATIVE_EXCLUSION_SENTINEL", questions: [{ title: "Synthetic native question NATIVE_EXCLUSION_SENTINEL", options: ["Synthetic option"] }] },
    { id: `${prefix}-reply`, type: "userMessage", content: [{ type: "text", text: `<send_user_message_question_reply>\n${JSON.stringify([{questionItemId:JSON.stringify(["request_user_input_async",`${prefix}-question`,0]),question:"Synthetic native question NATIVE_EXCLUSION_SENTINEL",answer:"NATIVE_EXCLUSION_SENTINEL"}])}\n</send_user_message_question_reply>` }] },
    { id: `${prefix}-commentary`, type: "agentMessage", phase: "commentary", text: "NATIVE_EXCLUSION_SENTINEL activity" },
    { id: `${prefix}-tool`, type: "commandExecution", command: "echo NATIVE_EXCLUSION_SENTINEL", aggregatedOutput: "NATIVE_EXCLUSION_SENTINEL", status: "completed" },
  ] }];
}
