// x core — "paste anything, make it readable".
//
// detect(input) runs every detector over a string and returns ranked candidates
// (confidence 0-100): JWT, JSON, base64/base64url, URL-encoding, epoch
// timestamps, UUIDs, hex hashes, hex colors, cron expressions.
//
// Pure string functions: ZERO network, nothing persisted, no dependencies —
// the point is that tokens/payloads never leave the machine (unlike jwt.io,
// base64decode.org, epochconverter.com et al).

export interface Detection {
  /** Stable id used by `--as <type>`. */
  type: string;
  /** Human name shown as the result heading. */
  label: string;
  /** 0-100; detect() returns candidates sorted by this, best first. */
  confidence: number;
  /** Rendered, multi-line, ready to print. */
  output: string;
  /** Warning or caveat (e.g. "alg: none", "decoded but NOT verified"). */
  note?: string;
}

type Detector = (input: string) => Detection | null;

// ---- shared helpers ----

/** "3h ago" / "in 12m" for an absolute epoch-ms instant. */
export function relTime(ms: number, now = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [31536000000, "y"],
    [2592000000, "mo"],
    [86400000, "d"],
    [3600000, "h"],
    [60000, "m"],
    [1000, "s"],
  ];
  for (const [size, name] of units) {
    if (abs >= size) {
      const n = Math.round(abs / size);
      return diff < 0 ? `${n}${name} ago` : `in ${n}${name}`;
    }
  }
  return diff <= 0 ? "just now" : "now";
}

function fmtInstant(ms: number): string[] {
  const d = new Date(ms);
  return [
    `local  ${d.toLocaleString()}`,
    `utc    ${d.toISOString()}`,
    `rel    ${relTime(ms)}`,
  ];
}

/** Share of characters that read as text (tabs/newlines ok, no replacement chars). */
function printableRatio(s: string): number {
  const chars = [...s];
  if (!chars.length) return 0;
  let ok = 0;
  for (const ch of chars) {
    const c = ch.codePointAt(0)!;
    if (c === 0xfffd) continue; // utf8 decode failure
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c > 160) ok++;
  }
  return ok / chars.length;
}

