// Decode sandbox child stdout/stderr cleanly on Windows (UTF-8 first, GB18030/GBK fallback for native Windows CLIs)
// and direct UTF-8 on POSIX/Linux. Never throws.
const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });
let gb18030Fatal: TextDecoder | null | undefined;

function getGb18030(): TextDecoder | null {
  if (gb18030Fatal !== undefined) return gb18030Fatal;
  try {
    gb18030Fatal = new TextDecoder("gb18030", { fatal: true });
  } catch {
    gb18030Fatal = null;
  }
  return gb18030Fatal;
}

function decodeSegment(buf: Uint8Array, gb: TextDecoder): string {
  try {
    return UTF8_FATAL.decode(buf);
  } catch {
    try {
      return gb.decode(buf);
    } catch {
      return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString("utf8");
    }
  }
}

/**
 * Decode a sandbox child output buffer to UTF-8 text.
 * On Linux/macOS: direct UTF-8.
 * On Windows: strict UTF-8 fast path; if invalid UTF-8 and non-binary (no NUL byte), tries GB18030/GBK whole-buffer,
 * then line-by-line (for mixed UTF-8 + GBK output such as Git Bash + cmd/ipconfig). Falls back to lossy UTF-8.
 */
export function decodeSandboxOutput(buf: Buffer, platform: NodeJS.Platform = process.platform): string {
  if (buf.length === 0) return "";
  if (platform !== "win32") return buf.toString("utf8");
  try {
    return UTF8_FATAL.decode(buf);
  } catch {
    if (buf.includes(0)) return buf.toString("utf8");
    const gb = getGb18030();
    if (gb === null) return buf.toString("utf8");
    try {
      return gb.decode(buf);
    } catch {
      const parts: string[] = [];
      let start = 0;
      for (let i = 0; i < buf.length; i += 1) {
        if (buf[i] === 0x0a) {
          parts.push(decodeSegment(buf.subarray(start, i + 1), gb));
          start = i + 1;
        }
      }
      if (start < buf.length) parts.push(decodeSegment(buf.subarray(start), gb));
      return parts.join("");
    }
  }
}
