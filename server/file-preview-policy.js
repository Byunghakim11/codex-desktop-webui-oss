import path from "node:path";

export const FILE_LIMITS = Object.freeze({ entries: 500, scanned: 5000, textBytes: 1048576, lines: 20000, imageBytes: 20 * 1048576, imagePixels: 32000000, downloadBytes: 2 * 1024 ** 3 });
export function pdfPreviewInfo(bytes,size){return size<=25*1048576&&bytes.subarray(0,1024).includes(Buffer.from("%PDF-"))?{mime:"application/pdf",kind:"pdf"}:null;}
export function fileError(status, code) { return Object.assign(new Error(code), { status, code }); }
export function safeRelativePath(value) {
  if (typeof value !== "string" || value.length > 4096 || /[\\:\x00-\x1f\x7f]/.test(value) || value.startsWith("/")) throw fileError(400, "INVALID_PATH");
  if (value && value.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw fileError(400, "INVALID_PATH");
  return value;
}
const hidden = /^(?:\.git|node_modules|\.venv|venv|__pycache__|\.local|\.vendor|\.superpowers|\.codex|\.opencodex|\.hermes|\.ssh|\.aws|\.azure|\.gnupg|appdata|\.config|\.npmrc|\.pypirc|\.netrc|\.env(?:\..*)?|auth\.(?:json|db)|tokens\.json|cloudflare-access\.json|.*credentials.*|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|kdbx))$/i;
export function hiddenProjectPath(value) { return String(value).split(/[\\/]/).some(part => hidden.test(part)); }
export function restrictedProjectRoot(value) {
  const parts=String(value).toLowerCase().split(/[\\/]/);
  return parts.some((part,index)=>{
    if(part===".codex")return parts[index+1]!=="worktrees";
    if(part==="appdata")return !(parts[index+1]==="local"&&parts[index+2]==="temp");
    return hidden.test(part);
  })||hiddenProjectPath(path.basename(value));
}
const textExtensions = new Set(".txt .md .markdown .json .jsonc .js .mjs .cjs .ts .tsx .jsx .py .rs .go .cs .c .h .cpp .hpp .java .kt .dart .swift .sh .ps1 .bat .cmd .yml .yaml .toml .ini .cfg .conf .csv .tsv .xml .html .htm .css .scss .sql .log .tex .rst .gitignore .gitattributes .editorconfig".split(" "));
export function isTextFile(name) { return textExtensions.has(path.extname(name).toLowerCase()) || textExtensions.has(path.basename(name).toLowerCase()) || /^(readme|license|makefile|dockerfile)(\..*)?$/i.test(path.basename(name)); }
export function rasterInfo(bytes) {
  let width, height, mime;
  if (bytes.length >= 24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) { width=bytes.readUInt32BE(16); height=bytes.readUInt32BE(20); mime="image/png"; }
  else if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.subarray(0,6).toString())) { width=bytes.readUInt16LE(6); height=bytes.readUInt16LE(8); mime="image/gif"; }
  else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    for (let i=2;i+9<bytes.length;) {
      if(bytes[i++]!==255) break; const marker=bytes[i++]; if(marker===0xd9||marker===0xda) break;
      const length=bytes.readUInt16BE(i); if(length<2) break;
      if([0xc0,0xc1,0xc2].includes(marker)) { height=bytes.readUInt16BE(i+3); width=bytes.readUInt16BE(i+5); mime="image/jpeg"; break; } i+=length;
    }
  }
  return width > 0 && height > 0 && width * height <= FILE_LIMITS.imagePixels ? { mime, width, height } : null;
}
export function attachmentName(name) {
  const cleaned = Array.from(path.basename(name).replace(/[\x00-\x1f\x7f"\\/]/g, "_")).slice(0, 180).join("") || "download";
  const fallback = cleaned.replace(/[^\x20-\x7e]/g,"_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(cleaned).replace(/['()*]/g,c=>`%${c.charCodeAt(0).toString(16)}`)}`;
}
