import assert from "node:assert/strict";
import test from "node:test";
import { isWebUserApproval } from "../public/approval-policy.js";

test("browser rejects Desktop-only server requests even with an older WebUI server", () => {
  assert.equal(isWebUserApproval("item/commandExecution/requestApproval"), true);
  assert.equal(isWebUserApproval("item/fileChange/requestApproval"), true);
  assert.equal(isWebUserApproval("item/tool/requestUserInput"), true);
  assert.equal(isWebUserApproval("item/permissions/requestApproval"), true);
  assert.equal(isWebUserApproval("mcpServer/elicitation/request"), true);
  assert.equal(isWebUserApproval("attestation/generate"), false);
  assert.equal(isWebUserApproval("account/chatgptAuthTokens/refresh"), false);
  assert.equal(isWebUserApproval("item/tool/call"), false);
});
