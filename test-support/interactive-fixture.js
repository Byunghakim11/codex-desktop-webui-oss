import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { installTestBridge } from "./install-test-bridge.js";
import { existsSync } from "node:fs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function queue() {
  const messages = [], waiters = [];
  return {
    push(message) {
      const index = waiters.findIndex(waiter => waiter.match(message));
      if (index >= 0) { const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(message); }
      else messages.push(message);
    },
    next(match, timeout = 12000) {
      const index = messages.findIndex(match);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(new Error("Fixture message timeout")); }, timeout);
        waiters.push(waiter);
      });
    }
  };
}

export async function startInteractiveFixture({ projectDir = rootDir, nativeChanges=[], threadListDelayMs=0, workflowFixture=false } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codex-webui-p0-"));
  const folderToken = `fixture-folder-${randomBytes(8).toString("hex")}`;
  const outsideToken = `fixture-outside-${randomBytes(8).toString("hex")}`;
  const token = `fixture-owner-${randomBytes(8).toString("hex")}`;
  const outside = path.join(dataDir, "outside"); await mkdir(outside);
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const pipe = process.platform === "win32" ? `\\\\.\\pipe\\codex-webui-p0-${process.pid}-${randomBytes(6).toString("hex")}` : path.join(dataDir, "bridge.sock");
  const native = process.platform === "win32" ? await installTestBridge(rootDir) : null;
  const env = {
    ...process.env,
    CODEX_WEBUI_DATA_DIR: dataDir,
    CODEX_WEBUI_TOKEN: token,
    CODEX_WEBUI_TOKEN_SCOPES: JSON.stringify([{ id: "folder", token: folderToken, cwd: projectDir }, { id: "outside", token: outsideToken, cwd: outside }]),
    CODEX_WEBUI_HOST_ADDRESS: "127.0.0.1", HOST: "127.0.0.1", PORT: String(port), CODEX_WEBUI_PORT: String(port), CODEX_WEBUI_TERMINAL_QR: "0",
    CODEX_WEBUI_DESKTOP_LIFECYCLE: "1", CODEX_DESKTOP_BRIDGE_PIPE: pipe,
    CODEX_DESKTOP_BRIDGE_CODEX_PATH: process.execPath,
    CODEX_DESKTOP_BRIDGE_CODEX_ARGS_JSON: JSON.stringify([path.join(rootDir, "test-support/fake-codex.js")]),
    FAKE_CODEX_P0_BROWSER: "1",
    FAKE_CODEX_PROJECT_DIR: projectDir,
    FAKE_CODEX_CHANGE_PATHS: JSON.stringify(nativeChanges),
    FAKE_CODEX_THREAD_LIST_DELAY_MS: String(threadListDelayMs),
    FAKE_CODEX_WORKFLOW_FIXTURE: workflowFixture ? "1" : "0",
    CODEX_WEBUI_PDFJS_ROOT: existsSync(path.join(rootDir,".superpowers/p2-dependencies/node_modules/pdfjs-dist"))?path.join(rootDir,".superpowers/p2-dependencies/node_modules/pdfjs-dist"):path.join(rootDir,"node_modules/pdfjs-dist"),
    ...(native ? { CODEX_WEBUI_PIPE_CLIENT_PATH: native.launcher } : {})
  };
  const broker = spawn(process.execPath, [path.join(rootDir, "server/desktop-broker.js"), "app-server", "--analytics-default-enabled"], { cwd: rootDir, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const desktop = queue(); let stderr = "", externalUi = null, controlId = 500, requestSequence = 1, closed = false;
  const sockets = new Set();
  readline.createInterface({ input: broker.stdout }).on("line", line => { try { desktop.push(JSON.parse(line)); } catch {} });
  broker.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });

  async function connect(clientToken = token) {
    const url = new URL(`ws://127.0.0.1:${port}/ws`); url.searchParams.set("token", clientToken);
    const socket = new WebSocket(url); const messages = queue(); sockets.add(socket);
    socket.on("error", () => {}); socket.on("message", data => messages.push(JSON.parse(data.toString()))); socket.on("close", () => sockets.delete(socket));
    const hello = await messages.next(message => message.type === "hello");
    async function send(type, payload, returnError = false) {
      const requestId = requestSequence++; socket.send(JSON.stringify({ type, requestId, ...payload }));
      const response = await messages.next(message => message.requestId === requestId && ["rpc-error", "rpc-result"].includes(message.type));
      if (!returnError && response.type === "rpc-error") throw Object.assign(new Error(response.error), { code: response.code });
      return returnError ? response : response.result;
    }
    return { socket, hello, next: messages.next, close: () => socket.terminate(), rpc: (method, params) => send("rpc", { method, params }), respond: (id, result, error = false) => send("server-response", { id, result }, error) };
  }

  async function ready() {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      try {
        const url = new URL(`http://127.0.0.1:${port}/api/info`); url.searchParams.set("token", token);
        const result = await fetch(url, { signal: AbortSignal.timeout(700) });
        if (result.ok) {
          const browser = await connect(); const connected = browser.hello.desktopBridgeConnected; browser.close();
          if (connected) return;
        }
      } catch {}
      await delay(100);
    }
    throw new Error(`Isolated WebUI failed to become ready. ${stderr.slice(-700)}`);
  }

  async function close() {
    if (closed) return; closed = true;
    for (const socket of sockets) socket.terminate();
    if (externalUi && externalUi.exitCode === null) externalUi.kill();
    const ended = broker.exitCode !== null ? Promise.resolve() : new Promise(resolve => broker.once("exit", resolve));
    broker.stdin.end(); await Promise.race([ended, delay(2000)]);
    if (broker.exitCode === null) broker.kill();
    await delay(150);
    const resolved = path.resolve(dataDir);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith("codex-webui-p0-")) throw new Error("Unsafe fixture cleanup path");
    await rm(resolved, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
    if (native) await native.cleanup();
  }

  try {
    broker.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: {} })}\n`);
    await desktop.next(message => message.id === 1 && !message.method); await ready();
  } catch (error) { await close(); throw error; }

  return {
    rootDir, dataDir, token, folderToken, outsideToken, port, broker,
    baseUrl: `http://127.0.0.1:${port}`,
    connect, close,
    async trigger({ id, method, params = {} }) {
      const control = controlId++;
      broker.stdin.write(`${JSON.stringify({ id: control, method: "trigger/server-request", params: { requestId: id, method, threadId: "thread-fixture", params } })}\n`);
      await desktop.next(message => message.id === control && !message.method);
      return desktop.next(message => message.id === id && message.method === method);
    },
    nextResponse: (id, timeout) => desktop.next(message => message.method === "test/server-response" && message.params.id === id, timeout).then(message => message.params),
    async notify(method, params) {
      const id = controlId++;
      broker.stdin.write(`${JSON.stringify({ id, method: "trigger/notification", params: { method, params } })}\n`);
      await desktop.next(message => message.id === id && !message.method);
    },
    respondNative(id, result) { broker.stdin.write(`${JSON.stringify({ id, result })}\n`); },
    async restartWebUi() {
      const ownedPid = Number(stderr.match(/Started Desktop-managed WebUI[^\n]*PID (\d+)/)?.[1]);
      if (!ownedPid) throw new Error("Owned fixture WebUI PID unavailable");
      process.kill(ownedPid); await delay(150);
      externalUi = spawn(process.execPath, [path.join(rootDir, "server/index.js")], { cwd: rootDir, env, windowsHide: true, stdio: "ignore" });
      await ready();
    }
  };
}
