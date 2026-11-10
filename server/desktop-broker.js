import { spawn } from "node:child_process";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { desktopBridgePipePath, ensureDesktopBridgeSecret } from "./desktop-bridge-common.js";
import { interactionKey } from "../public/interaction-contracts.js";
import { InteractionRegistry } from "./interaction-registry.js";

const PIPE_SOFT_BUFFER_BYTES=8*1048576;
const PIPE_HARD_BUFFER_BYTES=64*1048576;
const PIPE_DRAIN_TIMEOUT_MS=10000;
const pipePressure=new WeakMap();

const brokerDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(brokerDir, "..");
const desktopArgs = process.argv.slice(2);
const realCodex = resolveRealCodex();

if (!isPrimaryAppServerInvocation(desktopArgs)) {
  const child = spawn(realCodex.command, [...realCodex.prefixArgs, ...desktopArgs], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: childEnvironment()
  });
  bomStrippedStdin().pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.on("error", failFatal);
  child.on("exit", (code, signal) => process.exitCode = code ?? signalExitCode(signal));
} else {
  await runBroker();
}

async function runBroker() {
  const secret = await ensureDesktopBridgeSecret();
  const pipePath = desktopBridgePipePath();
  if (process.platform !== "win32" && existsSync(pipePath)) unlinkSync(pipePath);

  const child = spawn(realCodex.command, [...realCodex.prefixArgs, ...desktopArgs], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: childEnvironment()
  });
  const clients = new Set();
  const pending = new Map();
  const serverRequests = new Set();
  const interactions = new InteractionRegistry();
  const epoch = randomBytes(16).toString("hex");
  let managedWebUi = null;
  let lifecycleStartPromise = null;
  let markPipeReady;
  const pipeReady = new Promise((resolve) => markPipeReady = resolve);
  let nextInternalId = 1;
  const routeTtlMs = webUiRouteTtlMs();
  const webUiPendingLimit = 256;
  const childBufferLimitBytes = 1024 * 1024;
  let childStdinFailed = false;
  let childStdinBlocked = false;
  let desktopPausedForDrain=false;

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    socket.authenticated = false;
    const rl = readline.createInterface({ input: socket });
    rl.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        sendSocket(socket, { type: "bridge-error", error: "Invalid JSON" });
        return;
      }
      if (!socket.authenticated) {
        if (message.type !== "hello" || !sameSecret(message.token, secret)) {
          sendSocket(socket, { type: "hello", ok: false, error: "Unauthorized" });
          socket.end();
          return;
        }
        socket.authenticated = true;
        clients.add(socket);
        sendSocket(socket, { type: "hello", ok: true, hostRuntime: "windows", epoch, features:{abandon:true}, pendingServerRequests: interactions.snapshot() });
        return;
      }
      try {
        handleClientMessage(socket, message);
      } catch (error) {
        sendSocket(socket, { type: "bridge-error", error: "Bridge could not process the request" });
        process.stderr.write(`[codex-webui-bridge] Client message failed (${error?.code || "unknown"}).\n`);
      }
    });
    rl.on("error", (error) => {
      process.stderr.write(`[codex-webui-bridge] Client stream error (${error?.code || "unknown"}).\n`);
    });
    socket.on("error", (error) => {
      process.stderr.write(`[codex-webui-bridge] Client socket error (${error?.code || "unknown"}).\n`);
    });
    socket.on("close", () => {
      clients.delete(socket);
      for (const [id, route] of [...pending]) {
        if (route.socket === socket) dropRoute(id);
      }
    });
  });

  function handleClientMessage(socket, message) {
    if (message.type === "request") {
      if (!message.method) {
        sendSocket(socket, { type: "bridge-error", error: "Request method is required" });
        return;
      }
      if (webUiRouteCount() >= webUiPendingLimit) {
        sendRouteError(socket, message.requestId, "BRIDGE_OVERLOADED", "Desktop bridge is at its pending request limit");
        return;
      }
      if (childCongested(socket)) {
        sendRouteError(socket, message.requestId, "BRIDGE_BACKPRESSURE", "Desktop bridge is congested");
        return;
      }
      const id = nextInternalId++;
      const route = {
        destination: "webui",
        socket,
        originalId: message.requestId,
        method: message.method,
        timer: null
      };
      pending.set(id, route);
      route.timer = setTimeout(() => expireWebUiRoute(id), routeTtlMs);
      route.timer.unref?.();
      try {
        sendChild({ id, method: message.method, params: message.params || {} });
      } catch {
        dropRoute(id);
        sendRouteError(socket, message.requestId, "BRIDGE_UNAVAILABLE", "Desktop engine is unavailable");
      }
      return;
    }
    if (message.type === "abandon") {
      // Best-effort reply-route removal only: the engine operation is never cancelled or retried.
      if (message.requestId === undefined) return;
      let droppedRoute = false;
      for (const [id, route] of [...pending]) {
        if (route.destination === "webui" && route.socket === socket && route.originalId === message.requestId) {
          dropRoute(id);
          droppedRoute = true;
        }
      }
      if (droppedRoute) sendSocket(socket, { type: "abandon-ack", requestId: message.requestId });
      return;
    }
    if (message.type === "server-response") {
      let key;
      try { key = interactionKey(message.id); } catch { return; }
      if (!serverRequests.has(key)) {
        sendSocket(socket, {
          type: "response",
          requestId: message.requestId,
          error: { message: "Server request is no longer pending", code: "REQUEST_RESOLVED" }
        });
        return;
      }
      if (childStdinFailed || !child.stdin.writable) {
        sendSocket(socket, { type: "response", requestId: message.requestId, error: { message: "Desktop engine is unavailable", code: "BRIDGE_UNAVAILABLE" } });
        return;
      }
      let result;
      try { result = interactions.claim(message.id, message.result); }
      catch (error) {
        sendSocket(socket, { type: "response", requestId: message.requestId, error: { message: error.message, code: error.code || "INVALID_INTERACTION_RESPONSE" } });
        return;
      }
      serverRequests.delete(key);
      try { sendChild({ id: message.id, result }); }
      catch {
        broadcast({ type: "server-request-state", id: message.id, status: "uncertain" });
        sendSocket(socket, { type: "response", requestId: message.requestId, error: { message: "Response delivery could not be confirmed", code: "INTERACTION_UNCERTAIN" } });
        return;
      }
      broadcast({ type: "server-request-resolved", id: message.id });
      sendSocket(socket, { type: "response", requestId: message.requestId, result: {} });
      return;
    }
    sendSocket(socket, { type: "bridge-error", error: "Unknown bridge message type" });
  }

  function handleDesktopMessage(message) {
    if (message?.method === "initialize") {
      pipeReady.then(startManagedWebUiOnce).catch((error) => {
        process.stderr.write(`[codex-webui-bridge] WebUI lifecycle startup failed: ${error.message}\n`);
      });
    }
    if (message?.id !== undefined && message?.method) {
      const id = nextInternalId++;
      pending.set(id, {
        destination: "desktop",
        originalId: message.id,
        method: message.method,
        timer: null
      });
      try {
        sendChild({ ...message, id });
      } catch {
        pending.delete(id);
        writeDesktop({ id: message.id, error: { message: "Desktop engine is unavailable", code: "BRIDGE_UNAVAILABLE" } });
      }
      return;
    }
    if (message?.id !== undefined && !message?.method) {
      if (!serverRequests.delete(interactionKey(message.id))) {
        process.stderr.write(`[codex-webui-bridge] Ignored duplicate server response ${message.id}\n`);
        return;
      }
      interactions.resolve(message.id);
      broadcast({ type: "server-request-resolved", id: message.id });
    }
    sendChild(message);
  }

  function handleChildMessage(message) {
    if (message?.id !== undefined && !message?.method) {
      // Every id-without-method line is a terminal response to exactly one routed request.
      // Unmatched (late, abandoned, or expired) responses are dropped here and never
      // forwarded to Desktop or broadcast, so they cannot leak across channels.
      const route = pending.get(message.id);
      if (!route) {
        process.stderr.write("[codex-webui-bridge] Dropped engine response for an unknown or expired route.\n");
        return;
      }
      dropRoute(message.id);
      if (route.destination === "desktop") writeDesktop({ ...message, id: route.originalId });
      else sendSocket(route.socket, {
        type: "response",
        requestId: route.originalId,
        ...(message.error ? { error: message.error } : { result: message.result })
      });
      return;
    }
    if (message?.method === "serverRequest/resolved" && message.params?.requestId != null) {
      serverRequests.delete(interactionKey(message.params.requestId));
      interactions.resolve(message.params.requestId);
      broadcast({ type: "server-request-resolved", id: message.params.requestId });
    }
    if (message?.id !== undefined && message?.method) {
      serverRequests.add(interactionKey(message.id));
      for (const request of interactions.add(message)) broadcast({ type: "appserver", message: request });
    }
    for (const request of interactions.observe(message)) broadcast({ type: "appserver", message: request });
    writeDesktop(message);
    const visible = message?.id !== undefined && message?.method ? interactions.get(message.id) : null;
    broadcast({ type: "appserver", message: visible || message });
  }

  function sendChild(message) {
    if (childStdinFailed || !child.stdin.writable) throw new Error("Real Codex app-server is not writable");
    const accepted = child.stdin.write(`${JSON.stringify(message)}\n`);
    if (!accepted) {childStdinBlocked=true;if(!desktopPausedForDrain){desktopPausedForDrain=true;desktopInput.pause();}}
    return accepted;
  }

  function childCongested(socket) {
    const buffered = (child.stdin.writableLength || 0) + (socket?.writableLength || 0);
    // Desktop traffic is never throttled or dropped; only new WebUI requests are denied once the
    // bounded engine/client buffers are full. While write() has returned false we keep half the
    // budget free for drained writes so the buffer cannot grow without bound before "drain".
    return buffered >= (childStdinBlocked ? childBufferLimitBytes / 2 : childBufferLimitBytes);
  }

  function webUiRouteCount() {
    let count = 0;
    for (const route of pending.values()) if (route.destination === "webui") count += 1;
    return count;
  }

  function dropRoute(id) {
    const route = pending.get(id);
    if (!route) return null;
    pending.delete(id);
    if (route.timer) clearTimeout(route.timer);
    return route;
  }

  function expireWebUiRoute(id) {
    const route = pending.get(id);
    if (!route || route.destination !== "webui") return;
    dropRoute(id);
    // Expiry forgets only the reply route; the engine operation is never cancelled or retried.
    sendRouteError(route.socket, route.originalId, "BRIDGE_ROUTE_EXPIRED", "Desktop bridge stopped waiting for this response");
  }

  function sendRouteError(socket, requestId, code, message) {
    sendSocket(socket, { type: "response", requestId, error: { message, code } });
  }

  function writeDesktop(message) {
    if(!process.stdout.write(`${JSON.stringify(message)}\n`))child.stdout.pause();
  }

  function broadcast(message) {
    for (const socket of clients) sendSocket(socket, message);
  }

  function startManagedWebUiOnce() {
    if (lifecycleStartPromise) return lifecycleStartPromise;
    lifecycleStartPromise = startManagedWebUi().then((startedWebUi) => {
      if (closing && startedWebUi && !startedWebUi.killed) startedWebUi.kill("SIGTERM");
      else managedWebUi = startedWebUi;
      return startedWebUi;
    });
    return lifecycleStartPromise;
  }

  const desktopInput = bomStrippedStdin();
  const desktopLines = readline.createInterface({ input: desktopInput });
  desktopLines.on("line", (line) => {
    try {
      handleDesktopMessage(JSON.parse(line));
    } catch {
      process.stderr.write("[codex-webui-bridge] Could not process a Desktop message.\n");
    }
  });
  desktopLines.on("error", (error) => {
    process.stderr.write(`[codex-webui-bridge] Desktop input stream error (${error?.code || "unknown"}).\n`);
  });
  const childLines = readline.createInterface({ input: child.stdout });
  childLines.on("line", (line) => {
    let message;
    try {
      message=JSON.parse(line);
    } catch {
      if(!process.stdout.write(`${line}\n`))child.stdout.pause();
      return;
    }
    try{handleChildMessage(message);}catch{process.stderr.write("[codex-webui-bridge] Could not deliver an engine message.\n");}
  });
  childLines.on("error", (error) => {
    process.stderr.write(`[codex-webui-bridge] Engine output stream error (${error?.code || "unknown"}).\n`);
  });
  child.stdout.on("error", (error) => {
    process.stderr.write(`[codex-webui-bridge] Engine stdout error (${error?.code || "unknown"}).\n`);
  });
  child.stdin.on("error", (error) => {
    childStdinFailed = true;
    process.stderr.write(`[codex-webui-bridge] Real Codex stdin error (${error?.code || "unknown"}); new WebUI requests will be denied.\n`);
  });
  child.stdin.on("drain", () => {
    childStdinBlocked = false;
    if(desktopPausedForDrain){desktopPausedForDrain=false;desktopInput.resume();}
  });
  process.stdout.on("drain",()=>child.stdout.resume());
  process.stdout.on("error", (error) => {
    process.stderr.write(`[codex-webui-bridge] Desktop output stream error (${error?.code || "unknown"}).\n`);
  });
  child.stderr.pipe(process.stderr);

  server.on("error", failFatal);
  child.on("error", failFatal);
  let closing = false;

  const closeBroker = (code, signal) => {
    if (closing) return;
    closing = true;
    if (managedWebUi && !managedWebUi.killed) managedWebUi.kill("SIGTERM");
    broadcast({ type: "bridge-error", error: `Codex app-server exited (${code ?? signal ?? "unknown"})` });
    for (const socket of clients) socket.destroy();
    desktopInput.destroy();
    server.close(() => {
      if (signal) process.exit(signalExitCode(signal));
    });
    process.exitCode = code ?? signalExitCode(signal);
  };

  child.on("exit", closeBroker);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      child.kill(signal);
      closeBroker(null, signal);
    });
  }
  desktopInput.on("end", () => child.stdin.end());
  await new Promise((resolve, reject) => server.listen(pipePath, resolve).once("error", reject));
  markPipeReady();
}

