import { createHash, randomBytes } from "node:crypto";
import { closeSync, createReadStream, existsSync, fstatSync, mkdirSync, openSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { WebSocketServer } from "ws";
import { readTokenStore, resolveDataDir, tokenStorePath } from "./token-store.js";
import { UsageTracker } from "./usage-store.js";
import { getLanUrls } from "./network-urls.js";
import { DesktopBridgeConnection } from "./desktop-bridge-client.js";
import { sanitizeDesktopBridgeParams } from "./desktop-bridge-policy.js";
import { isWebUserServerRequest } from "./server-request-policy.js";
import { classifyInteractionRequest, interactionKey } from "../public/interaction-contracts.js";
import { InteractionSession } from "./interaction-session.js";
import { canReceiveThreadContext } from "./thread-notification-scope.js";
import { createWorkspaceDirectory, listWorkspaceDirectories } from "./workspace-browser.js";
import { ProjectFiles } from "./project-files.js";
import { serveProjectFiles } from "./project-files-http.js";
import { DownloadTickets } from "./download-tickets.js";
import { pdfAsset, pdfAssetRoot } from "./pdf-assets.js";
import { nativeRecordedChanges } from "./project-file-discovery.js";
import { ReadRequestCoalescer } from "./read-request-coalescer.js";
import { CloudflareAccessAuthenticator, readCloudflareAccessConfig } from "./cloudflare-access.js";
import { ChatAttachments } from "./chat-attachments.js";
import { serveChatAttachments } from "./chat-attachments-http.js";
import { expandChatAttachmentInput } from "./chat-attachment-input.js";
import { AttachmentSendLedger } from "./chat-attachment-send.js";
import { acquireFileLease } from "./file-lease.js";
import { stripAttachmentReferences, attachmentReferences } from "../public/attachment-reference.js";
import { WEBUI_RELEASE } from "../public/release.js";
import { createNativeActionsService } from "./native-actions.js";
import { serveNativeActions } from "./native-actions-http.js";
import { ProjectWriteContexts } from "./project-write-context.js";
import { ProjectWrites } from "./project-writes.js";
import { runProjectWriter } from "./native-project-writer.js";
import { serveProjectWrites } from "./project-writes-http.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const nodeModulesDir = path.join(rootDir, "node_modules");
const pdfJsRoot = pdfAssetRoot(nodeModulesDir,rootDir,process.env.CODEX_WEBUI_PDFJS_ROOT);
const dataDir = resolveDataDir();
const uploadDir = path.join(dataDir, "uploads");
const inlineImageDir = path.join(dataDir, "inline-images");
const cloudflareAccessConfig = readCloudflareAccessConfig(dataDir);
const cloudflareAccessAuthenticator = new CloudflareAccessAuthenticator(cloudflareAccessConfig);

const PORT = Number(process.env.PORT || 9526);
const HOST = process.env.HOST || "0.0.0.0";
const DEFAULT_CWD = process.env.CODEX_WEBUI_CWD || rootDir;
const usesEnvironmentTokens = Boolean(
  String(process.env.CODEX_WEBUI_TOKEN || "").trim()
  || String(process.env.CODEX_WEBUI_TOKEN_SCOPES || "").trim()
);
let tokenScopes = createTokenScopes();
let defaultTokenScope = tokenScopes.values().next().value;
let tokenStoreModifiedMs = currentTokenStoreModifiedMs();
const usageTracker = new UsageTracker(dataDir);
const inlineImages = new Map();
const inlineImageLimit = 80;
const webuiCapabilities = {
  projectFiles: process.platform === "win32",
  projectFilesWrite: process.platform === "win32",
  threadSettings: true,
  workspaceBrowser: true
};

const allowedMethods = new Set([
  "account/read",
  "account/login/start",
  "account/logout",
  "account/rateLimits/read",
  "config/read",
  "configRequirements/read",
  "model/list",
  "permissionProfile/list",
  "thread/list",
  "thread/start",
  "thread/resume",
  "thread/read",
  "thread/turns/list",
  "thread/name/set",
  "thread/archive",
  "thread/unarchive",
  "thread/loaded/list",
  "thread/settings/update",
  "thread/queue/add",
  "thread/queue/list",
  "thread/queue/start",
  "turn/start",
  "turn/steer",
  "turn/interrupt"
]);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon"
};

const vendorFiles = new Map([
  ["/vendor/markdown-it.min.js", path.join(nodeModulesDir, "markdown-it", "dist", "markdown-it.min.js")],
  ["/vendor/purify.min.js", path.join(nodeModulesDir, "dompurify", "dist", "purify.min.js")]
]);

const imageExtensionsByMime = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"]
]);

const imageMimesByExtension = new Map(
  Array.from(imageExtensionsByMime, ([mime, ext]) => [ext, mime])
);
const LOCAL_FILE_CACHE_CONTROL = "private, max-age=0, must-revalidate";
const INLINE_IMAGE_CACHE_CONTROL = "private, max-age=31536000, immutable";

class DesktopCodexBridge {
  constructor() {
    this.reads = new ReadRequestCoalescer();
    this.proc = null;
    this.spawnInfo = { label: "Codex Desktop shared app-server" };
    this.clients = new Set();
    this.interactions = new InteractionSession({
      sendResponse: (id, result) => this.connection.respond(id, result),
      onUpdate: (message, request) => {
        if (message.type === "interaction-snapshot-changed") this.publishInteractionSnapshot();
        else this.broadcast(message, threadContextFromAppServerMessage(request));
      }
    });
    this.serverRequests = this.interactions.requests;
    this.connection = new DesktopBridgeConnection({
      onAppServerMessage: (message) => this.handleAppServerMessage(message),
      onError: (error) => this.broadcast({ type: "bridge-error", error: error.message }),
      onServerRequestResolved: (id) => this.resolveServerRequest(id),
      onStatus: (connected) => {
        this.interactions.setConnected(connected);
        this.broadcast({ type: "desktop-bridge-status", connected });
      },
      onPendingRequests: snapshot => this.interactions.reconcile(snapshot)
    });
    this.ready = this.connection.connect();
    this.ready.catch(() => {});
  }

  handleAppServerMessage(message) {
    if (message?.id !== undefined && message?.method) {
      if (!isWebUserServerRequest(message.method)) return;
      this.interactions.receive(message);
      return;
    }
    this.broadcast(
      { type: "codex-notification", notification: stripInlineDataImages(message) },
      threadContextFromAppServerMessage(message)
    );
  }

  resolveServerRequest(id) {
    this.interactions.resolve(id);
  }

  async requestRaw(method, params = {}) {
    return this.reads.run(method,params,()=>this.connection.request(method,params));
  }