function b64urlToText(part: string): string | null {
  try {
    return Buffer.from(part, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

// ---- detectors ----

const JWT_TIME_CLAIMS = ["exp", "iat", "nbf"] as const;

function dJwt(input: string): Detection | null {
  const parts = input.split(".");
  if (parts.length !== 3) return null;
  // Signature may be EMPTY (alg:none tokens end "header.payload."), the first
  // two parts may not.
  if (!/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]+$/.test(parts[1]!)) return null;
  if (parts[2] !== "" && !/^[A-Za-z0-9_-]+$/.test(parts[2]!)) return null;
  const headText = b64urlToText(parts[0]!);
  const bodyText = b64urlToText(parts[1]!);
  if (!headText || !bodyText) return null;
  let header: any, payload: any;
  try {
    header = JSON.parse(headText);
    payload = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (typeof header !== "object" || header === null || !("alg" in header)) return null;

  const lines: string[] = ["HEADER", ...pretty(header).split("\n"), "", "PAYLOAD", ...pretty(payload).split("\n")];
  const times: string[] = [];
  if (typeof payload === "object" && payload !== null) {
    for (const claim of JWT_TIME_CLAIMS) {
      const v = (payload as any)[claim];
      if (typeof v === "number") {
        const ms = v * 1000;
        const what = claim === "exp" ? (ms < Date.now() ? "EXPIRED" : "expires") : claim === "iat" ? "issued" : "not before";
        times.push(`${claim}  ${what} ${relTime(ms)}  (${new Date(ms).toLocaleString()})`);
      }
    }
  }
  if (times.length) lines.push("", "TIME", ...times);

  const algNone = String(header.alg).toLowerCase() === "none";
  return {
    type: "jwt",
    label: "JWT",
    confidence: 98,
    output: lines.join("\n"),
    note: algNone
      ? "!! alg: none — this token is UNSIGNED. Decoded only; nothing is verified."
      : "decoded only — signature NOT verified (no key)",
  };
}

function dJson(input: string): Detection | null {
  const t = input.trim();
  const looksJson = /^[[{"]/.test(t) || t === "true" || t === "false" || t === "null";
  try {
    const parsed = JSON.parse(t);
    // Bare numbers/strings parse but aren't interesting as "JSON".
    if (typeof parsed !== "object" || parsed === null) return null;
    return { type: "json", label: "JSON", confidence: 95, output: pretty(parsed) };
  } catch (e) {
    if (!looksJson) return null;
    const msg = e instanceof Error ? e.message : String(e);
    const hints: string[] = [];
    if (/,\s*[}\]]/.test(t)) hints.push("has a trailing comma (JSON forbids them)");
    if (/'[^']*'\s*:/.test(t)) hints.push("uses single-quoted keys (JSON needs double quotes)");
    if (/[{,]\s*[A-Za-z_][A-Za-z0-9_]*\s*:/.test(t)) hints.push("has unquoted keys");
    return {
      type: "json",
      label: "JSON (malformed)",
      confidence: 40,
      output: [`parse error: ${msg}`, ...hints.map((h) => `hint: ${h}`)].join("\n"),
    };
  }
}

function dEpoch(input: string): Detection | null {
  const t = input.trim();
  if (!/^\d{10}$|^\d{13}$/.test(t)) return null;
  const n = Number(t);
  const ms = t.length === 13 ? n : n * 1000;
  // Plausible window: 2001..2100 — outside it, it's probably just a number.
  if (ms < 978307200000 || ms > 4102444800000) return null;
  const unit = t.length === 13 ? "milliseconds" : "seconds";
  return {
    type: "epoch",
    label: `Unix time (${unit})`,
    confidence: 90,
    output: fmtInstant(ms).join("\n"),
  };
}

function dUuid(input: string): Detection | null {
  const t = input.trim().toLowerCase();
  const m = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/.exec(t);
  if (!m) return null;
  const version = Number.parseInt(t[14]!, 16);
  const variantNibble = Number.parseInt(t[19]!, 16);
  const variant = variantNibble >= 8 && variantNibble <= 11 ? "RFC 4122" : "non-standard";
  const lines = [`version ${version}`, `variant ${variant}`];
  if (version === 7) {
    // v7: first 48 bits are unix epoch ms.
    const ms = Number.parseInt(t.slice(0, 8) + t.slice(9, 13), 16);
    lines.push("", "embedded time:", ...fmtInstant(ms));
  }
  return { type: "uuid", label: `UUID v${version}`, confidence: 95, output: lines.join("\n") };
}

function dColor(input: string): Detection | null {
  const t = input.trim();
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(t);
  if (!m) return null;
  let hex = m[1]!;
  // Without a leading # a 3/4-char hex is too ambiguous; 6/8 gets low confidence.
  const hasHash = t.startsWith("#");
  if (!hasHash && hex.length <= 4) return null;
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("");
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : null;
  // rgb -> hsl
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0, s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
    if (h < 0) h += 360;
  }
  const rgb = a === null ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`;
  const hsl = `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
  return {
    type: "color",
    label: "Color",
    confidence: hasHash ? 95 : 55,
    output: [rgb, hsl].join("\n"),
  };
}

const CRON_FIELDS = ["minute", "hour", "day of month", "month", "day of week"];
const CRON_TOKEN = /^(\*|\d+)(-(\*|\d+))?(\/\d+)?$/;

function describeCronField(field: string, name: string): string | null {
  const parts = field.split(",");
  const descs: string[] = [];
  for (const p of parts) {
    const m = CRON_TOKEN.exec(p);
    if (!m) return null; // names (MON, JAN) etc — out of scope for v1
    const [, base, , rangeEnd, step] = m;
    if (step) {
      const n = step.slice(1);
      descs.push(base === "*" ? `every ${n}` : rangeEnd ? `every ${n} from ${base} to ${rangeEnd}` : `every ${n} from ${base}`);
    } else if (rangeEnd) {
      descs.push(`${base} through ${rangeEnd}`);
    } else if (base === "*") {
      descs.push("every");
    } else {
      descs.push(base!);
    }
  }
  return descs.join(", ");
}

function dCron(input: string): Detection | null {
  const fields = input.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return null;
  const names = fields.length === 6 ? ["second", ...CRON_FIELDS] : CRON_FIELDS;
  const lines: string[] = [];
  // Require at least one * or step so a plain "1 2 3 4 5" doesn't match hard.
  let wildcards = 0;
  for (let i = 0; i < fields.length; i++) {
    const desc = describeCronField(fields[i]!, names[i]!);
    if (desc === null) return null;
    if (fields[i]!.includes("*") || fields[i]!.includes("/")) wildcards++;
    lines.push(`${names[i]!.padEnd(14)}${desc}`);
  }
  if (wildcards === 0) return null;
  return {
    type: "cron",
    label: "Cron expression",
    confidence: 85,
    output: lines.join("\n"),
    note: fields.length === 6 ? "6 fields — read as seconds-first (Quartz style)" : undefined,
  };
}

function dUrl(input: string): Detection | null {
  const t = input.trim();
  if (!/%[0-9A-Fa-f]{2}/.test(t)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(t.replace(/\+/g, " "));
  } catch {
    return null;
  }
  if (decoded === t) return null;
  const lines = [decoded];
  // Bonus: render query strings as key = value rows.
  const qs = decoded.includes("?") ? decoded.slice(decoded.indexOf("?") + 1) : decoded;
  if (/[^&=]+=[^&]*/.test(qs) && qs.includes("=")) {
    const params = qs.split("&").filter((p) => p.includes("="));
    if (params.length > 1) {
      lines.push("", "PARAMS");
      for (const p of params) {
        const i = p.indexOf("=");
        lines.push(`${p.slice(0, i).padEnd(20)}${p.slice(i + 1)}`);
      }
    }
  }
  return { type: "url", label: "URL-encoded", confidence: 75, output: lines.join("\n") };
}

function dB64(input: string): Detection | null {
  const t = input.trim();
  if (t.length < 8) return null;
  const std = /^[A-Za-z0-9+/]+={0,2}$/.test(t) && t.length % 4 === 0;
  const url = /^[A-Za-z0-9_-]+$/.test(t) && t.length % 4 !== 1;
  if (!std && !url) return null;
  // Pure digits or pure hex are better explained by epoch/hash.
  if (/^\d+$/.test(t)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(t, std ? "base64" : "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!decoded.length || printableRatio(decoded) < 0.85) return null;
  // If it decodes to JSON, that's almost certainly what it is.
  try {
    const parsed = JSON.parse(decoded);
    if (typeof parsed === "object" && parsed !== null) {
      return {
        type: "base64",
        label: `Base64${std ? "" : "url"} -> JSON`,
        confidence: 88,
        output: pretty(parsed),
      };
    }
  } catch {
    /* not JSON — fall through to plain text */
  }
  // All-alphabetic short words ("deadbeef", "hello") often pass by luck — damp them.
  const confidence = /^[A-Za-z]+$/.test(t) && t.length < 16 ? 30 : 65;
  return { type: "base64", label: `Base64${std ? "" : "url"} -> text`, confidence, output: decoded };
}

const HASH_BITS: Record<number, string> = { 32: "md5", 40: "sha1", 64: "sha256", 96: "sha384", 128: "sha512" };

function dHash(input: string): Detection | null {
  const t = input.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(t)) return null;
  const guess = HASH_BITS[t.length];
  if (!guess) return null;
  return {
    type: "hash",
    label: "Hex digest",
    confidence: 50,
    output: `${t.length} hex chars (${t.length * 4} bits) — likely ${guess} (or any ${t.length * 4}-bit hex: HMAC, blake, random id)`,
  };
}

// Order only matters for equal confidence (stable sort keeps this order).
const DETECTORS: Detector[] = [dJwt, dJson, dEpoch, dUuid, dColor, dCron, dUrl, dB64, dHash];

export const DETECTOR_TYPES = ["jwt", "json", "epoch", "uuid", "color", "cron", "url", "base64", "hash"];

/** All candidate readings of the input, best first. Empty = nothing matched. */
export function detect(input: string): Detection[] {
  const t = input.trim();
  if (!t) return [];
  const out: Detection[] = [];
  for (const d of DETECTORS) {
    const r = d(t);
    if (r) out.push(r);
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}
