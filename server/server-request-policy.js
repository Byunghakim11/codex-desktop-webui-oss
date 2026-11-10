import { isHumanInteractionMethod } from "../public/interaction-contracts.js";

export function isWebUserServerRequest(method) {
  return isHumanInteractionMethod(method);
}