  async request(method, params = {}, scope = defaultTokenScope) {
    if (!allowedMethods.has(method)) throw new Error(`Method not allowed: ${method}`);
    return this.requestRaw(
      method,
      sanitizeDesktopBridgeParams(method, normalizeParams(method, params, scope))
    );
  }

  async respond(id, result) {
    return this.interactions.submit(id, result);
  }

  canRespond(id, scope) {
    let request;
    try { request = this.serverRequests.get(interactionKey(id)); } catch { return false; }
    return Boolean(request && classifyInteractionRequest(this.requestForScope(request, scope)).support === "web" && canReceiveThreadContext(scope, threadContextFromAppServerMessage(request)));
  }

  requestForScope(request, scope) {
    // A folder-scoped device cannot widen filesystem grants through an additive
    // permission profile. Keep these requests in Desktop until path semantics
    // (including symlinks/nonexistent grant roots) can be enforced faithfully.
    const filesystemGrant = request?.params?.permissions?.fileSystem || request?.params?.additionalPermissions?.fileSystem;
    const fileApproval = ["item/fileChange/requestApproval", "applyPatchApproval"].includes(request?.method);
    if ((filesystemGrant || fileApproval) && hasThreadFilter(scope)) {
      return { id: request.id, method: request.method, desktopOnly: true, unavailableReason: "scoped-filesystem-grant", params: { threadId: request.params.threadId || request.params.thread_id || request.params.conversationId, turnId: request.params.turnId } };
    }
    return request;
  }

  attach(client, scope = defaultTokenScope) {
    this.clients.add(client);
    client.sendJson({
      type: "hello",
      defaultCwd: scope.defaultCwd,
      threadFilterCwd: scope.threadFilterCwd,
      threadFilterCwds: scope.threadFilterCwds,
      tokenHash: scope.tokenHash,
      bridgeMode: "desktop",
      capabilities: webuiCapabilities,
      desktopBridgeConnected: this.connection.isConnected(),
      interactionEpoch: this.interactions.epoch,
      interactionsAuthoritative: this.interactions.authoritative,
      interactionStates: this.interactions.snapshot().states.filter(state => {
        const request = this.serverRequests.get(interactionKey(state.id));
        return request && canReceiveThreadContext(scope, threadContextFromAppServerMessage(request));
      }),
      pendingServerRequests: Array.from(this.serverRequests.values())
        .filter((request) => canReceiveThreadContext(scope, threadContextFromAppServerMessage(request)))
        .map(request => this.requestForScope(request, scope))
    });
    client.once("close", () => this.clients.delete(client));
  }

  publishInteractionSnapshot() {
    const snapshot = this.interactions.snapshot();
    for (const client of this.clients) {
      if (client.readyState !== client.OPEN || !client.tokenScope) continue;
      const requests = snapshot.requests.filter(request => canReceiveThreadContext(client.tokenScope, threadContextFromAppServerMessage(request))).map(request => this.requestForScope(request, client.tokenScope));
      const keys = new Set(requests.map(request => interactionKey(request.id)));
      client.sendJson({ type: "server-request-snapshot", requests, states: snapshot.states.filter(state => keys.has(interactionKey(state.id))), epoch: snapshot.epoch, authoritative: snapshot.authoritative });
    }
  }

  broadcast(payload, threadContext = null) {
    for (const client of this.clients) {
      if(threadContext?.thread?.cwd&&hasThreadFilter(client.tokenScope)){
        client.tokenScope.visibleThreadIds.delete(threadContext.threadId);
        if(!isPathAllowedInScope(client.tokenScope,threadContext.thread.cwd))continue;
      }
      if (!canReceiveThreadContext(client.tokenScope, threadContext)) continue;
      if (client.readyState === client.OPEN) {
        client.sendJson(payload.type === "server-request" ? { ...payload, request: this.requestForScope(payload.request, client.tokenScope) } : payload);
      }
    }
  }
}

function normalizeParams(method, params, scope = defaultTokenScope) {
  const next = { ...(params || {}) };

  if (method === "thread/start") {
    next.cwd = next.cwd || scope.defaultCwd;
    if (hasThreadFilter(scope) && !isPathAllowedInScope(scope, next.cwd)) {
      throw new Error("This token can only create sessions in the allowed folder.");
    }
    next.cwd = normalizeLocalPath(next.cwd);
    if (!existsSync(next.cwd) || !statSync(next.cwd).isDirectory()) {
      throw new Error("The selected workspace directory does not exist.");
    }
    next.serviceName = "codex_webui";
    if (!next.permissions) next.permissions = ":workspace";
    if (!next.approvalPolicy) next.approvalPolicy = "on-request";
    if (!next.approvalsReviewer) next.approvalsReviewer = "user";
    normalizeReasoningEffortParam(next);
  }

  if (method === "thread/resume") {
    if (next.cwd === "") delete next.cwd;
    normalizeReasoningEffortParam(next);
  }
  if(method==="thread/settings/update"&&hasThreadFilter(scope)&&Object.hasOwn(next,"cwd")&&!isPathAllowedInScope(scope,next.cwd)) {
    throw new Error("This token can only use the allowed workspace folders.");
  }

  if (method === "turn/start") {
    normalizeReasoningEffortParam(next);
    if (typeof next.input === "string") {
      next.input = [{ type: "text", text: next.input, text_elements: [] }];
    }
    if (Array.isArray(next.input)) {
      next.input = next.input.map((item) =>
        item?.type === "text" ? { text_elements: [], ...item } : item
      );
    }
  }

  if (method === "thread/list") {
    next.limit = next.limit || 40;
    if (hasThreadFilter(scope)) next.limit = Math.max(Number(next.limit) || 0, 500);
    if (!("archived" in next)) next.archived = false;
  }

  if (method === "thread/turns/list") {
    next.limit = Math.min(Math.max(Number(next.limit) || 20, 1), 100);
    next.sortDirection = next.sortDirection || "desc";
    next.itemsView = next.itemsView || "full";
  }

  return next;
}

const bridgeMode = "desktop";
const bridge = new DesktopCodexBridge();
const projectFiles = new ProjectFiles({ dataDir,
  readThread: async threadId => (await bridge.requestRaw("thread/read", { threadId, includeTurns: false }))?.thread,
  readChanges: async threadId => {
    const page=await bridge.requestRaw("thread/turns/list",{threadId,limit:20,sortDirection:"desc",itemsView:"full"});return nativeRecordedChanges(page?.data||[]);
  }
});
const downloadTickets = new DownloadTickets({resolveScope: hash => {refreshTokenScopesIfChanged();return [...tokenScopes.values()].find(scope=>scope.tokenHash===hash)||null;}});
const chatAttachments = new ChatAttachments({dataDir,
  ...(process.platform === "win32" ? {acquireLease:({root,relative,kind})=>acquireFileLease(dataDir,root,relative,kind)} : {})
});
const attachmentSendLedger = new AttachmentSendLedger({dataDir});
const writeContexts=new ProjectWriteContexts({files:projectFiles,runWriter:runProjectWriter,dataDir});
const projectWrites=new ProjectWrites({contexts:writeContexts,runWriter:runProjectWriter,dataDir});
const nativeActions = createNativeActionsService({dataDir,callNative:(method,params)=>bridge.requestRaw(method,params),
  authorizeThread:authorizeNativeThread,codexHome:process.env.CODEX_HOME || path.join(os.homedir(),".codex")});

