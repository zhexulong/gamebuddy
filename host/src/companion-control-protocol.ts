const UTF8 = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export const CONTROL_PROTOCOL_VERSION = 1 as const;
export const MAX_CONTROL_LINE_BYTES = 16 * 1024;
export const MAX_CONTROL_IDENTIFIER_BYTES = 128;
export const MAX_CONTROL_LAUNCH_TOKEN_BYTES = 256;
export const MAX_CONTROL_TEXT_BYTES = 4_000;
export const MAX_CONTROL_LOCALE_BYTES = 64;

export type HelloControlRequest = Readonly<{
  type: "hello";
  protocolVersion: 1;
  launchToken: string;
}>;

export type PlayerInputControlRequest = Readonly<{
  type: "player_input";
  requestId: string;
  runtimeInstanceId: string;
  sourceEventId: string;
  text: string;
  locale: string;
}>;

export type StopAllControlRequest = Readonly<{
  type: "stop_all";
  requestId: string;
  runtimeInstanceId: string;
  stopId: string;
  sourceEventId: string;
  playerText?: string;
  locale?: string;
}>;

export type ControlRequest = HelloControlRequest | PlayerInputControlRequest | StopAllControlRequest;

export type ControlProtocolErrorCode =
  | "control_line_too_large"
  | "invalid_control_encoding"
  | "invalid_control_json"
  | "duplicate_control_json_key"
  | "invalid_control_request"
  | "incomplete_control_frame";

export class ControlProtocolError extends Error {
  public constructor(public readonly code: ControlProtocolErrorCode) {
    super(code);
    this.name = "ControlProtocolError";
  }
}

/**
 * Strictly validates one complete NDJSON record. Newline framing belongs to
 * ControlRequestFramer so a payload string can never be interpreted as STOP.
 */
export function decodeControlRequestLine(line: string): ControlRequest {
  if (typeof line !== "string" || UTF8.encode(line).byteLength > MAX_CONTROL_LINE_BYTES) {
    throw new ControlProtocolError("control_line_too_large");
  }
  if (line.includes("\n") || line.includes("\r")) throw new ControlProtocolError("invalid_control_json");

  const value = parseJsonWithoutDuplicateKeys(line);
  return validateControlRequest(value);
}

/** Serializes only a validated v1 request as exactly one NDJSON record. */
export function encodeControlRequest(request: ControlRequest): string {
  const normalized = validateControlRequest(request);
  const line = JSON.stringify(normalized);
  if (UTF8.encode(line).byteLength > MAX_CONTROL_LINE_BYTES) throw new ControlProtocolError("control_line_too_large");
  return `${line}\n`;
}

/**
 * Incremental byte framer for a single connection. It accepts arbitrary chunk
 * boundaries (including a UTF-8 code point split across chunks), emits only
 * complete newline-delimited records, and refuses unbounded partial input.
 */
export class ControlRequestFramer {
  #pending = new Uint8Array();

  public push(chunk: Uint8Array): ControlRequest[] {
    if (!(chunk instanceof Uint8Array)) throw new ControlProtocolError("invalid_control_encoding");
    const merged = new Uint8Array(this.#pending.byteLength + chunk.byteLength);
    merged.set(this.#pending);
    merged.set(chunk, this.#pending.byteLength);

    const requests: ControlRequest[] = [];
    let start = 0;
    for (let index = 0; index < merged.byteLength; index += 1) {
      if (merged[index] !== 0x0a) continue;
      let end = index;
      if (end > start && merged[end - 1] === 0x0d) end -= 1;
      const lineBytes = merged.subarray(start, end);
      if (lineBytes.byteLength > MAX_CONTROL_LINE_BYTES) throw new ControlProtocolError("control_line_too_large");
      requests.push(decodeControlRequestLine(decodeUtf8(lineBytes)));
      start = index + 1;
    }

    this.#pending = merged.slice(start);
    if (this.#pending.byteLength > MAX_CONTROL_LINE_BYTES) throw new ControlProtocolError("control_line_too_large");
    return requests;
  }

  /** A connection close must not silently accept a trailing partial request. */
  public finish(): void {
    if (this.#pending.byteLength !== 0) throw new ControlProtocolError("incomplete_control_frame");
  }
}

export function validateControlRequest(value: unknown): ControlRequest {
  if (!isPlainRecord(value) || typeof value.type !== "string") throw new ControlProtocolError("invalid_control_request");

  switch (value.type) {
    case "hello":
      assertExactKeys(value, ["type", "protocolVersion", "launchToken"]);
      if (value.protocolVersion !== CONTROL_PROTOCOL_VERSION || !isLaunchToken(value.launchToken)) {
        throw new ControlProtocolError("invalid_control_request");
      }
      return Object.freeze({ type: "hello", protocolVersion: CONTROL_PROTOCOL_VERSION, launchToken: value.launchToken });
    case "player_input":
      assertExactKeys(value, ["type", "requestId", "runtimeInstanceId", "sourceEventId", "text", "locale"]);
      if (
        !isIdentifier(value.requestId) ||
        !isIdentifier(value.runtimeInstanceId) ||
        !isIdentifier(value.sourceEventId) ||
        !isPlayerText(value.text) ||
        !isLocale(value.locale)
      ) {
        throw new ControlProtocolError("invalid_control_request");
      }
      return Object.freeze({
        type: "player_input",
        requestId: value.requestId,
        runtimeInstanceId: value.runtimeInstanceId,
        sourceEventId: value.sourceEventId,
        text: value.text,
        locale: value.locale,
      });
    case "stop_all": {
      assertExactKeys(value, ["type", "requestId", "runtimeInstanceId", "stopId", "sourceEventId"], ["playerText", "locale"]);
      if (
        !isIdentifier(value.requestId) ||
        !isIdentifier(value.runtimeInstanceId) ||
        !isIdentifier(value.stopId) ||
        !isIdentifier(value.sourceEventId) ||
        (value.playerText !== undefined && !isPlayerText(value.playerText)) ||
        (value.locale !== undefined && !isLocale(value.locale))
      ) {
        throw new ControlProtocolError("invalid_control_request");
      }
      return Object.freeze({
        type: "stop_all",
        requestId: value.requestId,
        runtimeInstanceId: value.runtimeInstanceId,
        stopId: value.stopId,
        sourceEventId: value.sourceEventId,
        ...(value.playerText === undefined ? {} : { playerText: value.playerText }),
        ...(value.locale === undefined ? {} : { locale: value.locale }),
      });
    }
    default:
      throw new ControlProtocolError("invalid_control_request");
  }
}

function assertExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const keys = Object.keys(value);
  if (
    keys.length < required.length ||
    !required.every((key) => Object.hasOwn(value, key)) ||
    !keys.every((key) => required.includes(key) || optional.includes(key))
  ) {
    throw new ControlProtocolError("invalid_control_request");
  }
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    UTF8.encode(value).byteLength <= MAX_CONTROL_IDENTIFIER_BYTES &&
    /^[A-Za-z0-9_-]{1,128}$/.test(value)
  );
}

function isLaunchToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    UTF8.encode(value).byteLength >= 16 &&
    UTF8.encode(value).byteLength <= MAX_CONTROL_LAUNCH_TOKEN_BYTES &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function isPlayerText(value: unknown): value is string {
  return typeof value === "string" && UTF8.encode(value).byteLength > 0 && UTF8.encode(value).byteLength <= MAX_CONTROL_TEXT_BYTES;
}

function isLocale(value: unknown): value is string {
  return (
    typeof value === "string" &&
    UTF8.encode(value).byteLength <= MAX_CONTROL_LOCALE_BYTES &&
    /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,16}){0,3}$/.test(value)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new ControlProtocolError("invalid_control_encoding");
  }
}

/** JSON.parse accepts duplicate object keys; the control protocol never does. */
function parseJsonWithoutDuplicateKeys(text: string): unknown {
  try {
    const scanner = new DuplicateKeyScanner(text);
    scanner.scanValue();
    scanner.skipWhitespace();
    if (!scanner.atEnd()) throw new SyntaxError("trailing JSON data");
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof ControlProtocolError) throw error;
    if (error instanceof DuplicateKeyError) throw new ControlProtocolError("duplicate_control_json_key");
    throw new ControlProtocolError("invalid_control_json");
  }
}

