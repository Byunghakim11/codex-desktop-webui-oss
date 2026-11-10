import { interactionKey, publicInteractionRequest, validateInteractionResponse } from "../public/interaction-contracts.js";

function failure(code, message) { return Object.assign(new Error(message), { code }); }

// HTTP clients are not the authority for a response claim. Keep local pending
// state until broker confirmation; never re-arm a possibly delivered response.
export class InteractionSession {
  constructor({ sendResponse, onUpdate = () => {} }) {
    this.sendResponse = sendResponse;
    this.onUpdate = onUpdate;
    this.requests = new Map();
    this.inFlight = new Set();
    this.uncertain = new Set();
    this.verified = new Set();
    this.resolved = new Set();
    this.connected = false;
    this.authoritative = false;
    this.epoch = null;
  }

  receive(raw) {
    const request = publicInteractionRequest(raw);
    if (!request) return;
    const key = interactionKey(request.id);
    if (this.resolved.has(key)) return;
    this.requests.set(key, request);
    this.verified.add(key);
    this.onUpdate({ type: "server-request", request }, request);
  }

  resolve(id) {
    const key = interactionKey(id);
    const request = this.requests.get(key);
    this.requests.delete(key);
    this.inFlight.delete(key);
    this.uncertain.delete(key);
    this.verified.delete(key);
    this.resolved.add(key);
    if (this.resolved.size > 512) this.resolved.delete(this.resolved.values().next().value);
    this.onUpdate({ type: "server-request-resolved", id }, request);
  }

  state(id) {
    const key = interactionKey(id);
    if (!this.requests.has(key)) return "resolved";
    if (this.uncertain.has(key)) return "uncertain";
    if (this.inFlight.has(key)) return "submitting";
    return this.connected && this.verified.has(key) ? "pending" : "unverified";
  }

  setConnected(connected) {
    this.connected = Boolean(connected);
    if (!connected) {
      for (const key of this.inFlight) this.uncertain.add(key);
      this.verified.clear();
      this.authoritative = false;
    }
    this.onUpdate({ type: "interaction-snapshot-changed" });
  }

  reconcile({ epoch, requests }) {
    if (!Array.isArray(requests)) return;
    if (this.epoch !== null && epoch !== this.epoch) {
      this.requests.clear(); this.inFlight.clear(); this.uncertain.clear(); this.verified.clear(); this.resolved.clear();
    }
    this.epoch = epoch ?? this.epoch;
    this.authoritative = true;
    const incoming = new Set(requests.map(request => interactionKey(request.id)));
    for (const request of [...this.requests.values()]) if (!incoming.has(interactionKey(request.id))) this.resolve(request.id);
    for (const request of requests) this.receive(request);
    this.onUpdate({ type: "interaction-snapshot-changed" });
  }

  snapshot() {
    return {
      epoch: this.epoch,
      authoritative: this.authoritative,
      requests: structuredClone([...this.requests.values()]),
      states: [...this.requests.values()].map(request => ({ id: request.id, status: this.state(request.id) }))
    };
  }

  async submit(id, response) {
    const key = interactionKey(id);
    const request = this.requests.get(key);
    if (!request) throw failure("REQUEST_RESOLVED", "Server request is no longer pending");
    if (this.uncertain.has(key)) throw failure("INTERACTION_UNCERTAIN", "Check Desktop: response delivery is uncertain");
    if (this.inFlight.has(key)) throw failure("INTERACTION_IN_PROGRESS", "A response is already being submitted");
    if (!this.connected || !this.verified.has(key)) throw failure("BRIDGE_UNAVAILABLE", "Pending request must be verified after reconnect");
    const validated = validateInteractionResponse(request, response);
    this.inFlight.add(key);
    this.onUpdate({ type: "server-request-state", id, status: "submitting" }, request);
    try {
      const result = await this.sendResponse(id, validated);
      if (this.requests.has(key)) this.resolve(id);
      return result;
    } catch (error) {
      if (error.code === "REQUEST_RESOLVED") this.resolve(id);
      else if (this.requests.has(key)) {
        if (error.code !== "INVALID_INTERACTION_RESPONSE") this.uncertain.add(key);
        this.inFlight.delete(key);
        this.onUpdate({ type: "server-request-state", id, status: this.state(id) }, request);
      }
      throw error;
    } finally {
      this.inFlight.delete(key);
    }
  }
}
