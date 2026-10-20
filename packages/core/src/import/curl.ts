import type { HttpMethod } from "../contract/request.js";
import { isCredentialFieldName, redactCommonCredentialText } from "./schemaMapping.js";

export interface CurlSourcePosition { offset: number; line: number; column: number }
export interface CurlDiagnostic extends CurlSourcePosition {
  severity: "warning" | "error";
  code: string;
  path: string;
  message: string;
  lossy: boolean;
}
export class CurlParseError extends Error {
  constructor(public readonly diagnostic: CurlDiagnostic) {
    super(`${diagnostic.message} (${diagnostic.line}:${diagnostic.column})`);
    this.name = "CurlParseError";
  }
}
type Pair = { name: string; value: string };
export type CurlBodyDeclaration =
  | { kind: "data" | "data-raw" | "data-binary"; value: string; fileReference: boolean }
  | { kind: "data-urlencode"; name?: string; value: string; fileReference: boolean }
  | { kind: "form"; name: string; value: { kind: "text"; text: string } | { kind: "file"; contentType?: string; filename?: string } };
export interface CurlParseResult {
  request: {
    method: HttpMethod; baseUrl: string; path: string; query: Pair[]; headers: Pair[]; cookies: Pair[];
    auth: { kind: "none" } | { kind: "basic"; username: string } | { kind: "bearer" } | { kind: "apikey"; name: string; placement: "header" };
    body: CurlBodyDeclaration[];
  };
  declarations: Array<CurlSourcePosition & { option: string }>;
  diagnostics: CurlDiagnostic[];
}
interface Token extends CurlSourcePosition { value: string }
const START: CurlSourcePosition = { offset: 0, line: 1, column: 1 };
function fail(position: CurlSourcePosition, code: string, message: string): never {
  throw new CurlParseError({ ...position, severity: "error", code, path: `source/${position.offset}`, message, lossy: false });
}