class DuplicateKeyError extends Error {}

class DuplicateKeyScanner {
  #position = 0;

  public constructor(private readonly text: string) {}

  public atEnd(): boolean {
    return this.#position === this.text.length;
  }

  public skipWhitespace(): void {
    while (this.#position < this.text.length && /[\t\n\r ]/.test(this.text[this.#position]!)) this.#position += 1;
  }

  public scanValue(): void {
    this.skipWhitespace();
    const character = this.text[this.#position];
    if (character === "{") return this.scanObject();
    if (character === "[") return this.scanArray();
    if (character === '"') return void this.scanString();
    if (this.text.startsWith("true", this.#position)) return void (this.#position += 4);
    if (this.text.startsWith("false", this.#position)) return void (this.#position += 5);
    if (this.text.startsWith("null", this.#position)) return void (this.#position += 4);
    this.scanNumber();
  }

  private scanObject(): void {
    this.#position += 1;
    this.skipWhitespace();
    const keys = new Set<string>();
    if (this.text[this.#position] === "}") return void (this.#position += 1);
    while (true) {
      this.skipWhitespace();
      if (this.text[this.#position] !== '"') throw new SyntaxError("object key required");
      const key = this.scanString();
      if (keys.has(key)) throw new DuplicateKeyError();
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.#position] !== ":") throw new SyntaxError("object colon required");
      this.#position += 1;
      this.scanValue();
      this.skipWhitespace();
      if (this.text[this.#position] === "}") return void (this.#position += 1);
      if (this.text[this.#position] !== ",") throw new SyntaxError("object comma required");
      this.#position += 1;
    }
  }

  private scanArray(): void {
    this.#position += 1;
    this.skipWhitespace();
    if (this.text[this.#position] === "]") return void (this.#position += 1);
    while (true) {
      this.scanValue();
      this.skipWhitespace();
      if (this.text[this.#position] === "]") return void (this.#position += 1);
      if (this.text[this.#position] !== ",") throw new SyntaxError("array comma required");
      this.#position += 1;
    }
  }

  private scanString(): string {
    const start = this.#position;
    this.#position += 1;
    while (this.#position < this.text.length) {
      const character = this.text[this.#position]!;
      if (character === '"') {
        this.#position += 1;
        return JSON.parse(this.text.slice(start, this.#position)) as string;
      }
      if (character === "\\") {
        this.#position += 1;
        const escape = this.text[this.#position];
        if (escape === "u") this.#position += 5;
        else if (escape === '"' || escape === "\\" || escape === "/" || escape === "b" || escape === "f" || escape === "n" || escape === "r" || escape === "t") this.#position += 1;
        else throw new SyntaxError("invalid string escape");
      } else {
        if (character.charCodeAt(0) < 0x20) throw new SyntaxError("control character in string");
        this.#position += 1;
      }
    }
    throw new SyntaxError("unterminated string");
  }

  private scanNumber(): void {
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.text.slice(this.#position));
    if (!match) throw new SyntaxError("value required");
    this.#position += match[0].length;
  }
}