async function startManagedWebUi() {
  if (!desktopWebUiLifecycleEnabled()) {
    process.stderr.write("[codex-webui-bridge] Desktop-managed WebUI startup is disabled.\n");
    return null;
  }

  const port = desktopWebUiPort();
  if (await isTcpPortListening(port)) {
    process.stderr.write(`[codex-webui-bridge] Port ${port} is already listening; preserving the existing service.\n`);
    return null;
  }

  const dataDir = resolveWebUiDataDir();
  mkdirSync(dataDir, { recursive: true });
  const outputFd = openSync(path.join(dataDir, "codex-webui.log"), "a");
  const errorFd = openSync(path.join(dataDir, "codex-webui.err.log"), "a");
  let webUi;
  try {
    webUi = spawn(process.execPath, [path.join(projectRoot, "server", "index.js")], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: String(process.env.CODEX_WEBUI_HOST_ADDRESS || "0.0.0.0"),
        CODEX_WEBUI_DATA_DIR: dataDir,
        CODEX_WEBUI_TERMINAL_QR: "0"
      },
      stdio: ["ignore", outputFd, errorFd],
      windowsHide: true
    });
  } finally {
    closeSync(outputFd);
    closeSync(errorFd);
  }
  webUi.on("error", (error) => {
    process.stderr.write(`[codex-webui-bridge] Failed to start WebUI: ${error.message}\n`);
  });
  webUi.on("exit", (code, signal) => {
    process.stderr.write(`[codex-webui-bridge] Managed WebUI exited (${code ?? signal ?? "unknown"}).\n`);
  });
  process.stderr.write(`[codex-webui-bridge] Started Desktop-managed WebUI on port ${port} (PID ${webUi.pid}).\n`);
  return webUi;
}

