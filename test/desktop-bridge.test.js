import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync as fsRealPath } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test, { before, after } from "node:test";
import { installTestBridge } from "../test-support/install-test-bridge.js";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(testDir, "..");
const brokerPath = path.join(rootDir, "server", "desktop-broker.js");
const fakeCodexPath = path.join(rootDir, "test-support", "fake-codex.js");

let verifiedPipeFixture;
before(async () => {
  if (process.platform !== "win32") return;
  verifiedPipeFixture = await installTestBridge(rootDir);
  process.env.CODEX_WEBUI_PIPE_CLIENT_PATH = verifiedPipeFixture.launcher;
});
after(async () => { if (verifiedPipeFixture) await verifiedPipeFixture.cleanup(); });

test("desktop broker multiplexes Desktop and WebUI over one app-server", { timeout: 20000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codex-webui-bridge-test-"));
  const pipe = process.platform === "win32"
    ? `\\\\.\\pipe\\codex-webui-test-${process.pid}-${randomBytes(6).toString("hex")}`
    : path.join(dataDir, "bridge.sock");
  const broker = spawn(process.execPath, [brokerPath, "app-server", "--analytics-default-enabled"], {
    cwd: rootDir,
    env: {
      ...process.env,
      CODEX_WEBUI_DATA_DIR: dataDir,
      CODEX_WEBUI_DESKTOP_LIFECYCLE: "0",
      CODEX_DESKTOP_BRIDGE_PIPE: pipe,
      CODEX_DESKTOP_BRIDGE_CODEX_PATH: process.execPath,
      CODEX_DESKTOP_BRIDGE_CODEX_ARGS_JSON: JSON.stringify([fakeCodexPath])
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(async () => {
    broker.kill();
    await rm(dataDir, { recursive: true, force: true });
  });

  let stderr = "";
  broker.stderr.on("data", (chunk) => stderr += chunk.toString("utf8"));
  const desktop = lineQueue(broker.stdout);

  broker.stdin.write(`${JSON.stringify({ id: 7, method: "initialize", params: {} })}\n`);
  const initialize = await desktop.next((message) => message.id === 7);
  assert.deepEqual(initialize.result, { server: "fake" });

  const secret = (await waitForRead(path.join(dataDir, "desktop-bridge", "secret"))).trim();
  const unauthorized = await connectLines(pipe);
  unauthorized.send({ type: "hello", token: "wrong" });
  assert.equal((await unauthorized.next((message) => message.type === "hello")).ok, false);
  unauthorized.socket.destroy();

  const web = await connectLines(pipe);
  web.send({ type: "hello", token: secret });
  assert.equal((await web.next((message) => message.type === "hello")).ok, true);

  broker.stdin.write(`${JSON.stringify({ id: 11, method: "echo", params: { source: "desktop" } })}\n`);
  web.send({ type: "request", requestId: 11, method: "echo", params: { source: "webui" } });
  const [desktopEcho, webEcho] = await Promise.all([
    desktop.next((message) => message.id === 11),
    web.next((message) => message.type === "response" && message.requestId === 11)
  ]);
  assert.equal(desktopEcho.result.params.source, "desktop");
  assert.equal(webEcho.result.params.source, "webui");

  web.send({
    type: "request",
    requestId: 12,
    method: "turn/start",
    params: { threadId: "thread-B", input: [{ type: "text", text: "hello" }] }
  });
  const turnResponse = await web.next((message) => message.type === "response" && message.requestId === 12);
  assert.equal(turnResponse.result.turn.id, "turn-thread-B");
  const [desktopTurn, webTurn] = await Promise.all([
    desktop.next((message) => message.method === "turn/started"),
    web.next((message) => message.type === "appserver" && message.message?.method === "turn/started")
  ]);
  assert.equal(desktopTurn.params.threadId, "thread-B");
  assert.equal(webTurn.message.params.threadId, "thread-B");

  web.send({ type: "request", requestId: 13, method: "trigger/server-request", params: { threadId: "thread-B" } });
  await web.next((message) => message.type === "response" && message.requestId === 13);
  const [desktopServerRequest, webServerRequest] = await Promise.all([
    desktop.next((message) => message.id === 900 && message.method),
    web.next((message) => message.type === "appserver" && message.message?.id === 900)
  ]);
  assert.equal(desktopServerRequest.params.threadId, "thread-B");
  assert.equal(webServerRequest.message.params.threadId, "thread-B");

  const replay = await connectLines(pipe);
  replay.send({ type: "hello", token: secret });
  const replayHello = await replay.next(message => message.type === "hello");
  assert.equal(typeof replayHello.epoch, "string");
  assert.equal(replayHello.pendingServerRequests[0].id, 900);
  web.send({ type: "server-response", requestId: 140, id: 900, result: { injected: true } });
  assert.equal((await web.next(message => message.type === "response" && message.requestId === 140)).error.code, "INVALID_INTERACTION_RESPONSE");
  web.send({ type: "server-response", requestId: 14, id: 900, result: { answers: { reply: { answers: ["phone"] } } } });
  const webResolved = await web.next((message) => message.type === "server-request-resolved" && message.id === 900);
  assert.equal(webResolved.id, 900);
  assert.deepEqual((await web.next((message) => message.type === "response" && message.requestId === 14)).result, {});
  assert.equal((await desktop.next((message) => message.method === "test/server-response")).params.result.answers.reply.answers[0], "phone");
  replay.send({ type: "server-response", requestId: 141, id: 900, result: { answers: {} } });
  assert.equal((await replay.next(message => message.type === "response" && message.requestId === 141)).error.code, "REQUEST_RESOLVED");

  broker.stdin.write(`${JSON.stringify({ id: 900, result: { answer: "duplicate" } })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match(stderr, /Ignored duplicate server response 900/);

  web.send({
    type: "request",
    requestId: 15,
    method: "trigger/server-request",
    params: { threadId: "thread-B", requestId: 901, method: "attestation/generate" }
  });
  await web.next((message) => message.type === "response" && message.requestId === 15);
  await desktop.next((message) => message.id === 901 && message.method === "attestation/generate");
  broker.stdin.write(`${JSON.stringify({ id: 901, result: { token: "desktop-token" } })}\n`);
  const desktopResolved = await web.next(
    (message) => message.type === "server-request-resolved" && message.id === 901
  );
  assert.equal(desktopResolved.id, 901);
  web.send({ type: "request", requestId: 16, method: "trigger/server-request", params: { threadId: "thread-B", requestId: 0, method: "item/commandExecution/requestApproval" } });
  await web.next(message => message.type === "appserver" && message.message?.id === 0);
  web.send({ type: "request", requestId: 17, method: "trigger/resolve-server-request", params: { requestId: 0 } });
  await web.next(message => message.type === "server-request-resolved" && message.id === 0);
  web.send({ type: "server-response", requestId: 18, id: 0, result: { decision: "accept" } });
  assert.equal((await web.next(message => message.type === "response" && message.requestId === 18)).error.code, "REQUEST_RESOLVED");
  replay.socket.destroy();
  web.socket.destroy();
});

test("Desktop broker starts one managed WebUI and stops it with the broker", { timeout: 30000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codex-webui-lifecycle-test-"));
  const pipe = process.platform === "win32"
    ? `\\\\.\\pipe\\codex-webui-lifecycle-${process.pid}-${randomBytes(6).toString("hex")}`
    : path.join(dataDir, "bridge.sock");
  const port = await freePort();
  const token = `lifecycle-${randomBytes(12).toString("hex")}`;
  const broker = spawn(process.execPath, [brokerPath, "app-server", "--analytics-default-enabled"], {
    cwd: rootDir,
    env: {
      ...process.env,
      CODEX_WEBUI_DATA_DIR: dataDir,
      CODEX_WEBUI_DESKTOP_LIFECYCLE: "1",
      CODEX_WEBUI_TOKEN: token,
      CODEX_WEBUI_TERMINAL_QR: "0",
      CODEX_DESKTOP_BRIDGE_PIPE: pipe,
      CODEX_DESKTOP_BRIDGE_CODEX_PATH: process.execPath,
      CODEX_DESKTOP_BRIDGE_CODEX_ARGS_JSON: JSON.stringify([fakeCodexPath]),
      CODEX_WEBUI_HOST_ADDRESS: "127.0.0.1",
      CODEX_WEBUI_PORT: String(port)
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(async () => {
    if (broker.exitCode === null) broker.kill();
    await removeWithRetry(dataDir);
  });
  let stderr = "";
  broker.stderr.on("data", (chunk) => stderr += chunk.toString("utf8"));
  const desktop = lineQueue(broker.stdout);
  broker.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: {} })}\n`);
  await desktop.next((message) => message.id === 1);

  const info = await waitForHttp(`http://127.0.0.1:${port}/api/info?token=${encodeURIComponent(token)}`);
  assert.equal(info.bridgeMode, "desktop");
  await waitForText(() => stderr, /Started Desktop-managed WebUI/);

  const exited = new Promise((resolve) => broker.once("exit", resolve));
  broker.kill();
  await exited;
  await waitForPortClosed(port);
  assert.equal(await canConnectToPort(port), false);
});

test("Desktop broker preserves an already-listening external service", { timeout: 20000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codex-webui-existing-service-test-"));
  const pipe = process.platform === "win32"
    ? `\\\\.\\pipe\\codex-webui-existing-${process.pid}-${randomBytes(6).toString("hex")}`
    : path.join(dataDir, "bridge.sock");
  const external = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.end("external");
  });
  await new Promise((resolve, reject) => external.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = external.address().port;
  const broker = spawn(process.execPath, [brokerPath, "app-server", "--analytics-default-enabled"], {
    cwd: rootDir,
    env: {
      ...process.env,
      CODEX_WEBUI_DATA_DIR: dataDir,
      CODEX_WEBUI_DESKTOP_LIFECYCLE: "1",
      CODEX_DESKTOP_BRIDGE_PIPE: pipe,
      CODEX_DESKTOP_BRIDGE_CODEX_PATH: process.execPath,
      CODEX_DESKTOP_BRIDGE_CODEX_ARGS_JSON: JSON.stringify([fakeCodexPath]),
      CODEX_WEBUI_HOST_ADDRESS: "127.0.0.1",
      CODEX_WEBUI_PORT: String(port)
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(async () => {
    if (broker.exitCode === null) broker.kill();
    await new Promise((resolve) => external.close(resolve));
    await removeWithRetry(dataDir);
  });
  let stderr = "";
  broker.stderr.on("data", (chunk) => stderr += chunk.toString("utf8"));
  const desktop = lineQueue(broker.stdout);
  broker.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: {} })}\n`);
  await desktop.next((message) => message.id === 1);
  await waitForText(() => stderr, new RegExp(`Port ${port} is already listening`));

  const exited = new Promise((resolve) => broker.once("exit", resolve));
  broker.kill();
  await exited;
  assert.equal(await canConnectToPort(port), true);
  assert.doesNotMatch(stderr, /Started Desktop-managed WebUI/);
});

test("Windows launcher preserves arguments, streams, and exit code", { timeout: 30000 }, async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only launcher");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codex-webui-launcher-test-"));
  t.after(async () => {
    await removeWithRetry(dataDir);
  });
  const runtimeDir = path.join(dataDir, "desktop-bridge", "runtime");
  const install = spawnSync(resolveWindowsPwsh(), [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", path.join(rootDir, "scripts", "install-desktop-bridge.ps1"),
    "-DataDir", dataDir
  ], { cwd: rootDir, encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr || install.stdout);

  const launcher = path.join(runtimeDir, "windows-v3", "codex-webui-bridge.exe");
  const configPath = path.join(runtimeDir, "windows-v3", "codex-webui-bridge.config");
  const config = await readFile(configPath, "utf8");
  assert.match(config, /^version=3\r?\n/);
  assert.doesNotMatch(config, /wsl/i);
  const result = spawnSync(launcher, ["--version", "argument with spaces", "quote\"inside"], {
    cwd: rootDir,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_WEBUI_DATA_DIR: dataDir,
      CODEX_DESKTOP_BRIDGE_CODEX_PATH: process.execPath,
      CODEX_DESKTOP_BRIDGE_CODEX_ARGS_JSON: JSON.stringify([fakeCodexPath])
    }
  });
  assert.equal(result.status, 23, result.stderr);
  assert.match(result.stderr, /fake-codex-stderr/);
  assert.deepEqual(JSON.parse(result.stdout).args, ["--version", "argument with spaces", "quote\"inside"]);

  const auxiliary = spawnSync(launcher, ["app-server", "--listen", "stdio://"], {
    cwd: rootDir,
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_CODEX_CAPTURE_ARGS: "1",
      CODEX_WEBUI_DATA_DIR: dataDir,
      CODEX_DESKTOP_BRIDGE_CODEX_PATH: process.execPath,
      CODEX_DESKTOP_BRIDGE_CODEX_ARGS_JSON: JSON.stringify([fakeCodexPath])
    }
  });
  assert.equal(auxiliary.status, 23, auxiliary.stderr);
  assert.deepEqual(JSON.parse(auxiliary.stdout).args, ["app-server", "--listen", "stdio://"]);

});

test("WebUI desktop mode uses the selected thread through the shared broker", { timeout: 20000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codex-webui-desktop-mode-test-"));
  const pipe = process.platform === "win32"
    ? `\\\\.\\pipe\\codex-webui-mode-${process.pid}-${randomBytes(6).toString("hex")}`
    : path.join(dataDir, "bridge.sock");
  const port = await freePort();
  const commonEnv = {
    ...process.env,
    CODEX_WEBUI_DATA_DIR: dataDir,
    CODEX_WEBUI_DESKTOP_LIFECYCLE: "0",
    CODEX_DESKTOP_BRIDGE_PIPE: pipe
  };
  const broker = spawn(process.execPath, [brokerPath, "app-server", "--analytics-default-enabled"], {
    cwd: rootDir,
    env: {
      ...commonEnv,
      CODEX_DESKTOP_BRIDGE_CODEX_PATH: process.execPath,
      CODEX_DESKTOP_BRIDGE_CODEX_ARGS_JSON: JSON.stringify([fakeCodexPath])
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const brokerClosed = new Promise(resolve => broker.once("close", resolve));
  let webui = null, webuiClosed = null, socket = null;
  t.after(async () => {
    const errors = [];
    const bounded = async (completion, milliseconds, label) => {
      let timer;
      try {
        await Promise.race([completion, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} cleanup timed out`)), milliseconds);
        })]);
      } finally { clearTimeout(timer); }
    };
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      const closed = new Promise(resolve => socket.once("close", resolve));
      socket.on("error", () => {}); // terminate may interrupt this test's own handshake.
      socket.terminate();
      try { await bounded(closed, 1000, "Test socket"); } catch (error) { errors.push(error); }
    }
    // One ordered hook stops every owned writer even if an earlier step fails.
    // Register close promises at spawn time so an already-exited broker is safe.
    let writersStopped = true;
    for (const [child, closed, label] of [[webui, webuiClosed, "Test WebUI"], [broker, brokerClosed, "Test broker"]]) {
      if (!child) continue;
      if (child.exitCode === null && child.signalCode === null) child.kill();
      try { await bounded(closed, 2000, label); }
      catch {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        try { await bounded(closed, 1000, label); }
        catch (error) { writersStopped = false; errors.push(error); }
      }
    }
    if (writersStopped) {
      const target = path.resolve(dataDir);
      assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
      assert.ok(path.basename(target).startsWith("codex-webui-desktop-mode-test-"));
      try { await removeWithRetry(target); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Selected-thread fixture cleanup failed");
  });
  const desktop = lineQueue(broker.stdout);
  broker.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: {} })}\n`);
  await desktop.next((message) => message.id === 1);
  await waitForRead(path.join(dataDir, "desktop-bridge", "secret"));

  const token = `test-${randomBytes(12).toString("hex")}`;
  webui = spawn(process.execPath, [path.join(rootDir, "server", "index.js")], {
    cwd: rootDir,
    env: {
      ...commonEnv,
      CODEX_WEBUI_TOKEN: token,
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_WEBUI_TERMINAL_QR: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  webuiClosed = new Promise(resolve => webui.once("close", resolve));
  let webuiError = "";
  webui.stderr.on("data", (chunk) => webuiError += chunk.toString("utf8"));
  const info = await waitForHttp(`http://127.0.0.1:${port}/api/info?token=${encodeURIComponent(token)}`);
  assert.equal(info.bridgeMode, "desktop");
  assert.deepEqual(info.capabilities, { projectFiles: process.platform === "win32", threadSettings: true, workspaceBrowser: true });

  socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  const browser = webSocketQueue(socket);
  const hello = await browser.next((message) => message.type === "hello");
  assert.equal(hello.bridgeMode, "desktop");
  assert.deepEqual(hello.capabilities, { projectFiles: process.platform === "win32", threadSettings: true, workspaceBrowser: true });
  if (!hello.desktopBridgeConnected) {
    const online = await browser.next(
      (message) => message.type === "desktop-bridge-status" && message.connected === true
    );
    assert.equal(online.connected, true);
  }
  socket.send(JSON.stringify({
    type: "rpc",
    requestId: 41,
    method: "thread/read",
    params: { threadId: "thread-selected-on-phone" }
  }));
  const read = await browser.next((message) => message.type === "rpc-result" && message.requestId === 41);
  assert.equal(read.result.thread.id, "thread-selected-on-phone", webuiError);

  socket.send(JSON.stringify({
    type: "rpc",
    requestId: 411,
    method: "permissionProfile/list",
    params: { cwd: rootDir }
  }));
  const profiles = await browser.next((message) => message.type === "rpc-result" && message.requestId === 411);
  assert.deepEqual(profiles.result.data.map((entry) => entry.id), [
    ":read-only",
    ":workspace",
    ":danger-full-access"
  ]);

  socket.send(JSON.stringify({
    type: "rpc",
    requestId: 412,
    method: "thread/settings/update",
    params: {
      threadId: "thread-selected-on-phone",
      model: "gpt-test",
      effort: "high",
      permissions: ":workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "guardian_subagent",
      sandboxPolicy: { type: "dangerFullAccess" }
    }
  }));
  await browser.next((message) => message.type === "rpc-result" && message.requestId === 412);
  const settingsNotification = await browser.next(
    (message) => message.type === "codex-notification"
      && message.notification?.method === "thread/settings/updated"
  );
  assert.equal(settingsNotification.notification.params.threadSettings.effort, "high");
  assert.equal(settingsNotification.notification.params.threadSettings.approvalsReviewer, "guardian_subagent");

  broker.stdin.write(`${JSON.stringify({
    id: 77,
    method: "thread/settings/update",
    params: {
      threadId: "thread-selected-on-phone",
      model: "gpt-test",
      effort: "medium",
      permissions: ":danger-full-access",
      approvalPolicy: "never",
      approvalsReviewer: "user"
    }
  })}\n`);
  await desktop.next((message) => message.id === 77);
  const desktopSettingsNotification = await browser.next(
    (message) => message.type === "codex-notification"
      && message.notification?.method === "thread/settings/updated"
      && message.notification.params.threadSettings.approvalPolicy === "never"
  );
  assert.equal(
    desktopSettingsNotification.notification.params.threadSettings.activePermissionProfile.id,
    ":danger-full-access"
  );

  socket.send(JSON.stringify({
    type: "rpc",
    requestId: 413,
    method: "thread/start",
    params: {
      cwd: rootDir,
      model: "gpt-test",
      effort: "high",
      permissions: ":danger-full-access",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only"
    }
  }));
  const created = await browser.next((message) => message.type === "rpc-result" && message.requestId === 413);
  assert.equal(created.result.thread.id, "thread-created-on-phone");
  assert.equal(created.result.receivedParams.cwd, rootDir);
  assert.equal(created.result.receivedParams.model, "gpt-test");
  assert.equal(created.result.receivedParams.permissions, ":danger-full-access");
  assert.equal(created.result.receivedParams.sandbox, undefined);

  socket.send(JSON.stringify({
    type: "rpc",
    requestId: 42,
    method: "turn/start",
    params: {
      threadId: "thread-selected-on-phone",
      input: "from phone",
      model: "must-not-override",
      effort: "low",
      approvalPolicy: "never",
      sandbox: "danger-full-access"
    }
  }));
  const response = await browser.next((message) => message.type === "rpc-result" && message.requestId === 42);
  assert.equal(response.result.turn.id, "turn-thread-selected-on-phone", webuiError);
  assert.equal(response.result.receivedParams.model, undefined);
  assert.equal(response.result.receivedParams.effort, undefined);
  assert.equal(response.result.receivedParams.approvalPolicy, undefined);
  assert.equal(response.result.receivedParams.sandbox, undefined);
  const notification = await browser.next(
    (message) => message.type === "codex-notification" && message.notification?.method === "turn/started"
  );
  assert.equal(notification.notification.params.threadId, "thread-selected-on-phone");

  socket.send(JSON.stringify({
    type: "rpc",
    requestId: 43,
    method: "turn/steer",
    params: {
      threadId: "thread-selected-on-phone",
      expectedTurnId: "turn-thread-selected-on-phone",
      clientUserMessageId: "phone-guide-1",
      input: [
        { type: "text", text: "guide", text_elements: [] },
        { type: "localImage", path: "C:\\Users\\tester\\guide-image.png" }
      ]
    }
  }));
  const steer = await browser.next((message) => message.type === "rpc-result" && message.requestId === 43);
  assert.equal(steer.result.turnId, "turn-thread-selected-on-phone");
  assert.equal(steer.result.receivedParams.expectedTurnId, "turn-thread-selected-on-phone");
  assert.equal(steer.result.receivedParams.clientUserMessageId, "phone-guide-1");
  assert.deepEqual(steer.result.receivedParams.input[1], {
    type: "localImage",
    path: "C:\\Users\\tester\\guide-image.png"
  });
  const [desktopSteerItem, webSteerItem] = await Promise.all([
    desktop.next((message) => message.method === "item/completed"
      && message.params?.item?.clientId === "phone-guide-1"),
    browser.next((message) => message.type === "codex-notification"
      && message.notification?.method === "item/completed"
      && message.notification.params?.item?.clientId === "phone-guide-1")
  ]);
  assert.equal(desktopSteerItem.params.item.content[0].text, "guide");
  assert.equal(desktopSteerItem.params.item.content[1].path, "C:\\Users\\tester\\guide-image.png");
  assert.equal(webSteerItem.notification.params.item.id, "user-phone-guide-1");

  socket.send(JSON.stringify({
    type: "rpc",
    requestId: 44,
    method: "thread/queue/add",
    params: {
      threadId: "thread-selected-on-phone",
      clientUserMessageId: "phone-queued-1",
      input: [{ type: "text", text: "do this next", text_elements: [] }]
    }
  }));
  const queued = await browser.next((message) => message.type === "rpc-result" && message.requestId === 44);
  assert.equal(queued.result.queuedSubmission.clientUserMessageId, "phone-queued-1");
  const desktopQueueChanged = await desktop.next((message) => message.method === "thread/queue/changed");
  assert.equal(desktopQueueChanged.params.threadId, "thread-selected-on-phone");

  socket.send(JSON.stringify({
    type: "rpc",
    requestId: 45,
    method: "thread/queue/list",
    params: { threadId: "thread-selected-on-phone", limit: 1 }
  }));
  const queueList = await browser.next((message) => message.type === "rpc-result" && message.requestId === 45);
  assert.equal(queueList.result.data[0].input[0].text, "do this next");

  socket.send(JSON.stringify({
    type: "rpc",
    requestId: 46,
    method: "thread/queue/start",
    params: {
      threadId: "thread-selected-on-phone",
      queuedSubmissionId: queueList.result.data[0].id
    }
  }));
  const queueStart = await browser.next((message) => message.type === "rpc-result" && message.requestId === 46);
  assert.match(queueStart.result.turn.id, /^turn-queued-/);
  const desktopQueuedTurn = await desktop.next((message) => message.method === "turn/started"
    && message.params?.turn?.id === queueStart.result.turn.id);
  assert.equal(desktopQueuedTurn.params.threadId, "thread-selected-on-phone");

  socket.send(JSON.stringify({
    type: "rpc",
    requestId: 47,
    method: "turn/interrupt",
    params: {
      threadId: "thread-selected-on-phone",
      turnId: queueStart.result.turn.id
    }
  }));
  const interrupted = await browser.next((message) => message.type === "rpc-result" && message.requestId === 47);
  assert.equal(interrupted.result.receivedParams.turnId, queueStart.result.turn.id);
  const [desktopInterrupted, webInterrupted] = await Promise.all([
    desktop.next((message) => message.method === "turn/completed"
      && message.params?.turn?.status === "interrupted"),
    browser.next((message) => message.type === "codex-notification"
      && message.notification?.method === "turn/completed"
      && message.notification.params?.turn?.status === "interrupted")
  ]);
  assert.equal(desktopInterrupted.params.turn.id, queueStart.result.turn.id);
  assert.equal(webInterrupted.notification.params.threadId, "thread-selected-on-phone");

  broker.kill();
  const offline = await browser.next(
    (message) => message.type === "desktop-bridge-status" && message.connected === false
  );
  assert.equal(offline.connected, false);
});

