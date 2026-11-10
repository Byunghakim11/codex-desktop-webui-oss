import { isHumanInteractionMethod } from "./interaction-contracts.js";

export function isWebUserApproval(method) {
  return isHumanInteractionMethod(method);
}