async function authorizeNativeThread(scope,threadId) {
  const base=scopeFromToken(scope?.token);
  if(!base||base.id!==scope?.id||base.tokenHash!==scope?.tokenHash ||
    (scope.authMode==="cloudflare-access"&&scope.accessExpiresAt<=Math.floor(Date.now()/1000)))throw Object.assign(new Error("Native access expired"),{status:401,code:"UNAUTHORIZED"});
  const thread=(await bridge.requestRaw("thread/read",{threadId,includeTurns:false}))?.thread;
  if(thread?.id!==threadId||!thread.cwd)throw Object.assign(new Error("Native thread unavailable"),{status:403,code:"THREAD_FORBIDDEN"});
  if(hasThreadFilter(base)){
    const root=await realpath(thread.cwd);
    const roots=await Promise.all(scopeFilterRoots(base).map(value=>realpath(value).catch(()=>null)));
    if(!roots.some(value=>value&&canonicalPathInside(value,root)))throw Object.assign(new Error("Native thread unavailable"),{status:403,code:"THREAD_FORBIDDEN"});
  }
  return thread;
}

function attachmentPrincipal(scope) {
  return createHash("sha256").update(`${scope.tokenHash}\0${scope.authMode === "cloudflare-access" ? scope.accessEmail : "token"}`).digest("hex");
}

async function attachmentContext(scope, {draftId,cwd,threadId}, {download=false}={}) {
  if (!scope || (!download && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(draftId||"")) || (download&&!threadId)) {
    throw Object.assign(new Error("Invalid attachment context"),{status:400,code:"INVALID_CONTEXT"});
  }
  if (threadId) {
    if (typeof threadId !== "string" || threadId.length>200) throw Object.assign(new Error("Invalid thread"),{status:400});
    const result = await bridge.requestRaw("thread/read",{threadId,includeTurns:false});
    if (result?.thread?.id !== threadId || !result.thread.cwd) throw Object.assign(new Error("Thread not found"),{status:404});
    const nativeCwd = await realpath(result.thread.cwd);
    if (cwd && path.relative(nativeCwd, await realpath(cwd)) !== "") throw Object.assign(new Error("Workspace changed"),{status:409,code:"CONTEXT_CHANGED"});
    cwd=nativeCwd;
  }
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || !statSync(cwd).isDirectory()) throw Object.assign(new Error("Invalid workspace"),{status:400});
  cwd=await realpath(cwd);
  if (hasThreadFilter(scope)) {
    const roots=await Promise.all(scopeFilterRoots(scope).map(root=>realpath(root).catch(()=>null)));
    if (!roots.some(root=>root&&canonicalPathInside(root,cwd))) throw Object.assign(new Error("Workspace unavailable"),{status:403,code:"FORBIDDEN"});
  }
  return {principalId:attachmentPrincipal(scope),scopeId:createHash("sha256").update(JSON.stringify([scope.id,scope.tokenHash,scopeFilterRoots(scope)])).digest("hex"),cwd,draftId,threadId:threadId||null};
}

async function resolveAttachmentHttpContext(req,url,{download=false}={}) {
  const scope=await resolveRequestScope(req,url);
  if (!scope) throw Object.assign(new Error("Unauthorized"),{status:401,code:"UNAUTHORIZED"});
  return attachmentContext(scope,{
    draftId:url.searchParams.get("draftId"),cwd:url.searchParams.get("cwd"),threadId:url.searchParams.get("threadId")
  },{download});
}

function freshAttachmentSocketScope(ws) {
  const previous=ws.tokenScope;
  const base=scopeFromToken(previous?.token);
  if(!base || base.id!==previous?.id || base.tokenHash!==previous?.tokenHash || (previous?.authMode==="cloudflare-access" && previous.accessExpiresAt<=Math.floor(Date.now()/1000))) {
    throw Object.assign(new Error("Attachment access expired"),{code:"UNAUTHORIZED"});
  }
  return previous?.authMode==="cloudflare-access" ? createCloudflareAccessScope(base,{email:previous.accessEmail,expiresAt:previous.accessExpiresAt}) : base;
}

