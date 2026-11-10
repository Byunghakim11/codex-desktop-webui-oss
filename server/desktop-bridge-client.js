import net from "node:net";
import readline from "node:readline";
import { desktopBridgePipePath, ensureDesktopBridgeSecret } from "./desktop-bridge-common.js";
import { VerifiedPipeTransport } from "./verified-pipe-transport.js";

export class DesktopBridgeConnection {
  constructor({
    onAppServerMessage,
    onError,
    onServerRequestResolved,
    onStatus,
    onPendingRequests,
    resolvePipePath = desktopBridgePipePath,
    resolveSecret = ensureDesktopBridgeSecret
  } = {}) {
    this.onAppServerMessage = onAppServerMessage || (() => {});
    this.onError = onError || (() => {});
    this.onServerRequestResolved = onServerRequestResolved || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onPendingRequests = onPendingRequests || (() => {});
    this.resolvePipePath = resolvePipePath;
    this.resolveSecret = resolveSecret;
    this.socket = null;
    this.connecting = null;
    this.authenticated = false;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    if (this.socket?.writable && this.authenticated) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectOnce().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async connectOnce() {
    const secret = await this.resolveSecret();
    const pipePath = this.resolvePipePath();
    const socket = process.platform === "win32"
      ? new VerifiedPipeTransport(pipePath)
      : net.createConnection(pipePath);
    socket.setNoDelay(true);
    this.socket = socket;

    const hello = new Promise((resolve, reject) => {
      const fail = (error) => {
        reject(error instanceof Error ? error : new Error(String(error)));
        socket.destroy();
      };
      const closed = () => fail(new Error("Desktop bridge closed before authentication"));
      socket.once("error", fail);
      socket.once("close", closed);
      socket.once("connect", () => socket.write(`${JSON.stringify({ type: "hello", token: secret })}\n`));
      const rl = readline.createInterface({ input: socket });
      rl.on("error", (error) => {
        if (this.authenticated) this.onError(error);
        else fail(error);
      });
      rl.on("line", (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (message.type === "hello") {
          socket.off("error", fail);
          socket.off("close", closed);
          if (message.ok) {
            this.setAuthenticated(true);
            if (Array.isArray(message.pendingServerRequests)) this.onPendingRequests({ epoch: message.epoch || null, requests: message.pendingServerRequests });
            resolve(message);
          }
          else reject(new Error(message.error || "Desktop bridge authentication failed"));
          return;
        }
        this.handleMessage(message);
      });
    });

    socket.on("error", (error) => this.onError(error));
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setAuthenticated(false);
      const error = new Error("Desktop bridge disconnected");
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
      this.onError(error);
    });
    await hello;
  }

  handleMessage(message) {
    if (message.type === "response" && this.pending.has(message.requestId)) {
      const pending = this.pending.get(message.requestId);
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message || String(message.error)), { code: message.error.code }));
      else pending.resolve(message.result);
      return;
    }
    if (message.type === "appserver") {
      if (message.message?.method === "serverRequest/resolved" && message.message.params?.requestId != null) this.onServerRequestResolved(message.message.params.requestId);
      this.onAppServerMessage(message.message);
    }
    if (message.type === "server-request-resolved") this.onServerRequestResolved(message.id);
    if (message.type === "bridge-error") this.onError(new Error(message.error || "Desktop bridge error"));
  }

  async request(method, params = {}) {
    await this.connect();
    const requestId = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 120000).unref();
      this.pending.set(requestId, { resolve, reject, timer });
    });
    try { this.sendLine({ type: "request", requestId, method, params }); }
    catch(error){const pending=this.pending.get(requestId);clearTimeout(pending?.timer);this.pending.delete(requestId);pending?.reject(error);}
    return promise;
  }

  async respond(id, result) {
    await this.connect();
    const requestId = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        reject(Object.assign(new Error("Response delivery could not be confirmed"), { code: "INTERACTION_UNCERTAIN" }));
      }, 120000).unref();
      this.pending.set(requestId, { resolve, reject, timer });
    });
    try { this.sendLine({ type: "server-response", requestId, id, result }); }
    catch(error){const pending=this.pending.get(requestId);clearTimeout(pending?.timer);this.pending.delete(requestId);pending?.reject(error);}
    return promise;
  }

  sendLine(message) {
    if (!this.socket?.writable || !this.authenticated) throw new Error("Desktop bridge is unavailable");
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  isConnected() {
    return Boolean(this.socket?.writable && this.authenticated);
  }

  setAuthenticated(value) {
    const next = Boolean(value);
    if (this.authenticated === next) return;
    this.authenticated = next;
    this.onStatus(next);
  }
}
