import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import readline from "node:readline";
import path from "node:path";
import { resolveDataDir } from "./token-store.js";

// The native proxy authenticates the server on the same connected pipe handle.
// No protocol bytes, including the bridge secret, are sent before that check.
export class VerifiedPipeTransport extends Duplex {
  constructor(pipePath) {
    super();
    this.verified = false;
    const executable = process.env.CODEX_WEBUI_PIPE_CLIENT_PATH
      || path.join(resolveDataDir(), "desktop-bridge/runtime/windows-v3/codex-webui-bridge.exe");
    this.child = spawn(executable, ["--pipe-client", pipePath], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true
    });
    this.child.stdout.on("data", chunk => { if (!this.push(chunk)) this.child.stdout.pause(); });
    this.child.stdout.on("end", () => this.push(null));
    this.child.on("error", error => this.destroy(new Error(`Pipe peer verification failed: ${error.message}`)));
    this.child.stdin.on("error", error => this.destroy(error));
    let diagnostic = "";
    readline.createInterface({ input: this.child.stderr }).on("line", line => {
      if (line === "CODEX_PIPE_VERIFIED") {
        this.verified = true;
        this.emit("connect");
      } else if (diagnostic.length < 2000) diagnostic += `${line}\n`;
    });
    this.child.once("exit", code => {
      if (!this.verified || code !== 0) {
        this.destroy(new Error(`Pipe peer verification failed: ${diagnostic.trim() || `helper exited (${code})`}`));
      } else this.destroy();
    });
  }

  setNoDelay() { return this; }
  _read() { this.child?.stdout.resume(); }
  _write(chunk, encoding, callback) {
    if (!this.verified) return callback(new Error("Pipe peer has not been verified."));
    this.child.stdin.write(chunk, encoding, callback);
  }
  _destroy(error, callback) {
    this.child?.stdin.destroy();
    this.child?.stdout.destroy();
    this.child?.stderr.destroy();
    if (this.child && this.child.exitCode === null) this.child.kill();
    callback(error);
  }
}