async function requestWithAttachments(ws,method,params) {
  if(!["turn/start","turn/steer","thread/queue/add"].includes(method) || !Array.isArray(params.attachmentIds) || !params.attachmentIds.length || params.attachmentIds.length>20 || new Set(params.attachmentIds).size!==params.attachmentIds.length) {
    throw Object.assign(new Error("Invalid attachment send"),{code:"INVALID_ATTACHMENTS"});
  }
  const context=await attachmentContext(freshAttachmentSocketScope(ws),{draftId:params.draftId,cwd:params.draftCwd,threadId:params.threadId});
  const lease=await chatAttachments.acquire(context,params.attachmentIds);
  try {
    const freshScope=freshAttachmentSocketScope(ws);
    const fresh=await attachmentContext(freshScope,{draftId:params.draftId,cwd:params.draftCwd,threadId:params.threadId});
    if(JSON.stringify(fresh)!==JSON.stringify(context))throw Object.assign(new Error("Attachment context changed"),{code:"CONTEXT_CHANGED"});
    const nativeParams=expandChatAttachmentInput({method,params,files:lease.files});
    const result=await attachmentSendLedger.send(context.principalId,{method,...params},async()=>{
      freshAttachmentSocketScope(ws);
      try { return await bridge.request(method,nativeParams,freshScope); }
      finally { await lease.commit(); }
    });
    return result;
  } finally { await lease.release(); }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (await serveChatAttachments(req,res,url,{store:chatAttachments,resolveContext:resolveAttachmentHttpContext})) return;
    if (await serveNativeActions(req,res,url,{service:nativeActions,resolveScope:resolveRequestScope})) return;
    if (await serveProjectWrites(req,res,url,{writes:projectWrites,resolveScope:resolveRequestScope})) return;
    if (url.pathname.startsWith("/api/project-files/")) {
      const scope = await resolveRequestScope(req, url);
      if (scope) recordHttpUsage(scope, req);
      await serveProjectFiles(req, res, url, scope, projectFiles, downloadTickets);
      return;
    }
    if (url.pathname === "/api/info") {
      const scope = await resolveRequestScope(req, url);
      if (!scope) {
        sendJson(res, {
          authenticated: false,
          port: PORT,
          host: HOST,
          bridgeMode,
          capabilities: webuiCapabilities,
          lanUrls: getLanUrls(PORT)
        });
        return;
      }
      recordHttpUsage(scope, req);
      sendJson(res, {
        authenticated: true,
        release: WEBUI_RELEASE,
        port: PORT,
        host: HOST,
        bridgeMode,
        capabilities: webuiCapabilities,
        defaultCwd: scope.defaultCwd,
        threadFilterCwd: scope.threadFilterCwd,
        threadFilterCwds: scope.threadFilterCwds,
        lanUrls: getLanUrls(PORT),
        tokenHash: scope.tokenHash,
        authMode: scope.authMode || "token",
        accessEmail: scope.authMode === "cloudflare-access" ? scope.accessEmail : undefined
      });
      return;
    }

    if (url.pathname === "/api/workspaces" && req.method === "GET") {
      const scope = await resolveRequestScope(req, url);
      if (!scope) {
        sendJsonStatus(res, 401, { error: "Unauthorized" });
        return;
      }
      recordHttpUsage(scope, req);
      const result = listWorkspaceDirectories(url.searchParams.get("path") || "", {
        scopeRoots: scopeFilterRoots(scope)
      });
      sendJson(res, result);
      return;
    }

    if (url.pathname === "/api/workspaces/create" && req.method === "POST") {
      const scope = await resolveRequestScope(req, url);
      if (!scope) {
        sendJsonStatus(res, 401, { error: "Unauthorized" });
        return;
      }
      recordHttpUsage(scope, req);
      const body = JSON.parse((await readRequestBody(req, 64 * 1024)).toString("utf8") || "{}");
      const entry = await createWorkspaceDirectory(body.parent, body.name, {
        scopeRoots: scopeFilterRoots(scope)
      });
      sendJson(res, { workspace: entry });
      return;
    }

    if(url.pathname.startsWith("/vendor/pdfjs/")) {
      const asset=pdfAsset(url.pathname,pdfJsRoot);
      if(!asset||!existsSync(asset.path)||!["GET","HEAD"].includes(req.method)){res.writeHead(404);res.end();return;}
      res.writeHead(200,{"Content-Type":asset.mime,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
      if(req.method==="HEAD")res.end();else createReadStream(asset.path).on("error",()=>res.destroy()).pipe(res);return;
    }
    if (vendorFiles.has(url.pathname)) {
      const vendorPath = vendorFiles.get(url.pathname);
      if (!existsSync(vendorPath)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Vendor file not found");
        return;
      }

      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store"
      });
      createReadStream(vendorPath).pipe(res);
      return;
    }

    if (url.pathname === "/api/local-file") {
      const scope = await resolveRequestScope(req, url);
      if (!scope) {
        res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
        res.end("Unauthorized");
        return;
      }
      recordHttpUsage(scope, req);

      const requestedPath = normalizeLocalPath(url.searchParams.get("path") || "");
      const image = openAccessibleLocalImage(scope, requestedPath);
      if (!image) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }

      const ext = path.extname(image.path).toLowerCase();
      sendCachedFile(req, res, image, mimeTypes[ext] || "application/octet-stream");
      return;
    }

    if (url.pathname === "/api/inline-image") {
      const scope = await resolveRequestScope(req, url);
      const inlineId = url.searchParams.get("id") || "";
      if (!scope) {
        logInlineImageRequest(req, {
          id: inlineId,
          status: 401,
          source: "none",
          bytes: 0,
          mimeType: ""
        });
        res.writeHead(401, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store"
        });
        res.end("Unauthorized");
        return;
      }
      recordHttpUsage(scope, req);

      const memoryEntry = inlineImages.get(inlineId);
      const entry = memoryEntry || await readPersistedInlineImage(inlineId);
      if (!entry) {
        logInlineImageRequest(req, {
          id: inlineId,
          status: 404,
          source: "miss",
          bytes: 0,
          mimeType: ""
        });
        res.writeHead(404, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store"
        });
        res.end("Not found");
        return;
      }

      const etag = `"${entry.id}"`;
      const status = requestCacheIsFresh(req, etag, entry.createdAt) ? 304 : 200;
      logInlineImageRequest(req, {
        id: entry.id,
        status,
        source: memoryEntry ? "memory" : "disk",
        bytes: entry.buffer.length,
        mimeType: entry.mimeType
      });
      sendCachedBuffer(req, res, entry.buffer, entry.mimeType, `"${entry.id}"`, entry.createdAt);
      return;
    }

    if (url.pathname === "/api/upload-image" && req.method === "POST") {
      const scope = await resolveRequestScope(req, url);
      if (!scope) {
        res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      recordHttpUsage(scope, req);

      const rawContentType = String(req.headers["content-type"] || "").split(";")[0].toLowerCase();
      const uploadName = decodeURIComponent(String(req.headers["x-file-name"] || ""));
      const nameMime = imageMimesByExtension.get(path.extname(uploadName).toLowerCase()) || "";
      const contentType = imageExtensionsByMime.has(rawContentType) ? rawContentType : nameMime;
      if (!imageExtensionsByMime.has(contentType)) {
        res.writeHead(415, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Unsupported image type" }));
        return;
      }

      const body = await readRequestBody(req, 15 * 1024 * 1024);
      const targetUploadDir = uploadDirForScope(scope);
      await mkdir(targetUploadDir, { recursive: true });
      const fileName = `${Date.now()}-${randomBytes(8).toString("hex")}${imageExtensionsByMime.get(contentType)}`;
      const filePath = path.join(targetUploadDir, fileName);
      await writeFile(filePath, body);
      sendJson(res, { path: filePath });
      return;
    }

    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.normalize(path.join(publicDir, pathname));
    if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[ext] || "application/octet-stream",
      "cache-control": "no-store"
    });
    createReadStream(filePath).pipe(res);
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error.message }));
  }
});

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: {
    threshold: 1024,
    zlibDeflateOptions: { level: 6 },
    zlibInflateOptions: { chunkSize: 16 * 1024 }
  }
});
const websocketHeartbeat=setInterval(()=>{
  for(const client of wss.clients){
    if(client.readyState!==1)continue;
    if(client.transportAlive===false){client.terminate();continue;}
    client.transportAlive=false;client.ping();
  }
},30000);
websocketHeartbeat.unref();wss.on("close",()=>clearInterval(websocketHeartbeat));

server.on("upgrade", (req, socket, head) => {
  void handleWebSocketUpgrade(req, socket, head);
});