function desktopWebUiLifecycleEnabled() {
  const value = String(process.env.CODEX_WEBUI_DESKTOP_LIFECYCLE || "1").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(value);
}

function desktopWebUiPort() {
  const port = Number(process.env.CODEX_WEBUI_PORT || 9526);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid Codex WebUI port: ${process.env.CODEX_WEBUI_PORT}`);
  }
  return port;
}

function resolveWebUiDataDir() {
  const explicit = String(process.env.CODEX_WEBUI_DATA_DIR || "").trim();
  if (explicit) return path.resolve(explicit);
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "CodexWebUI");
}

function isTcpPortListening(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (listening) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

function isPrimaryAppServerInvocation(args) {
  const index = args.indexOf("app-server");
  return index >= 0
    && args.includes("--analytics-default-enabled")
    && !args.includes("--listen")
    && args[index + 1] !== "daemon"
    && args[index + 1] !== "proxy";
}

function resolveRealCodex() {
  const explicit = String(process.env.CODEX_DESKTOP_BRIDGE_CODEX_PATH || "").trim();
  const prefixArgs = parsePrefixArgs();
  if (explicit) return { command: explicit, prefixArgs };
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const root = path.join(localAppData, "OpenAI", "Codex", "bin");
    try {
      const command = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(root, entry.name, "codex.exe"))
        .filter((candidate) => existsSync(candidate))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
      if (command) return { command, prefixArgs };
    } catch {
      // Fall through to PATH.
    }
  }
  return { command: "codex", prefixArgs };
}

function parsePrefixArgs() {
  const raw = String(process.env.CODEX_DESKTOP_BRIDGE_CODEX_ARGS_JSON || "").trim();
  if (!raw) return [];
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("CODEX_DESKTOP_BRIDGE_CODEX_ARGS_JSON must be a JSON string array");
  }
  return value;
}

function childEnvironment() {
  const env = { ...process.env };
  delete env.CODEX_CLI_PATH;
  delete env.CODEX_DESKTOP_BRIDGE_HOST;
  delete env.CODEX_DESKTOP_BRIDGE_HOST_OVERRIDE;
  delete env.CODEX_DESKTOP_BRIDGE_TRANSPORT;
  delete env.CODEX_DESKTOP_BRIDGE_PORT;
  delete env.CODEX_DESKTOP_BRIDGE_PIPE;
  delete env.CODEX_DESKTOP_BRIDGE_CODEX_PATH;
  delete env.CODEX_DESKTOP_BRIDGE_CODEX_ARGS_JSON;
  return env;
}

function bomStrippedStdin() {
  let firstChunk = true;
  const transform = new Transform({
    transform(chunk, encoding, callback) {
      let next = chunk;
      if (firstChunk) {
        firstChunk = false;
        if (next.length >= 3 && next[0] === 0xef && next[1] === 0xbb && next[2] === 0xbf) {
          next = next.subarray(3);
        }
      }
      callback(null, next);
    }
  });
  process.stdin.pipe(transform);
  return transform;
}

function webUiRouteTtlMs() {
  // Production routing TTL is three minutes (>= 120s). Tests may shorten it explicitly.
  const override = process.env.CODEX_DESKTOP_BRIDGE_TESTING === "1"
    ? Number(process.env.CODEX_DESKTOP_BRIDGE_TEST_ROUTE_TTL_MS)
    : NaN;
  return Number.isFinite(override) && override > 0 ? override : 180000;
}

function sameSecret(value, expected) {
  const left = Buffer.from(String(value || ""));
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sendSocket(socket, message) {
  if (!socket?.writable)return false;
  const line=`${JSON.stringify(message)}\n`;
  if((socket.writableLength||0)+Buffer.byteLength(line)>PIPE_HARD_BUFFER_BYTES){socket.destroy();return false;}
  try{
    const accepted=socket.write(line);
    if(!accepted&&(socket.writableLength||0)>PIPE_SOFT_BUFFER_BYTES)watchSocketDrain(socket);
    return accepted;
  }catch{socket.destroy();return false;}
}

function watchSocketDrain(socket){
  if(pipePressure.has(socket))return;
  const cleanup=()=>{const record=pipePressure.get(socket);if(!record)return;clearTimeout(record.timer);socket.off("drain",cleanup);socket.off("close",cleanup);pipePressure.delete(socket);};
  const timer=setTimeout(()=>{const stalled=(socket.writableLength||0)>PIPE_SOFT_BUFFER_BYTES;cleanup();if(stalled)socket.destroy();},PIPE_DRAIN_TIMEOUT_MS);
  timer.unref?.();pipePressure.set(socket,{timer});socket.once("drain",cleanup);socket.once("close",cleanup);
}

function signalExitCode(signal) {
  return signal ? 1 : 0;
}

function failFatal(error) {
  process.stderr.write(`[codex-webui-bridge] ${error?.stack || error}\n`);
  process.exit(1);
}