function resolveWindowsPwsh() {
  let localAppData = process.env.LOCALAPPDATA;
  try {
    if (localAppData) localAppData = fsRealPath(localAppData);
  } catch {
    // Keep the logical profile path.
  }
  const candidates = [
    process.env.CODEX_WEBUI_TEST_PWSH,
    localAppData && path.join(localAppData, "Microsoft", "WindowsApps", "pwsh.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe")
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0] || "pwsh.exe";
}

function lineQueue(stream) {
  const messages = [];
  const waiters = [];
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => {
    const message = JSON.parse(line);
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
    else messages.push(message);
  });
  return {
    next(predicate) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for line")), 5000);
        waiters.push({ predicate, resolve: (message) => { clearTimeout(timer); resolve(message); } });
      });
    }
  };
}

async function connectLines(endpoint) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const socket = await new Promise((resolve, reject) => {
        const candidate = net.createConnection(endpoint);
        candidate.once("connect", () => resolve(candidate));
        candidate.once("error", reject);
      });
      const queue = lineQueue(socket);
      return { socket, next: queue.next, send: (message) => socket.write(`${JSON.stringify(message)}\n`) };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

async function waitForRead(filePath) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

async function removeWithRetry(target) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHttp(url) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function waitForText(read, pattern) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (pattern.test(read())) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${pattern}`);
}

async function canConnectToPort(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (connected) => {
      socket.destroy();
      resolve(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(300, () => finish(false));
  });
}

async function waitForPortClosed(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await canConnectToPort(port))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Port ${port} remained open`);
}

function webSocketQueue(socket) {
  const messages = [];
  const waiters = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
    else messages.push(message);
  });
  return {
    next(predicate) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for WebSocket message; buffered=${JSON.stringify(messages)}`)),
          5000
        );
        waiters.push({ predicate, resolve: (message) => { clearTimeout(timer); resolve(message); } });
      });
    }
  };
}