async function handleWebSocketUpgrade(req, socket, head) {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  let scope = null;
  try {
    scope = await resolveRequestScope(req, url);
  } catch {
    scope = null;
  }
  if (url.pathname !== "/ws" || !scope) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.tokenScope = scope;
    ws.sendJson = (payload) => {
      if(ws.readyState!==1)return;
      if(ws.bufferedAmount>8*1048576){ws.close(1013,"Client is not consuming messages; reconnect to sync");return;}
      const current=scopeFromToken(ws.tokenScope?.token);
      const expired=ws.tokenScope?.authMode==="cloudflare-access"&&ws.tokenScope.accessExpiresAt<=Math.floor(Date.now()/1000);
      if(!current||expired||current.id!==ws.tokenScope.id||current.tokenHash!==ws.tokenScope.tokenHash||JSON.stringify(scopeFilterRoots(current))!==JSON.stringify(scopeFilterRoots(ws.tokenScope))){
        if(ws.readyState===1)ws.close(4001,"Access expired or changed");return;
      }
      const data = JSON.stringify(payload);
      usageTracker.record(scope.id, { bytesOut: Buffer.byteLength(data) });
      ws.send(data);
    };
    usageTracker.record(scope.id, { wsConnections: 1 });
    bridge.attach(ws, scope);
    wss.emit("connection", ws, req);
  });
}

wss.on("connection", (ws) => {
  ws.transportAlive=true;ws.on("pong",()=>{ws.transportAlive=true;});
  ws.on("error",error=>{console.warn("[codex-webui:ws]",{event:"client-transport-error",code:/^[A-Z0-9_]{1,64}$/.test(error.code||"")?error.code:"WS_ERROR"});});
  ws.on("message", async (data) => {
    const startedAt = performance.now();
    const bytesIn = Buffer.byteLength(data);
    let message;
    try {
      message = JSON.parse(data.toString("utf8"));
    } catch {
      ws.sendJson({ type: "error", error: "Invalid JSON" });
      return;
    }

    try {
      const previousScope = ws.tokenScope;
      const activeScope = scopeFromToken(previousScope?.token);
      const accessExpired = previousScope?.authMode === "cloudflare-access"
        && Number(previousScope.accessExpiresAt || 0) <= Math.floor(Date.now() / 1000);
      if (!activeScope || activeScope.id !== previousScope?.id || accessExpired) {
        ws.close(4001, "Access token was revoked or rotated");
        return;
      }
      ws.tokenScope = previousScope?.authMode === "cloudflare-access"
        ? createCloudflareAccessScope(activeScope, {
            email: previousScope.accessEmail,
            expiresAt: previousScope.accessExpiresAt
          })
        : activeScope;
      if(message.type==="webui-ping"){
        if(typeof message.nonce!=="string"||!/^[A-Za-z0-9_.-]{1,64}$/.test(message.nonce)){ws.close(4002,"Invalid heartbeat");return;}
        ws.sendJson({type:"webui-pong",nonce:message.nonce});return;
      }
      if (message.type === "rpc") {
        const requestParams = bridgeMode === "desktop"
          ? sanitizeDesktopBridgeParams(message.method, message.params || {})
          : message.params || {};
        const scopedRead=await ensureThreadAccess(message.method, requestParams, ws.tokenScope);
        const rawResult = Object.hasOwn(requestParams,"attachmentIds")
          ? await requestWithAttachments(ws,message.method,requestParams)
          : message.method==="webui/attachment-send/status"
            ? await attachmentSendLedger.status(attachmentPrincipal(freshAttachmentSocketScope(ws)),requestParams.clientSendId)
            : message.method==="thread/read"&&requestParams.includeTurns===false&&scopedRead
              ? scopedRead : await bridge.request(message.method, requestParams, ws.tokenScope);
        rememberVisibleThreadFromResult(message.method, rawResult, ws.tokenScope);
        const result = await compactResultForClient(message.method, rawResult, ws.tokenScope);
        const response = { type: "rpc-result", requestId: message.requestId, result };
        logRpcServerDebug("result", message, ws.tokenScope, startedAt, bytesIn, response);
        recordRpcUsage(ws.tokenScope, message, bytesIn, response, false);
        ws.sendJson(response);
      } else if (message.type === "server-response") {
        const request=bridge.serverRequests.get(interactionKey(message.id));
        const target=threadContextFromAppServerMessage(request)?.threadId;
        if(target)await ensureThreadAccess("server-response",{threadId:target},ws.tokenScope);
        if (!bridge.canRespond(message.id, ws.tokenScope)) {
          throw Object.assign(new Error("Request is no longer available to this client."), { code: "REQUEST_RESOLVED" });
        }
        const result = await bridge.respond(message.id, message.result);
        const response = { type: "rpc-result", requestId: message.requestId, result };
        logRpcServerDebug("result", message, ws.tokenScope, startedAt, bytesIn, response);
        recordRpcUsage(ws.tokenScope, message, bytesIn, response, false);
        ws.sendJson(response);
      } else {
        ws.sendJson({ type: "error", requestId: message.requestId, error: "Unknown message type" });
      }
    } catch (error) {
      const response = { type: "rpc-error", requestId: message.requestId, error: error.message, code: error.code };
      logRpcServerDebug("error", message, ws.tokenScope, startedAt, bytesIn, response);
      recordRpcUsage(ws.tokenScope, message, bytesIn, response, true);
      ws.sendJson(response);
    }
  });
});

server.listen(PORT, HOST, async () => {
  const urls = getLanUrls(PORT);
  const banner = [
    "",
    "Codex WebUI is running.",
    ...formatTokenUrls("Local", [`http://localhost:${PORT}`]),
    ...formatTokenUrls("LAN", urls),
    "",
    "Open the LAN URL from a phone on the same Wi-Fi.",
    ""
  ].join("\n");
  console.log(banner);

  await printAndWriteQrCodes(urls);

  try {
    const pkg = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
    console.log(`App: ${pkg.name}@${pkg.version}`);
    if (bridge.spawnInfo?.label) console.log(`Codex app-server: ${bridge.spawnInfo.label}`);
  } catch {
    // Best effort only.
  }
});

function sendJson(res, payload) {
  sendJsonStatus(res, 200, payload);
}

function sendJsonStatus(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(JSON.stringify(payload));
}

function recordHttpUsage(scope, req) {
  usageTracker.record(scope?.id, {
    httpRequests: 1,
    bytesIn: Math.max(0, Number(req.headers["content-length"]) || 0)
  });
}

function recordRpcUsage(scope, message, bytesIn, response, failed) {
  usageTracker.record(scope?.id, {
    rpcRequests: 1,
    rpcErrors: failed ? 1 : 0,
    bytesIn,
    method: message?.method || message?.type || "unknown"
  });
}

function logInlineImageRequest(req, detail) {
  const id = String(detail.id || "").slice(0, 48);
  const remote = req.socket?.remoteAddress || "";
  const ua = String(req.headers["user-agent"] || "").slice(0, 120);
  console.log(
    [
      "[inline-image]",
      `status=${detail.status}`,
      `source=${detail.source}`,
      `id=${id || "missing"}`,
      `bytes=${detail.bytes || 0}`,
      `type=${detail.mimeType || "-"}`,
      `remote=${remote || "-"}`,
      `ua=${ua || "-"}`
    ].join(" ")
  );
}

