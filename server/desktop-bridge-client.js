import net from "node:net";
import readline from "node:readline";
import { desktopBridgePipePath, ensureDesktopBridgeSecret } from "./desktop-bridge-common.js";
import { VerifiedPipeTransport } from "./verified-pipe-transport.js";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_PENDING_REQUESTS = 256;
const DEFAULT_MAX_WRITE_BUFFER_BYTES = 2 * 1024 * 1024;

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function createDefaultTransport(pipePath) {
  return process.platform === "win32"
    ? new VerifiedPipeTransport(pipePath)
    : net.createConnection(pipePath);
}

function noop() {}

export class DesktopBridgeConnection {
  constructor({
    onAppServerMessage,
    onError,
    onServerRequestResolved,
    onStatus,
    onPendingRequests,
    resolvePipePath = desktopBridgePipePath,
    resolveSecret = ensureDesktopBridgeSecret,
    createSocket,
    transportFactory,
    handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxPendingRequests = DEFAULT_MAX_PENDING_REQUESTS,
    maxWriteBufferBytes = DEFAULT_MAX_WRITE_BUFFER_BYTES
  } = {}) {
    this.onAppServerMessage = onAppServerMessage || (() => {});
    this.onError = onError || (() => {});
    this.onServerRequestResolved = onServerRequestResolved || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onPendingRequests = onPendingRequests || (() => {});
    this.resolvePipePath = resolvePipePath;
    this.resolveSecret = resolveSecret;
    this.createSocket = createSocket || transportFactory || createDefaultTransport;
    this.handshakeTimeoutMs = positiveNumber(handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS);
    this.requestTimeoutMs = positiveNumber(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.maxPendingRequests = Math.max(1, Math.floor(positiveNumber(maxPendingRequests, DEFAULT_MAX_PENDING_REQUESTS)));
    this.maxWriteBufferBytes = Math.max(1, Math.floor(positiveNumber(maxWriteBufferBytes, DEFAULT_MAX_WRITE_BUFFER_BYTES)));
    this.socket = null;
    this.connecting = null;
    this.authenticated = false;
    this.nextId = 1;
    this.pending = new Map();
    this.supportsAbandon = false;
  }

  connect() {
    if (this.socket?.writable && this.authenticated) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const promise = this.connectOnce().finally(() => {
      if (this.connecting === promise) this.connecting = null;
    });
    this.connecting = promise;
    return promise;
  }

  connectOnce() {
    const attempt = {
      failed: false,
      settled: false,
      socket: null,
      readline: null,
      handlers: null,
      timer: null,
      resolve: null,
      reject: null,
      promise: null
    };
    attempt.promise = new Promise((resolve, reject) => {
      attempt.resolve = resolve;
      attempt.reject = reject;
    });
    attempt.timer = setTimeout(() => {
      this.failAttempt(attempt, Object.assign(
        new Error(`Desktop bridge handshake timed out after ${this.handshakeTimeoutMs}ms`),
        { code: "BRIDGE_HANDSHAKE_TIMEOUT" }
      ));
    }, this.handshakeTimeoutMs);
    attempt.timer.unref?.();
    this.runHandshake(attempt).catch((error) => this.failAttempt(attempt, error));
    return attempt.promise;
  }

  async runHandshake(attempt) {
    const secret = await this.resolveSecret();
    if (attempt.failed) return;
    const pipePath = this.resolvePipePath();
    if (attempt.failed) return;
    const socket = this.createSocket(pipePath);
    if (attempt.failed) {
      this.destroyTransport(socket);
      return;
    }
    if (!socket) throw new Error("Desktop bridge transport is unavailable");
    attempt.socket = socket;
    this.socket = socket;
    if (typeof socket.setNoDelay === "function") socket.setNoDelay(true);
    this.attachHandshake(attempt, socket, secret);
  }

  attachHandshake(attempt, socket, secret) {
    const isCurrent = () => !attempt.failed && this.socket === socket;
    const onError = (error) => {
      if (!isCurrent()) return;
      const normalized = normalizeError(error);
      if (!attempt.settled) this.failAttempt(attempt, normalized);
      this.onError(normalized);
    };
    const onClose = () => {
      if (this.socket !== socket) return;
      if (!attempt.settled) {
        this.failAttempt(attempt, new Error("Desktop bridge closed before authentication"));
        return;
      }
      this.handleDisconnect(attempt, socket);
    };
    const onConnect = () => {
      if (!isCurrent() || attempt.settled) return;
      try {
        this.writeLine(socket, `${JSON.stringify({ type: "hello", token: secret })}\n`);
      } catch (error) {
        this.failAttempt(attempt, error);
      }
    };
    const rl = readline.createInterface({ input: socket });
    const onLine = (line) => {
      if (!isCurrent()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.type === "hello") {
        if (attempt.settled) return;
        if (!message.ok) {
          this.failAttempt(attempt, Object.assign(
            new Error(message.error || "Desktop bridge authentication failed"),
            { code: "BRIDGE_AUTH_FAILED" }
          ));
          return;
        }
        this.succeedAttempt(attempt, message);
        return;
      }
      if (!attempt.settled) return;
      this.handleMessage(message);
    };
    const onLineError = (error) => {
      if (!isCurrent()) return;
      if (!attempt.settled) this.failAttempt(attempt, normalizeError(error));
      else this.onError(normalizeError(error));
    };
    attempt.handlers = { onError, onClose, onConnect, onLine, onLineError };
    attempt.readline = rl;
    socket.on("error", onError);
    socket.once("close", onClose);
    socket.once("connect", onConnect);
    rl.on("line", onLine);
    rl.on("error", onLineError);
  }

  succeedAttempt(attempt, message) {
    if (attempt.failed || attempt.settled) return;
    attempt.settled = true;
    this.clearAttemptTimer(attempt);
    this.setAuthenticated(true);
    this.supportsAbandon=message.features?.abandon===true;
    if (Array.isArray(message.pendingServerRequests)) {
      this.onPendingRequests({ epoch: message.epoch || null, requests: message.pendingServerRequests });
    }
    attempt.resolve(message);
  }

  failAttempt(attempt, error) {
    if (attempt.failed) return;
    attempt.failed = true;
    this.clearAttemptTimer(attempt);
    const socket = attempt.socket;
    attempt.socket = null;
    this.detachAttempt(attempt, socket);
    if (socket) {
      const wasCurrent = this.socket === socket;
      if (wasCurrent) this.socket = null;
      if (typeof socket.on === "function") socket.on("error", noop);
      this.destroyTransport(socket);
      if (wasCurrent) this.setAuthenticated(false);
    } else if (!this.socket) {
      this.setAuthenticated(false);
    }
    attempt.reject(normalizeError(error));
  }

  detachAttempt(attempt, socket) {
    this.clearAttemptTimer(attempt);
    const rl = attempt.readline;
    attempt.readline = null;
    if (rl) {
      const handlers = attempt.handlers;
      if (handlers) {
        rl.removeListener("line", handlers.onLine);
        rl.removeListener("error", handlers.onLineError);
      }
      try { rl.close(); } catch {}
    }
    if (socket && attempt.handlers) {
      socket.removeListener("error", attempt.handlers.onError);
      socket.removeListener("close", attempt.handlers.onClose);
      socket.removeListener("connect", attempt.handlers.onConnect);
    }
  }

  clearAttemptTimer(attempt) {
    if (attempt.timer) {
      clearTimeout(attempt.timer);
      attempt.timer = null;
    }
  }

  destroyTransport(socket) {
    try { socket?.destroy?.(); } catch {}
  }

  writeLine(socket, line) {
    if (!socket?.writable) throw new Error("Desktop bridge is unavailable");
    const buffered = Number.isFinite(socket.writableLength) ? socket.writableLength : 0;
    if (buffered + Buffer.byteLength(line) > this.maxWriteBufferBytes) {
      throw Object.assign(
        new Error("Desktop bridge write buffer limit reached"),
        { code: "BRIDGE_WRITE_BACKPRESSURE" }
      );
    }
    socket.write(line);
  }

  handleDisconnect(attempt, socket) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.detachAttempt(attempt, socket);
    if (typeof socket.on === "function") socket.on("error", noop);
    this.destroyTransport(socket);
    const error = new Error("Desktop bridge disconnected");
    this.rejectAllPending(error);
    this.setAuthenticated(false);
    this.onError(error);
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

  assertPendingCapacity() {
    if (this.pending.size >= this.maxPendingRequests) {
      throw Object.assign(
        new Error(`Desktop bridge pending request limit reached (${this.maxPendingRequests})`),
        { code: "BRIDGE_PENDING_LIMIT" }
      );
    }
  }

  rejectPending(requestId, error) {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  rejectAllPending(error) {
    for (const [requestId, pending] of Array.from(this.pending.entries())) {
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(pending.kind==="response"&&pending.transmitted?Object.assign(new Error("Response delivery could not be confirmed"),{code:"INTERACTION_UNCERTAIN"}):error);
    }
  }

  timeoutPending(requestId) {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    const error = pending.kind === "response"
      ? Object.assign(new Error("Response delivery could not be confirmed"), { code: "INTERACTION_UNCERTAIN" })
      : Object.assign(new Error(`Timed out waiting for ${pending.method}`), { code: "REQUEST_TIMEOUT" });
    this.rejectPending(requestId, error);
    if (pending.kind === "request") this.sendAbandon(requestId);
  }

  sendAbandon(requestId) {
    const socket = this.socket;
    if (!socket?.writable || !this.authenticated || !this.supportsAbandon) return;
    try {
      this.writeLine(socket, `${JSON.stringify({ type: "abandon", requestId })}\n`);
    } catch {
      // Best effort only; never retry and never cancel the engine command.
    }
  }

  async request(method, params = {}) {
    await this.connect();
    this.assertPendingCapacity();
    const requestId = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.timeoutPending(requestId), this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer, kind: "request", method });
    });
    try { this.sendLine({ type: "request", requestId, method, params }); }
    catch (error) { this.rejectPending(requestId, error); }
    return promise;
  }

  async respond(id, result) {
    await this.connect();
    this.assertPendingCapacity();
    const requestId = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.timeoutPending(requestId), this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer, kind: "response",transmitted:false });
    });
    try { this.sendLine({ type: "server-response", requestId, id, result });const pending=this.pending.get(requestId);if(pending)pending.transmitted=true; }
    catch (error) { this.rejectPending(requestId, error); }
    return promise;
  }

  sendLine(message) {
    if (!this.socket?.writable || !this.authenticated) throw new Error("Desktop bridge is unavailable");
    this.writeLine(this.socket, `${JSON.stringify(message)}\n`);
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
