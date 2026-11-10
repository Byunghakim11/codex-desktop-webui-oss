import assert from "node:assert/strict";
import test from "node:test";
import { isWebUserServerRequest } from "../server/server-request-policy.js";

test("WebUI exposes only server requests it can answer correctly", () => {
  for (const method of [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/tool/requestUserInput",
    "item/permissions/requestApproval",
    "mcpServer/elicitation/request",
    "execCommandApproval",
    "applyPatchApproval"
  ]) {
    assert.equal(isWebUserServerRequest(method), true, method);
  }
});

test("Desktop-only requests never become false mobile approvals", () => {
  for (const method of [
    "attestation/generate",
    "account/chatgptAuthTokens/refresh",
    "currentTime/read",
    "item/tool/call"
  ]) {
    assert.equal(isWebUserServerRequest(method), false, method);
  }
});