function logRpcServerDebug(event, message, scope, startedAt, bytesIn, response) {
  const method = message?.method || message?.type || "unknown";
  const elapsedMs = Math.round(performance.now() - startedAt);
  const slow = event === "error" || elapsedMs > serverSlowRpcThresholdMs(method);
  if (!slow) return;

  const bytesOut = Buffer.byteLength(JSON.stringify(response || {}));
  console.log(
    JSON.stringify({
      tag: "codex-webui:rpc",
      event,
      method,
      requestId: message?.requestId,
      elapsedMs,
      bytesIn,
      bytesOut,
      tokenHash: String(scope?.tokenHash || "").slice(0, 10),
      error: response?.error || undefined
    })
  );
}

function serverSlowRpcThresholdMs(method) {
  if (["turn/start", "turn/steer", "thread/read", "thread/turns/list"].includes(method)) return 5000;
  return 2000;
}

function sendCachedFile(req, res, image, contentType) {
  const { stat, fd } = image;
  const etag = fileEtag(stat);
  const lastModified = stat.mtime.toUTCString();
  const headers = {
    "content-type": contentType,
    "content-length": stat.size,
    "cache-control": LOCAL_FILE_CACHE_CONTROL,
    "last-modified": lastModified,
    etag,
    "x-content-type-options": "nosniff"
  };

  if (requestCacheIsFresh(req, etag, stat.mtimeMs)) {
    closeSync(fd);
    res.writeHead(304, cacheValidationHeaders(headers));
    res.end();
    return;
  }

  res.writeHead(200, headers);
  const stream = createReadStream(image.path, { fd, autoClose: true });
  stream.once("error", error => res.destroy(error));
  res.once("close", () => stream.destroy());
  stream.pipe(res);
}

function sendCachedBuffer(req, res, buffer, contentType, etag, createdAt) {
  const lastModified = new Date(createdAt || Date.now()).toUTCString();
  const headers = {
    "content-type": contentType,
    "content-length": buffer.length,
    "cache-control": INLINE_IMAGE_CACHE_CONTROL,
    "last-modified": lastModified,
    etag,
    "x-content-type-options": "nosniff"
  };

  if (requestCacheIsFresh(req, etag, createdAt)) {
    res.writeHead(304, cacheValidationHeaders(headers));
    res.end();
    return;
  }

  res.writeHead(200, headers);
  res.end(buffer);
}

function requestCacheIsFresh(req, etag, modifiedMs) {
  const ifNoneMatch = String(req.headers["if-none-match"] || "");
  if (ifNoneMatch) {
    return ifNoneMatch
      .split(",")
      .map((value) => value.trim())
      .includes(etag);
  }

  const ifModifiedSince = Date.parse(String(req.headers["if-modified-since"] || ""));
  if (!Number.isFinite(ifModifiedSince)) return false;
  return Math.floor(Number(modifiedMs || 0) / 1000) <= Math.floor(ifModifiedSince / 1000);
}

function cacheValidationHeaders(headers) {
  const next = { ...headers };
  delete next["content-length"];
  return next;
}

function fileEtag(stat) {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

function createTokenScopes() {
  const scopes = new Map();
  const envToken = String(process.env.CODEX_WEBUI_TOKEN || "").trim();
  if (envToken) {
    addTokenScope(scopes, envToken, process.env.CODEX_WEBUI_THREAD_FILTER_CWD || "", {
      id: "env-default",
      label: "Environment token"
    });
  }

  const rawScopes = String(process.env.CODEX_WEBUI_TOKEN_SCOPES || "").trim();
  if (rawScopes) {
    let index = 0;
    for (const entry of parseTokenScopeEntries(rawScopes)) {
      index += 1;
      addTokenScope(scopes, entry.token, entry.threadFilterCwds, {
        id: entry.id || `env-${index}`,
        label: entry.label || `Environment token ${index}`
      });
    }
  }

  if (!scopes.size) {
    const store = readTokenStore(dataDir);
    for (const entry of store.tokens) {
      if (entry.disabled) continue;
      addTokenScope(scopes, entry.token, entry.threadFilterCwds, entry);
    }
  }

  if (!scopes.size) throw new Error("No enabled Codex WebUI access tokens are configured.");

  return scopes;
}

function parseTokenScopeEntries(rawScopes) {
  if (!rawScopes) return [];
  try {
    const parsed = JSON.parse(rawScopes);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => ({
        id: String(entry?.id || ""),
        label: String(entry?.label || ""),
        token: String(entry?.token || ""),
        threadFilterCwds: scopePathListFromEntry(entry)
      }));
    }
    if (parsed && typeof parsed === "object") {
      return [{
        id: String(parsed.id || ""),
        label: String(parsed.label || ""),
        token: String(parsed.token || ""),
        threadFilterCwds: scopePathListFromEntry(parsed)
      }];
    }
  } catch {
    // Fall back to token=path;token2=path2 below.
  }

  return rawScopes
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf("=");
      return separator < 0
        ? { token: part, threadFilterCwds: [] }
        : { token: part.slice(0, separator), threadFilterCwds: splitScopePathList(part.slice(separator + 1)) };
    });
}

function addTokenScope(scopes, token, threadFilterCwds, metadata = {}) {
  const normalizedToken = String(token || "").trim();
  if (!normalizedToken) return;
  const normalizedFilters = splitScopePathList(threadFilterCwds)
    .map((entry) => normalizeLocalPath(entry || ""))
    .filter(Boolean);
  const primaryFilter = normalizedFilters[0] || "";
  scopes.set(normalizedToken, {
    id: String(metadata.id || `token-${scopes.size + 1}`),
    label: String(metadata.label || metadata.id || `Token ${scopes.size + 1}`),
    token: normalizedToken,
    tokenHash: createHash("sha256").update(normalizedToken).digest("hex"),
    threadFilterCwd: primaryFilter,
    threadFilterCwds: normalizedFilters,
    defaultCwd: primaryFilter || DEFAULT_CWD,
    visibleThreadIds: new Set()
  });
}

function scopePathListFromEntry(entry) {
  return splitScopePathList(
    entry?.threadFilterCwds
    || entry?.cwds
    || entry?.threadFilterCwd
    || entry?.cwd
    || ""
  );
}