/** Tokenize a single POSIX declaration. No expansion, shell evaluation, I/O or subprocesses. */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0, line = 1, column = 1;
  const position = (): CurlSourcePosition => ({ offset, line, column });
  const advance = () => { if (source[offset++] === "\n") { line++; column = 1; } else column++; };
  const continuation = () => source[offset] === "\\" && (source[offset + 1] === "\n" || source.slice(offset + 1, offset + 3) === "\r\n");
  const consumeContinuation = () => { advance(); if (source[offset] === "\r") advance(); advance(); };
  while (offset < source.length) {
    if (continuation()) { consumeContinuation(); continue; }
    if (/\s/.test(source[offset]!)) {
      if ((source[offset] === "\n" || source[offset] === "\r") && tokens.length && source.slice(offset).trim()) {
        fail(position(), "CURL_MULTIPLE_COMMANDS", "Only one command is accepted; use POSIX line continuation.");
      }
      advance(); continue;
    }
    const start = position();
    let value = "", quote: "'" | '"' | undefined;
    while (offset < source.length) {
      const char = source[offset]!;
      if (!quote && /\s/.test(char)) break;
      if (char === "\0") fail(position(), "CURL_SHELL_SYNTAX", "NUL is not supported.");
      if (quote === "'") { if (char === "'") quote = undefined; else value += char; advance(); continue; }
      if (char === "\\") {
        if (continuation()) { consumeContinuation(); continue; }
        advance();
        if (offset === source.length) fail(start, "CURL_INCOMPLETE_ESCAPE", "Incomplete POSIX escape.");
        const next = source[offset]!;
        if (quote === '"' && !['"', "$", "`", "\\"].includes(next)) value += "\\";
        value += next; advance(); continue;
      }
      if (char === "$" || char === "`" || (!quote && /[;|&<>()#]/.test(char))) {
        fail(position(), "CURL_SHELL_SYNTAX", "Shell operators, substitutions and expansions are not supported.");
      }
      if (char === '"') { quote = quote ? undefined : '"'; advance(); continue; }
      if (!quote && char === "'") { quote = "'"; advance(); continue; }
      value += char; advance();
    }
    if (quote) fail(start, "CURL_UNCLOSED_QUOTE", "Unclosed POSIX quote.");
    tokens.push({ ...start, value });
  }
  return tokens;
}

const OPTIONS = new Set(["--url", "-X", "-H", "-b", "-u", "--data", "--data-raw", "--data-binary", "--data-urlencode", "-F", "--form"]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** Parse one curl/curl.exe command as data. All output is safe for preview; file paths and credentials are omitted. */
export function parseCurlRequest(text: string): CurlParseResult {
  const tokens = tokenize(text);
  if (!tokens[0] || !["curl", "curl.exe"].includes(tokens[0].value)) fail(tokens[0] ?? START, "CURL_COMMAND_REQUIRED", "Expected a curl or curl.exe command.");
  const result: CurlParseResult = {
    request: { method: "GET", baseUrl: "", path: "", query: [], headers: [], cookies: [], auth: { kind: "none" }, body: [] },
    declarations: [], diagnostics: [],
  };
  const warn = (token: CurlSourcePosition, code: string, message: string) => {
    result.diagnostics.push({ ...token, severity: "warning", code, path: `source/${token.offset}`, message, lossy: false });
  };
  const masked = (value: string, name: string, token: Token): string => {
    const safe = isCredentialFieldName(name) ? "" : redactCommonCredentialText(value);
    if (safe !== value) warn(token, "CURL_AUTH_REDACTED", "A credential was omitted; bind it locally (****).");
    return safe;
  };
  const fileWarning = (token: Token) => warn(token, "CURL_FILE_NOT_BOUND", "A file declaration was omitted; select the local file again.");
  let urlToken: Token | undefined, explicitMethod = false, endOptions = false;
  const setUrl = (token: Token) => {
    if (urlToken) fail(token, "CURL_MULTIPLE_URLS", "Exactly one URL is supported.");
    urlToken = token;
  };
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!endOptions && token.value === "--") { endOptions = true; continue; }
    if (endOptions || !token.value.startsWith("-")) { setUrl(token); result.declarations.push({ offset: token.offset, line: token.line, column: token.column, option: "url" }); continue; }
    let option = token.value, attached: string | undefined;
    if (option.startsWith("--") && option.includes("=")) { const equal = option.indexOf("="); attached = option.slice(equal + 1); option = option.slice(0, equal); }
    else if (/^-[XHbuF].+/.test(option)) { attached = option.slice(2); option = option.slice(0, 2); }
    if (!OPTIONS.has(option)) fail(token, "CURL_OPTION_UNSUPPORTED", "Unsupported cURL option.");
    const valueToken = attached === undefined ? tokens[++i] : { ...token, value: attached };
    if (!valueToken) fail(token, "CURL_OPTION_VALUE_REQUIRED", "The option requires a value.");
    const value = valueToken.value;
    result.declarations.push({ offset: token.offset, line: token.line, column: token.column, option });
    if (option === "--url") { setUrl(valueToken); continue; }
    if (option === "-X") {
      if (!METHODS.has(value)) fail(valueToken, "CURL_METHOD_UNSUPPORTED", "The HTTP method cannot be represented by the contract.");
      result.request.method = value as HttpMethod; explicitMethod = true; continue;
    }
    if (option === "-u") {
      if (result.request.auth.kind !== "none") fail(token, "CURL_AUTH_CONFLICT", "Multiple authentication declarations cannot be represented together.");
      result.request.auth = { kind: "basic", username: value.split(":", 1)[0]! };
      warn(token, "CURL_AUTH_REDACTED", "Authentication was omitted; bind the new empty credential locally (****)."); continue;
    }
    if (option === "-H") {
      if (value.startsWith("@")) fail(token, "CURL_HEADER_FILE_UNSUPPORTED", "Header file expansion is not supported.");
      const colon = value.indexOf(":");
      if (colon < 1 || /[\r\n]/.test(value)) fail(token, "CURL_HEADER_INVALID", "Expected one header name and value.");
      const name = value.slice(0, colon).trim(), headerValue = value.slice(colon + 1).trim();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) fail(token, "CURL_HEADER_INVALID", "Invalid header name.");
      if (!headerValue) fail(token, "CURL_HEADER_REMOVAL_UNSUPPORTED", "Header suppression cannot be represented by the contract.");
      if (name.toLowerCase() === "authorization") {
        if (result.request.auth.kind !== "none") fail(token, "CURL_AUTH_CONFLICT", "Multiple authentication declarations cannot be represented together.");
        if (/^Bearer\s+/i.test(headerValue)) result.request.auth = { kind: "bearer" };
        else if (/^Basic\s+/i.test(headerValue)) result.request.auth = { kind: "basic", username: "" };
        else fail(token, "CURL_AUTH_UNSUPPORTED", "This authentication scheme cannot be represented.");
        warn(token, "CURL_AUTH_REDACTED", "Authentication was omitted; bind the new empty credential locally (****).");
      } else if (isCredentialFieldName(name) && !["cookie", "set-cookie", "proxy-authorization"].includes(name.toLowerCase())) {
        if (result.request.auth.kind !== "none") fail(token, "CURL_AUTH_CONFLICT", "Multiple authentication declarations cannot be represented together.");
        result.request.auth = { kind: "apikey", name, placement: "header" };
        warn(token, "CURL_AUTH_REDACTED", "Authentication was omitted; bind the new empty credential locally (****).");
      } else result.request.headers.push({ name, value: masked(headerValue, name, token) });
      continue;
    }
    if (option === "-b") {
      if (!value.includes("=")) fail(token, "CURL_COOKIE_FILE_UNSUPPORTED", "Cookie jar file expansion is not supported.");
      for (const cookie of value.split(";")) {
        const equal = cookie.indexOf("=");
        if (equal < 1) fail(token, "CURL_COOKIE_INVALID", "Expected cookie name=value pairs.");
        result.request.cookies.push({ name: cookie.slice(0, equal).trim(), value: "" });
      }
      warn(token, "CURL_AUTH_REDACTED", "Cookie values were omitted; fill them locally (****)."); continue;
    }
    if (option === "-F" || option === "--form") {
      if (result.request.body.some((item) => item.kind !== "form")) fail(token, "CURL_BODY_CONFLICT", "Form and data bodies cannot be combined.");
      const equal = value.indexOf("=");
      if (equal < 1) fail(token, "CURL_FORM_INVALID", "Expected a form name=value declaration.");
      const name = value.slice(0, equal), formValue = value.slice(equal + 1);
      if (formValue.startsWith("<")) fail(token, "CURL_FORM_FILE_CONTENT_UNSUPPORTED", "Reading a file as a text form field cannot be represented.");
      if (formValue.startsWith("@")) {
        const [file, ...attributes] = formValue.slice(1).split(";");
        if (!file || file.includes(",") || /["']/.test(file)) fail(token, "CURL_FORM_FILE_UNSUPPORTED", "Expected a single unquoted file declaration.");
        const entry: Extract<CurlBodyDeclaration, { kind: "form" }>["value"] = { kind: "file" };
        for (const attribute of attributes) {
          if (attribute.startsWith("type=") && /^[\w.+-]+\/[\w.+-]+$/.test(attribute.slice(5))) entry.contentType = attribute.slice(5);
          else if (attribute.startsWith("filename=") && !/[\\/\r\n]/.test(attribute.slice(9))) entry.filename = attribute.slice(9);
          else fail(token, "CURL_FORM_ATTRIBUTE_UNSUPPORTED", "Unsupported form file attribute.");
        }
        result.request.body.push({ kind: "form", name, value: entry }); fileWarning(token);
      } else {
        if (/[;"']/.test(formValue)) fail(token, "CURL_FORM_ATTRIBUTE_UNSUPPORTED", "Form quoting or attributes cannot be represented by this importer.");
        result.request.body.push({ kind: "form", name, value: { kind: "text", text: masked(formValue, name, token) } });
      }
      continue;
    }
    if (result.request.body.some((item) => item.kind === "form")) fail(token, "CURL_BODY_CONFLICT", "Form and data bodies cannot be combined.");
    if (option === "--data-urlencode") {
      const equal = value.indexOf("="), at = value.indexOf("@");
      const fileReference = at >= 0 && (equal < 0 || at < equal);
      const name = equal >= 0 && !fileReference ? value.slice(0, equal) : fileReference && at > 0 ? value.slice(0, at) : undefined;
      const bodyValue = fileReference ? "" : equal >= 0 ? value.slice(equal + 1) : value;
      result.request.body.push({ kind: "data-urlencode", ...(name === undefined || name === "" ? {} : { name }), value: masked(bodyValue, name ?? "", token), fileReference });
      if (fileReference) fileWarning(token);
    } else {
      const fileReference = option !== "--data-raw" && value.startsWith("@");
      result.request.body.push({ kind: option.slice(2) as "data" | "data-raw" | "data-binary", value: fileReference ? "" : masked(value, "", token), fileReference });
      if (fileReference) fileWarning(token);
    }
  }
  if (!urlToken) fail(tokens[0]!, "CURL_URL_REQUIRED", "Exactly one HTTP URL is required.");
  let url: URL;
  try { url = new URL(urlToken.value); } catch { fail(urlToken, "CURL_URL_INVALID", "Invalid absolute HTTP URL."); }
  if (!["http:", "https:"].includes(url.protocol)) fail(urlToken, "CURL_URL_UNSUPPORTED", "Only HTTP and HTTPS URLs are supported.");
  // curl expands URL globs even inside shell quotes. Check the original spelling,
  // preserving percent-encoded literals and the brackets of a validated IPv6 host.
  const globCandidate = urlToken.value.replace(/^(https?:\/\/(?:[^/?#]*@)?)\[[0-9a-f:.]+\]/i, "$1");
  if (/[{}\[\]]/.test(globCandidate)) {
    fail(urlToken, "CURL_URL_GLOB_UNSUPPORTED", "URL glob syntax is not supported; provide one literal URL.");
  }
  if (url.username || url.password) {
    if (result.request.auth.kind !== "none") fail(urlToken, "CURL_AUTH_CONFLICT", "URL authentication conflicts with another authentication declaration.");
    result.request.auth = { kind: "basic", username: "" };
    warn(urlToken, "CURL_AUTH_REDACTED", "URL authentication was omitted; bind the new empty credential locally (****).");
  }
  result.request.baseUrl = url.origin;
  result.request.path = redactCommonCredentialText(url.pathname);
  result.request.query = [...url.searchParams].map(([name, value]) => ({ name, value: masked(value, name, urlToken!) }));
  if (!explicitMethod && result.request.body.length) result.request.method = "POST";
  return result;
}