function splitScopePathList(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  return String(value || "")
    .split("|")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function scopeFromToken(token) {
  refreshTokenScopesIfChanged();
  return tokenScopes.get(String(token || ""));
}

async function resolveRequestScope(req, url) {
  const bearer = /^Bearer ([^\s]+)$/i.exec(String(req.headers.authorization || ""));
  const tokenScope = scopeFromToken(bearer?.[1] || url.searchParams.get("token"));
  if (tokenScope) return tokenScope;
  let identity = null;
  try {
    identity = await cloudflareAccessAuthenticator.authenticateRequest(req);
  } catch (error) {
    console.warn(`[cloudflare-access] Authentication failed: ${error?.message || "unknown error"}`);
    return null;
  }
  if (!identity) {
    if (cloudflareAccessConfig) {
      console.warn("[cloudflare-access] Authentication skipped: cf-access-jwt-assertion header is missing.");
    }
    return null;
  }
  refreshTokenScopesIfChanged();
  const configuredScopeId = String(cloudflareAccessConfig?.tokenScopeId || "");
  const baseScope = configuredScopeId
    ? Array.from(tokenScopes.values()).find((scope) => scope.id === configuredScopeId)
    : defaultTokenScope;
  if (!baseScope) throw new Error("Cloudflare Access has no enabled WebUI token scope.");
  return createCloudflareAccessScope(baseScope, identity);
}

function createCloudflareAccessScope(baseScope, identity) {
  return {
    ...baseScope,
    authMode: "cloudflare-access",
    accessEmail: String(identity?.email || ""),
    accessExpiresAt: Number(identity?.expiresAt || 0)
  };
}

function refreshTokenScopesIfChanged() {
  if (usesEnvironmentTokens) return;
  const modifiedMs = currentTokenStoreModifiedMs();
  if (!modifiedMs || modifiedMs === tokenStoreModifiedMs) return;
  const nextScopes = createTokenScopes();
  tokenScopes = nextScopes;
  defaultTokenScope = nextScopes.values().next().value;
  tokenStoreModifiedMs = modifiedMs;
  console.log(`[tokens] Reloaded ${tokenScopes.size} enabled token(s).`);
}

function currentTokenStoreModifiedMs() {
  try {
    return statSync(tokenStorePath(dataDir)).mtimeMs;
  } catch {
    return 0;
  }
}

function uploadDirForScope(scope) {
  return path.join(uploadDir, String(scope?.id || "default").replace(/[^a-zA-Z0-9_-]/g, "-"));
}

function openAccessibleLocalImage(scope, requestedPath) {
  if (!requestedPath || !isLocalImagePath(requestedPath)) return null;
  let fd;
  try {
    const canonicalPath = realpathSync(requestedPath);
    if (!isLocalImagePath(canonicalPath) || !isCanonicalImageAccessible(scope, canonicalPath)) return null;
    fd = openSync(canonicalPath, "r");
    const opened = fstatSync(fd, { bigint: true });
    const verifiedPath = realpathSync(canonicalPath);
    const current = statSync(verifiedPath, { bigint: true });
    if (!opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino
      || !isCanonicalImageAccessible(scope, verifiedPath)) {
      closeSync(fd);
      return null;
    }
    return { path: verifiedPath, fd, stat: fstatSync(fd) };
  } catch {
    if (fd !== undefined) closeSync(fd);
    return null;
  }
}

function isCanonicalImageAccessible(scope, requestedPath) {
  if (isCodexClipboardImagePath(requestedPath)) return true;
  if (!hasThreadFilter(scope)) return true;
  const roots = [
    rootDir,
    uploadDirForScope(scope),
    scope?.defaultCwd,
    ...scopeFilterRoots(scope)
  ]
    .map((entry) => {
      try { return realpathSync(entry || ""); } catch { return ""; }
    })
    .filter(Boolean);
  return roots.some((root) => isPathInside(root, requestedPath));
}

function isCodexClipboardImagePath(requestedPath) {
  const normalizedPath = normalizeLocalPath(requestedPath || "");
  const tempRoot = realpathSync(os.tmpdir());
  if (!normalizedPath || !tempRoot || path.dirname(normalizedPath) !== tempRoot) return false;
  return /^codex-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g|webp|gif)$/i
    .test(path.basename(normalizedPath));
}

function isLocalImagePath(value) {
  const ext = path.extname(normalizeLocalPath(value || "")).toLowerCase();
  return imageMimesByExtension.has(ext) || ext === ".svg";
}

function formatTokenUrls(label, baseUrls) {
  const lines = [];
  for (const scope of tokenScopes.values()) {
    const filters = scopeFilterRoots(scope);
    const filterLabel = filters.length ? `  Filter: ${filters.join(" | ")}` : "";
    for (const baseUrl of baseUrls) {
      lines.push(`${label} [${scope.id}]: ${baseUrl}/?token=${scope.token}${filterLabel}`);
    }
  }
  return lines;
}

async function printAndWriteQrCodes(baseUrls) {
  const primaryBaseUrl = baseUrls[0];
  if (!primaryBaseUrl) return;
  const qrDir = path.join(dataDir, "qr");
  await mkdir(qrDir, { recursive: true });
  let first = true;
  for (const scope of tokenScopes.values()) {
    const url = `${primaryBaseUrl}/?token=${encodeURIComponent(scope.token)}`;
    const qrPath = path.join(qrDir, `${scope.id.replace(/[^a-zA-Z0-9_-]/g, "-")}.svg`);
    await QRCode.toFile(qrPath, url, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
    console.log(`QR [${scope.id}]: ${qrPath}`);
    if (first && process.env.CODEX_WEBUI_TERMINAL_QR !== "0") {
      console.log(`\nScan to open ${scope.label}:\n`);
      console.log(await QRCode.toString(url, { type: "terminal", small: true, errorCorrectionLevel: "M" }));
      first = false;
    }
  }
}

async function compactResultForClient(method, result, scope = defaultTokenScope) {
  if (method === "thread/list") return stripInlineDataImages(filterThreadListResult(result, scope));
  if (method === "thread/read" || method === "thread/start" || method === "thread/resume") {
    return stripInlineDataImages(result);
  }
  if (method === "thread/turns/list") return stripInlineDataImages(result);
  return stripInlineDataImages(result);
}


function filterThreadListResult(result, scope = defaultTokenScope) {
  if (!result || !Array.isArray(result.data)) return result;
  if (!hasThreadFilter(scope)) {
    for (const thread of result.data) {
      if (thread?.id) scope.visibleThreadIds.add(thread.id);
    }
    return result;
  }
  const data = result.data.filter((thread) => isThreadInFilter(thread, scope));
  scope.visibleThreadIds.clear();
  for (const thread of data) {
    if (thread?.id) scope.visibleThreadIds.add(thread.id);
  }
  return { ...result, data };
}

function rememberVisibleThreadFromResult(method, result, scope = defaultTokenScope) {
  if (!hasThreadFilter(scope)) return;
  if (method !== "thread/start" && method !== "thread/resume" && method !== "thread/read") return;
  const thread = result?.thread || result;
  if (thread?.id && isThreadInFilter(thread, scope)) {
    scope.visibleThreadIds.add(thread.id);
  }
}

async function ensureThreadAccess(method, params, scope = defaultTokenScope) {
  if (!hasThreadFilter(scope) || method === "thread/list" || method === "thread/start") return;
  const threadId = threadIdFromParams(params);
  if (!threadId) return;
  const result = await bridge.requestRaw("thread/read", { threadId,includeTurns:false });
  const thread = result?.thread || result;
  if (thread?.id && isThreadInFilter(thread, scope)) {
    scope.visibleThreadIds.add(thread.id);
    return result;
  }
  throw new Error("This token can only access sessions in the allowed folder.");
}

function threadIdFromParams(params) {
  return params?.threadId || params?.thread_id || params?.id || "";
}

function threadContextFromAppServerMessage(message) {
  const params = message?.params || {};
  const thread = params.thread || (params.threadSettings?.cwd ? {cwd:params.threadSettings.cwd} : params.cwd ? {cwd:params.cwd} : null);
  const threadId = params.threadId || params.thread_id || params.conversationId || thread?.id || "";
  return threadId ? { threadId, thread } : null;
}

function isThreadInFilter(thread, scope = defaultTokenScope) {
  const cwd = normalizeLocalPath(thread?.cwd || "");
  return Boolean(cwd && isPathAllowedInScope(scope, cwd));
}

function hasThreadFilter(scope) {
  return scopeFilterRoots(scope).length > 0;
}

function scopeFilterRoots(scope) {
  if (Array.isArray(scope?.threadFilterCwds) && scope.threadFilterCwds.length) {
    return scope.threadFilterCwds;
  }
  return scope?.threadFilterCwd ? [scope.threadFilterCwd] : [];
}

function isPathAllowedInScope(scope, value) {
  if(typeof value!=="string"||!value||value.startsWith("\\\\"))return false;
  try{
    const target=realpathSync(normalizeLocalPath(value));
    if(target.startsWith("\\\\"))return false;
    return scopeFilterRoots(scope).some(root=>{try{return canonicalPathInside(realpathSync(root),target);}catch{return false;}});
  }catch{return false;}
}

function normalizeReasoningEffortParam(params) {
  if (!params) return;
  if (!Object.prototype.hasOwnProperty.call(params, "effort") && params.reasoningEffort) {
    params.effort = params.reasoningEffort;
  }
  delete params.reasoningEffort;
  if (params.effort === "") delete params.effort;
}

function stripInlineDataImages(value) {
  if (typeof value === "string") return stripAttachmentReferences(value);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripInlineDataImages);

  const next = {};
  const isImageGeneration = value.type === "imageGeneration";
  for (const [key, entry] of Object.entries(value)) {
    if (key === "url" && typeof entry === "string" && entry.startsWith("data:image/")) {
      const inline = rememberInlineImage(entry);
      next.url = "";
      next.omittedBytes = Buffer.byteLength(entry);
      next.omittedReason = "inline image hidden";
      if (inline) {
        next.inlineImageId = inline.id;
        next.mimeType = inline.mimeType;
      }
    } else if (isImageGeneration && key === "result" && typeof entry === "string" && looksLikeBase64Image(entry)) {
      const inline = rememberInlineImagePayload(entry);
      next.result = "";
      next.omittedBytes = Buffer.byteLength(entry);
      next.omittedReason = "inline image hidden";
      if (inline) {
        next.inlineImageId = inline.id;
        next.mimeType = inline.mimeType;
      }
    } else {
      next[key] = stripInlineDataImages(entry);
    }
  }
  if (typeof value.text === "string") {
    const files = attachmentReferences(value.text);
    if (files.length) next.webuiAttachments = files;
  }
  return next;
}

function rememberInlineImage(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) return null;
  const [, mimeType, base64] = match;
  return rememberInlineImagePayload(base64, mimeType);
}

function rememberInlineImagePayload(base64, mimeType = imageMimeFromBase64(base64)) {
  if (!base64 || !mimeType) return null;
  const id = createHash("sha256").update(`${mimeType}:${base64}`).digest("base64url");
  if (!inlineImages.has(id)) {
    const entry = {
      id,
      mimeType,
      buffer: Buffer.from(base64, "base64"),
      createdAt: Date.now()
    };
    inlineImages.set(id, entry);
    trimInlineImageMemory();
    persistInlineImage(entry);
  }
  return { id, mimeType };
}

function trimInlineImageMemory() {
  while (inlineImages.size > inlineImageLimit) {
    const oldest = inlineImages.keys().next().value;
    inlineImages.delete(oldest);
  }
}

function persistInlineImage(entry) {
  const ext = imageExtensionsByMime.get(entry.mimeType);
  if (!ext || !isSafeInlineImageId(entry.id)) return;

  try {
    mkdirSync(inlineImageDir, { recursive: true });
    const filePath = path.join(inlineImageDir, `${entry.id}${ext}`);
    if (existsSync(filePath)) return;
    writeFile(filePath, entry.buffer).catch(() => {});
  } catch {
    // In-memory serving still works when disk persistence is unavailable.
  }
}

async function readPersistedInlineImage(id) {
  if (!isSafeInlineImageId(id)) return null;

  for (const [mimeType, ext] of imageExtensionsByMime) {
    const filePath = path.join(inlineImageDir, `${id}${ext}`);
    if (!existsSync(filePath)) continue;
    try {
      const buffer = await readFile(filePath);
      const entry = {
        id,
        mimeType,
        buffer,
        createdAt: statSync(filePath).mtimeMs
      };
      inlineImages.set(id, entry);
      trimInlineImageMemory();
      return entry;
    } catch {
      return null;
    }
  }

  return null;
}

function isSafeInlineImageId(id) {
  return /^[A-Za-z0-9_-]+$/.test(String(id || ""));
}

function looksLikeBase64Image(value) {
  if (typeof value !== "string" || value.length < 80) return false;
  return Boolean(imageMimeFromBase64(value));
}

function imageMimeFromBase64(value) {
  if (value.startsWith("iVBORw0KGgo")) return "image/png";
  if (value.startsWith("/9j/")) return "image/jpeg";
  if (value.startsWith("R0lGOD")) return "image/gif";
  if (value.startsWith("UklGR")) return "image/webp";
  return "";
}

function normalizeLocalPath(value) {
  if (!value) return "";
  let next = value;
  if (/^\/[a-zA-Z]:\//.test(next)) {
    next = next.slice(1);
  }
  return path.resolve(next);
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalPathInside(parent,child){
  const key=value=>String(value).replace(/^[a-z]:/i,drive=>drive.toUpperCase()).replace(/[\\/]+$/,"");
  const base=key(parent),target=key(child);return target===base||target.startsWith(base+path.sep);
}

function readRequestBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("Upload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

process.on("SIGINT", () => {
  usageTracker.flush();
  process.exit(0);
});

process.on("SIGTERM", () => {
  usageTracker.flush();
  process.exit(0);
});
