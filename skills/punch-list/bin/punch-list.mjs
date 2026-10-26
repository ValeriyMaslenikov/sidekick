#!/usr/bin/env node
import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);

// src/punch-list/cli.ts
import { spawn as spawn2 } from "node:child_process";
import { readFileSync as readFileSync4, rmSync as rmSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { fileURLToPath } from "node:url";

// src/punch-list/config.ts
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// src/punch-list/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
function paths() {
  const home = process.env.SIDEKICK_HOME || join(homedir(), ".sidekick");
  const boards = join(home, "boards");
  return {
    home,
    config: join(home, "config.json"),
    token: join(home, "token"),
    state: join(home, "state.json"),
    boards,
    serverLog: join(home, "server.log"),
    boardDir: (id) => join(boards, id)
  };
}

// src/punch-list/config.ts
var DEFAULTS = { port: 7317, retentionDays: 90 };
function ensureHome() {
  mkdirSync(paths().home, { recursive: true });
}
function loadConfig() {
  ensureHome();
  const file = paths().config;
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(DEFAULTS, null, 2) + "\n");
    return { ...DEFAULTS };
  }
  const raw2 = JSON.parse(readFileSync(file, "utf8"));
  return {
    port: Number.isInteger(raw2.port) ? raw2.port : DEFAULTS.port,
    retentionDays: typeof raw2.retentionDays === "number" && raw2.retentionDays > 0 ? raw2.retentionDays : DEFAULTS.retentionDays
  };
}
function getToken() {
  ensureHome();
  const file = paths().token;
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const token = randomBytes(16).toString("hex");
  writeFileSync(file, token + "\n", { mode: 384 });
  return token;
}
function readState() {
  try {
    return JSON.parse(readFileSync(paths().state, "utf8"));
  } catch {
    return {};
  }
}
function takeRetentionNotice() {
  const config = loadConfig();
  const hash = createHash("sha256").update(readFileSync(paths().config, "utf8")).digest("hex");
  const state = readState();
  if (state.noticeConfigHash === hash) return null;
  writeFileSync(paths().state, JSON.stringify({ ...state, noticeConfigHash: hash }, null, 2) + "\n");
  return `Boards are kept for ${config.retentionDays} days; change that in ${paths().config}`;
}

// src/punch-list/client.ts
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
var PortTakenError = class extends Error {
  constructor(port) {
    super(`Port ${port} is in use by another program; set "port" in ${paths().config}`);
  }
};
var HttpError = class extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
};
var baseUrl = () => `http://127.0.0.1:${loadConfig().port}`;
async function health() {
  try {
    const res = await fetch(`${baseUrl()}/api/health`, { signal: AbortSignal.timeout(5e3) });
    const body = await res.json().catch(() => null);
    return body?.app === "punch-list" ? "ours" : "foreign";
  } catch (err) {
    const code = err.cause?.code;
    return code === "ECONNREFUSED" || code === "ECONNRESET" ? "down" : "foreign";
  }
}
async function ensureServer(bin) {
  const state = await health();
  if (state === "ours") return;
  if (state === "foreign") throw new PortTakenError(loadConfig().port);
  const log = openSync(paths().serverLog, "a");
  spawn(process.execPath, [bin, "serve"], { detached: true, stdio: ["ignore", log, log], env: process.env }).unref();
  const deadline = Date.now() + 5e3;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const now = await health();
    if (now === "ours") return;
    if (now === "foreign") throw new PortTakenError(loadConfig().port);
  }
  throw new Error(`punch-list server did not start; see ${paths().serverLog}`);
}
async function call(method, path, body) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: { "x-sidekick-token": getToken(), ...body === void 0 ? {} : { "content-type": "application/json" } },
    body: body === void 0 ? void 0 : JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(json.error || `${method} ${path} failed with ${res.status}`, res.status);
  return json;
}

// src/punch-list/server.ts
import { EventEmitter } from "node:events";

// node_modules/.pnpm/hono@4.10.8/node_modules/hono/dist/compose.js
var compose = (middleware, onError, onNotFound) => {
  return (context, next) => {
    let index = -1;
    return dispatch(0);
    async function dispatch(i) {
      if (i <= index) {
        throw new Error("next() called multiple times");
      }
      index = i;
      let res;
      let isError = false;
      let handler;
      if (middleware[i]) {
        handler = middleware[i][0][0];
        context.req.routeIndex = i;
      } else {
        handler = i === middleware.length && next || void 0;
      }
      if (handler) {
        try {
          res = await handler(context, () => dispatch(i + 1));
        } catch (err) {
          if (err instanceof Error && onError) {
            context.error = err;
            res = await onError(err, context);
            isError = true;
          } else {
            throw err;
          }
        }
      } else {
        if (context.finalized === false && onNotFound) {
          res = await onNotFound(context);
        }
      }
      if (res && (context.finalized === false || isError)) {
        context.res = res;
      }
      return context;
    }
  };
};

// node_modules/.pnpm/hono@4.10.8/node_modules/hono/dist/request/constants.js
var GET_MATCH_RESULT = Symbol();

// node_modules/.pnpm/hono@4.10.8/node_modules/hono/dist/utils/body.js
var parseBody = async (request, options = /* @__PURE__ */ Object.create(null)) => {
  const { all = false, dot = false } = options;
  const headers = request instanceof HonoRequest ? request.raw.headers : request.headers;
  const contentType = headers.get("Content-Type");
  if (contentType?.startsWith("multipart/form-data") || contentType?.startsWith("application/x-www-form-urlencoded")) {
    return parseFormData(request, { all, dot });
  }
  return {};
};
async function parseFormData(request, options) {
  const formData = await request.formData();
  if (formData) {
    return convertFormDataToBodyData(formData, options);
  }
  return {};
}
function convertFormDataToBodyData(formData, options) {
  const form = /* @__PURE__ */ Object.create(null);
  formData.forEach((value, key) => {
    const shouldParseAllValues = options.all || key.endsWith("[]");
    if (!shouldParseAllValues) {
      form[key] = value;
    } else {
      handleParsingAllValues(form, key, value);
    }
  });
  if (options.dot) {
    Object.entries(form).forEach(([key, value]) => {
      const shouldParseDotValues = key.includes(".");
      if (shouldParseDotValues) {
        handleParsingNestedValues(form, key, value);
        delete form[key];
      }
    });
  }
  return form;
}
var handleParsingAllValues = (form, key, value) => {
  if (form[key] !== void 0) {
    if (Array.isArray(form[key])) {
      ;
      form[key].push(value);
    } else {
      form[key] = [form[key], value];
    }
  } else {
    if (!key.endsWith("[]")) {
      form[key] = value;
    } else {
      form[key] = [value];
    }
  }
};
var handleParsingNestedValues = (form, key, value) => {
  let nestedForm = form;
  const keys = key.split(".");
  keys.forEach((key2, index) => {
    if (index === keys.length - 1) {
      nestedForm[key2] = value;
    } else {
      if (!nestedForm[key2] || typeof nestedForm[key2] !== "object" || Array.isArray(nestedForm[key2]) || nestedForm[key2] instanceof File) {
        nestedForm[key2] = /* @__PURE__ */ Object.create(null);
      }
      nestedForm = nestedForm[key2];
    }
  });
};

// node_modules/.pnpm/hono@4.10.8/node_modules/hono/dist/utils/url.js
var splitPath = (path) => {
  const paths2 = path.split("/");
  if (paths2[0] === "") {
    paths2.shift();
  }
  return paths2;
};
var splitRoutingPath = (routePath) => {
  const { groups, path } = extractGroupsFromPath(routePath);
  const paths2 = splitPath(path);
  return replaceGroupMarks(paths2, groups);
};
var extractGroupsFromPath = (path) => {
  const groups = [];
  path = path.replace(/\{[^}]+\}/g, (match2, index) => {
    const mark = `@${index}`;
    groups.push([mark, match2]);
    return mark;
  });
  return { groups, path };
};
var replaceGroupMarks = (paths2, groups) => {
  for (let i = groups.length - 1; i >= 0; i--) {
    const [mark] = groups[i];
    for (let j = paths2.length - 1; j >= 0; j--) {
      if (paths2[j].includes(mark)) {
        paths2[j] = paths2[j].replace(mark, groups[i][1]);
        break;
      }
    }
  }
  return paths2;
};
var patternCache = {};
var getPattern = (label, next) => {
  if (label === "*") {
    return "*";
  }
  const match2 = label.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
  if (match2) {
    const cacheKey2 = `${label}#${next}`;
    if (!patternCache[cacheKey2]) {
      if (match2[2]) {
        patternCache[cacheKey2] = next && next[0] !== ":" && next[0] !== "*" ? [cacheKey2, match2[1], new RegExp(`^${match2[2]}(?=/${next})`)] : [label, match2[1], new RegExp(`^${match2[2]}$`)];
      } else {
        patternCache[cacheKey2] = [label, match2[1], true];
      }
    }
    return patternCache[cacheKey2];
  }
  return null;
};
var tryDecode = (str, decoder) => {
  try {
    return decoder(str);
  } catch {
    return str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match2) => {
      try {
        return decoder(match2);
      } catch {
        return match2;
      }
    });
  }
};
var tryDecodeURI = (str) => tryDecode(str, decodeURI);
var getPath = (request) => {
  const url = request.url;
  const start = url.indexOf("/", url.indexOf(":") + 4);
  let i = start;
  for (; i < url.length; i++) {
    const charCode = url.charCodeAt(i);
    if (charCode === 37) {
      const queryIndex = url.indexOf("?", i);
      const path = url.slice(start, queryIndex === -1 ? void 0 : queryIndex);
      return tryDecodeURI(path.includes("%25") ? path.replace(/%25/g, "%2525") : path);
    } else if (charCode === 63) {
      break;
    }
  }
  return url.slice(start, i);
};
var getPathNoStrict = (request) => {
  const result = getPath(request);
  return result.length > 1 && result.at(-1) === "/" ? result.slice(0, -1) : result;
};
var mergePath = (base, sub, ...rest) => {
  if (rest.length) {
    sub = mergePath(sub, ...rest);
  }
  return `${base?.[0] === "/" ? "" : "/"}${base}${sub === "/" ? "" : `${base?.at(-1) === "/" ? "" : "/"}${sub?.[0] === "/" ? sub.slice(1) : sub}`}`;
};
var checkOptionalParameter = (path) => {
  if (path.charCodeAt(path.length - 1) !== 63 || !path.includes(":")) {
    return null;
  }
  const segments = path.split("/");
  const results = [];
  let basePath = "";
  segments.forEach((segment) => {
    if (segment !== "" && !/\:/.test(segment)) {
      basePath += "/" + segment;
    } else if (/\:/.test(segment)) {
      if (/\?/.test(segment)) {
        if (results.length === 0 && basePath === "") {
          results.push("/");
        } else {
          results.push(basePath);
        }
        const optionalSegment = segment.replace("?", "");
        basePath += "/" + optionalSegment;
        results.push(basePath);
      } else {
        basePath += "/" + segment;
      }
    }
  });
  return results.filter((v, i, a) => a.indexOf(v) === i);
};
var _decodeURI = (value) => {
  if (!/[%+]/.test(value)) {
    return value;
  }
  if (value.indexOf("+") !== -1) {
    value = value.replace(/\+/g, " ");
  }
  return value.indexOf("%") !== -1 ? tryDecode(value, decodeURIComponent_) : value;
};
var _getQueryParam = (url, key, multiple) => {
  let encoded;
  if (!multiple && key && !/[%+]/.test(key)) {
    let keyIndex2 = url.indexOf("?", 8);
    if (keyIndex2 === -1) {
      return void 0;
    }
    if (!url.startsWith(key, keyIndex2 + 1)) {
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    while (keyIndex2 !== -1) {
      const trailingKeyCode = url.charCodeAt(keyIndex2 + key.length + 1);
      if (trailingKeyCode === 61) {
        const valueIndex = keyIndex2 + key.length + 2;
        const endIndex = url.indexOf("&", valueIndex);
        return _decodeURI(url.slice(valueIndex, endIndex === -1 ? void 0 : endIndex));
      } else if (trailingKeyCode == 38 || isNaN(trailingKeyCode)) {
        return "";
      }
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    encoded = /[%+]/.test(url);
    if (!encoded) {
      return void 0;
    }
  }
  const results = {};
  encoded ??= /[%+]/.test(url);
  let keyIndex = url.indexOf("?", 8);
  while (keyIndex !== -1) {
    const nextKeyIndex = url.indexOf("&", keyIndex + 1);
    let valueIndex = url.indexOf("=", keyIndex);
    if (valueIndex > nextKeyIndex && nextKeyIndex !== -1) {
      valueIndex = -1;
    }
    let name = url.slice(
      keyIndex + 1,
      valueIndex === -1 ? nextKeyIndex === -1 ? void 0 : nextKeyIndex : valueIndex
    );
    if (encoded) {
      name = _decodeURI(name);
    }
    keyIndex = nextKeyIndex;
    if (name === "") {
      continue;
    }
    let value;
    if (valueIndex === -1) {
      value = "";
    } else {
      value = url.slice(valueIndex + 1, nextKeyIndex === -1 ? void 0 : nextKeyIndex);
      if (encoded) {
        value = _decodeURI(value);
      }
    }
    if (multiple) {
      if (!(results[name] && Array.isArray(results[name]))) {
        results[name] = [];
      }
      ;
      results[name].push(value);
    } else {
      results[name] ??= value;
    }
  }
  return key ? results[key] : results;
};
var getQueryParam = _getQueryParam;
var getQueryParams = (url, key) => {
  return _getQueryParam(url, key, true);
};
var decodeURIComponent_ = decodeURIComponent;

// node_modules/.pnpm/hono@4.10.8/node_modules/hono/dist/request.js
var tryDecodeURIComponent = (str) => tryDecode(str, decodeURIComponent_);
var HonoRequest = class {
  raw;
  #validatedData;
  #matchResult;
  routeIndex = 0;
  path;
  bodyCache = {};
  constructor(request, path = "/", matchResult = [[]]) {
    this.raw = request;
    this.path = path;
    this.#matchResult = matchResult;
    this.#validatedData = {};
  }
  param(key) {
    return key ? this.#getDecodedParam(key) : this.#getAllDecodedParams();
  }
  #getDecodedParam(key) {
    const paramKey = this.#matchResult[0][this.routeIndex][1][key];
    const param = this.#getParamValue(paramKey);
    return param && /\%/.test(param) ? tryDecodeURIComponent(param) : param;
  }
  #getAllDecodedParams() {
    const decoded = {};
    const keys = Object.keys(this.#matchResult[0][this.routeIndex][1]);
    for (const key of keys) {
      const value = this.#getParamValue(this.#matchResult[0][this.routeIndex][1][key]);
      if (value !== void 0) {
        decoded[key] = /\%/.test(value) ? tryDecodeURIComponent(value) : value;
      }
    }
    return decoded;
  }
  #getParamValue(paramKey) {
    return this.#matchResult[1] ? this.#matchResult[1][paramKey] : paramKey;
  }
  query(key) {
    return getQueryParam(this.url, key);
  }
  queries(key) {
    return getQueryParams(this.url, key);
  }
  header(name) {
    if (name) {
      return this.raw.headers.get(name) ?? void 0;
    }
    const headerData = {};
    this.raw.headers.forEach((value, key) => {
      headerData[key] = value;
    });
    return headerData;
  }
  async parseBody(options) {
    return this.bodyCache.parsedBody ??= await parseBody(this, options);
  }
  #cachedBody = (key) => {
    const { bodyCache, raw: raw2 } = this;
    const cachedBody = bodyCache[key];
    if (cachedBody) {
      return cachedBody;
    }
    const anyCachedKey = Object.keys(bodyCache)[0];
    if (anyCachedKey) {
      return bodyCache[anyCachedKey].then((body) => {
        if (anyCachedKey === "json") {
          body = JSON.stringify(body);
        }
        return new Response(body)[key]();
      });
    }
    return bodyCache[key] = raw2[key]();
  };
  json() {
    return this.#cachedBody("text").then((text) => JSON.parse(text));
  }
  text() {
    return this.#cachedBody("text");
  }
  arrayBuffer() {
    return this.#cachedBody("arrayBuffer");
  }
  blob() {
    return this.#cachedBody("blob");
  }
  formData() {
    return this.#cachedBody("formData");
  }
  addValidatedData(target, data) {
    this.#validatedData[target] = data;
  }
  valid(target) {
    return this.#validatedData[target];
  }
  get url() {
    return this.raw.url;
  }
  get method() {
    return this.raw.method;
  }
  get [GET_MATCH_RESULT]() {
    return this.#matchResult;
  }
  get matchedRoutes() {
    return this.#matchResult[0].map(([[, route]]) => route);
  }
  get routePath() {
    return this.#matchResult[0].map(([[, route]]) => route)[this.routeIndex].path;
  }
};

// node_modules/.pnpm/hono@4.10.8/node_modules/hono/dist/utils/html.js
var HtmlEscapedCallbackPhase = {
  Stringify: 1,
  BeforeStream: 2,
  Stream: 3
};
var raw = (value, callbacks) => {
  const escapedString = new String(value);
  escapedString.isEscaped = true;
  escapedString.callbacks = callbacks;
  return escapedString;
};
var resolveCallback = async (str, phase, preserveCallbacks, context, buffer) => {
  if (typeof str === "object" && !(str instanceof String)) {
    if (!(str instanceof Promise)) {
      str = str.toString();
    }
    if (str instanceof Promise) {
      str = await str;
    }
  }
  const callbacks = str.callbacks;
  if (!callbacks?.length) {
    return Promise.resolve(str);
  }
  if (buffer) {
    buffer[0] += str;
  } else {
    buffer = [str];
  }
  const resStr = Promise.all(callbacks.map((c) => c({ phase, buffer, context }))).then(
    (res) => Promise.all(
      res.filter(Boolean).map((str2) => resolveCallback(str2, phase, false, context, buffer))
    ).then(() => buffer[0])
  );
  if (preserveCallbacks) {
    return raw(await resStr, callbacks);
  } else {
    return resStr;
  }
};

// node_modules/.pnpm/hono@4.10.8/node_modules/hono/dist/context.js
var TEXT_PLAIN = "text/plain; charset=UTF-8";
var setDefaultContentType = (contentType, headers) => {
  return {
    "Content-Type": contentType,
    ...headers
  };
};
var Context = class {
  #rawRequest;
  #req;
  env = {};
  #var;
  finalized = false;
  error;
  #status;
  #executionCtx;
  #res;
  #layout;
  #renderer;
  #notFoundHandler;
  #preparedHeaders;
  #matchResult;
  #path;
  constructor(req, options) {
    this.#rawRequest = req;
    if (options) {
      this.#executionCtx = options.executionCtx;
      this.env = options.env;
      this.#notFoundHandler = options.notFoundHandler;
      this.#path = options.path;
      this.#matchResult = options.matchResult;
    }
  }
  get req() {
    this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult);
    return this.#req;
  }
  get event() {
    if (this.#executionCtx && "respondWith" in this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error("This context has no FetchEvent");
    }
  }
  get executionCtx() {
    if (this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error("This context has no ExecutionContext");
    }
  }
  get res() {
    return this.#res ||= new Response(null, {
      headers: this.#preparedHeaders ??= new Headers()
    });
  }
  set res(_res) {
    if (this.#res && _res) {
      _res = new Response(_res.body, _res);
      for (const [k, v] of this.#res.headers.entries()) {
        if (k === "content-type") {
          continue;
        }
        if (k === "set-cookie") {
          const cookies = this.#res.headers.getSetCookie();
          _res.headers.delete("set-cookie");
          for (const cookie of cookies) {
            _res.headers.append("set-cookie", cookie);
          }
        } else {
          _res.headers.set(k, v);
        }
      }
    }
    this.#res = _res;
    this.finalized = true;
  }
  render = (...args) => {
    this.#renderer ??= (content) => this.html(content);
    return this.#renderer(...args);
  };
  setLayout = (layout) => this.#layout = layout;
  getLayout = () => this.#layout;
  setRenderer = (renderer) => {
    this.#renderer = renderer;
  };
  header = (name, value, options) => {
    if (this.finalized) {
      this.#res = new Response(this.#res.body, this.#res);
    }
    const headers = this.#res ? this.#res.headers : this.#preparedHeaders ??= new Headers();
    if (value === void 0) {
      headers.delete(name);
    } else if (options?.append) {
      headers.append(name, value);
    } else {
      headers.set(name, value);
    }
  };
  status = (status) => {
    this.#status = status;
  };
  set = (key, value) => {
    this.#var ??= /* @__PURE__ */ new Map();
    this.#var.set(key, value);
  };
  get = (key) => {
    return this.#var ? this.#var.get(key) : void 0;
  };
  get var() {
    if (!this.#var) {
      return {};
    }
    return Object.fromEntries(this.#var);
  }
  #newResponse(data, arg, headers) {
    const responseHeaders = this.#res ? new Headers(this.#res.headers) : this.#preparedHeaders ?? new Headers();
    if (typeof arg === "object" && "headers" in arg) {
      const argHeaders = arg.headers instanceof Headers ? arg.headers : new Headers(arg.headers);
      for (const [key, value] of argHeaders) {
        if (key.toLowerCase() === "set-cookie") {
          responseHeaders.append(key, value);
        } else {
          responseHeaders.set(key, value);
        }
      }
    }
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === "string") {
          responseHeaders.set(k, v);
        } else {
          responseHeaders.delete(k);
          for (const v2 of v) {
            responseHeaders.append(k, v2);
          }
        }
      }
    }
    const status = typeof arg === "number" ? arg : arg?.status ?? this.#status;
    return new Response(data, { status, headers: responseHeaders });
  }
  newResponse = (...args) => this.#newResponse(...args);
  body = (data, arg, headers) => this.#newResponse(data, arg, headers);
  text = (text, arg, headers) => {
    return !this.#preparedHeaders && !this.#status && !arg && !headers && !this.finalized ? new Response(text) : this.#newResponse(
      text,
      arg,
      setDefaultContentType(TEXT_PLAIN, headers)
    );
  };
  json = (object, arg, headers) => {
    return this.#newResponse(
      JSON.stringify(object),
      arg,
      setDefaultContentType("application/json", headers)
    );
  };
  html = (html, arg, headers) => {
    const res = (html2) => this.#newResponse(html2, arg, setDefaultContentType("text/html; charset=UTF-8", headers));
    return typeof html === "object" ? resolveCallback(html, HtmlEscapedCallbackPhase.Stringify, false, {}).then(res) : res(html);
  };
  redirect = (location, status) => {
    const locationString = String(location);
    this.header(
      "Location",
      !/[^\x00-\xFF]/.test(locationString) ? locationString : encodeURI(locationString)
    );
    return this.newResponse(null, status ?? 302);
  };
  notFound = () => {
    this.#notFoundHandler ??= () => new Response();
    return this.#notFoundHandler(this);
  };
};

// node_modules/.pnpm/hono@4.10.8/node_modules/hono/dist/router.js
var METHOD_NAME_ALL = "ALL";
var METHOD_NAME_ALL_LOWERCASE = "all";
var METHODS = ["get", "post", "put", "delete", "options", "patch"];
var MESSAGE_MATCHER_IS_ALREADY_BUILT = "Can not add a route since the matcher is already built.";
var UnsupportedPathError = class extends Error {
};

// node_modules/.pnpm/hono@4.10.8/node_modules/hono/dist/utils/constants.js
var COMPOSED_HANDLER = "__COMPOSED_HANDLER";

// node_modules/.pnpm/hono@4.10.8/node_modules/hono/dist/hono-base.js
var notFoundHandler = (c) => {
  return c.text("404 Not Found", 404);
};
var errorHandler = (err, c) => {
  if ("getResponse" in err) {
    const res = err.getResponse();
    return c.newResponse(res.body, res);
  }
  console.error(err);
  return c.text("Internal Server Error", 500);
};
var Hono = class {
  get;
  post;
  put;
  delete;
  options;
  patch;
  all;
  on;
  use;
  router;
  getPath;
  _basePath = "/";
  #path = "/";
  routes = [];
  constructor(options = {}) {
    const allMethods = [...METHODS, METHOD_NAME_ALL_LOWERCASE];
    allMethods.forEach((method) => {
      this[method] = (args1, ...args) => {
        if (typeof args1 === "string") {
          this.#path = args1;
        } else {
          this.#addRoute(method, this.#path, args1);
        }
        args.forEach((handler) => {
          this.#addRoute(method, this.#path, handler);
        });
        return this;
      };
    });
    this.on = (method, path, ...handlers) => {
      for (const p of [path].flat()) {
        this.#path = p;
        for (const m of [method].flat()) {
          handlers.map((handler) => {
            this.#addRoute(m.toUpperCase(), this.#path, handler);
          });
        }
      }
      return this;
    };
    this.use = (arg1, ...handlers) => {
      if (typeof arg1 === "string") {
        this.#path = arg1;
      } else {
        this.#path = "*";
        handlers.unshift(arg1);
      }
      handlers.forEach((handler) => {
        this.#addRoute(METHOD_NAME_ALL, this.#path, handler);
      });
      return this;
    };
    const { strict, ...optionsWithoutStrict } = options;
    Object.assign(this, optionsWithoutStrict);
    this.getPath = strict ?? true ? options.getPath ?? getPath : getPathNoStrict;
  }
  #clone() {
    const clone = new Hono({
      router: this.router,
      getPath: this.getPath
    });
    clone.errorHandler = this.errorHandler;
    clone.#notFoundHandler = this.#notFoundHandler;
    clone.routes = this.routes;
    return clone;
  }
  #notFoundHandler = notFoundHandler;
  errorHandler = errorHandler;
  route(path, app) {
    const subApp = this.basePath(path);
    app.routes.map((r) => {
      let handler;
      if (app.errorHandler === errorHandler) {
        handler = r.handler;
      } else {
        handler = async (c, next) => (await compose([], app.errorHandler)(c, () => r.handler(c, next))).res;
        handler[COMPOSED_HANDLER] = r.handler;
      }
      subApp.#addRoute(r.method, r.path, handler);
    });
    return this;
  }
  basePath(path) {
    const subApp = this.#clone();
    subApp._basePath = mergePath(this._basePath, path);
    return subApp;
  }
  onError = (handler) => {
    this.errorHandler = handler;
    return this;
  };
  notFound = (handler) => {
    this.#notFoundHandler = handler;
    return this;
  };
  mount(path, applicationHandler, options) {
    let replaceRequest;
    let optionHandler;
    if (options) {
      if (typeof options === "function") {
        optionHandler = options;
      } else {
        optionHandler = options.optionHandler;
        if (options.replaceRequest === false) {
          replaceRequest = (request) => request;
        } else {
          replaceRequest = options.replaceRequest;
        }
      }
    }
    const getOptions = optionHandler ? (c) => {
      const options2 = optionHandler(c);
      return Array.isArray(options2) ? options2 : [options2];
    } : (c) => {
      let executionContext = void 0;
      try {
        executionContext = c.executionCtx;
      } catch {
      }
      return [c.env, executionContext];
    };
    replaceRequest ||= (() => {
      const mergedPath = mergePath(this._basePath, path);
      const pathPrefixLength = mergedPath === "/" ? 0 : mergedPath.length;
      return (request) => {
        const url = new URL(request.url);
        url.pathname = url.pathname.slice(pathPrefixLength) || "/";
        return new Request(url, request);
      };
    })();
    const handler = async (c, next) => {
      const res = await applicationHandler(replaceRequest(c.req.raw), ...getOptions(c));
      if (res) {
        return res;
      }
      await next();
    };
    this.#addRoute(METHOD_NAME_ALL, mergePath(path, "*"), handler);
    return this;
  }
  #addRoute(method, path, handler) {
    method = method.toUpperCase();
    path = mergePath(this._basePath, path);
    const r = { basePath: this._basePath, path, method, handler };
    this.router.add(method, path, [handler, r]);
    this.routes.push(r);
  }
  #handleError(err, c) {
    if (err instanceof Error) {
      return this.errorHandler(err, c);
    }
    throw err;
  }
  #dispatch(request, executionCtx, env, method) {
    if (method === "HEAD") {
      return (async () => new Response(null, await this.#dispatch(request, executionCtx, env, "GET")))();
    }
    const path = this.getPath(request, { env });
    const matchResult = this.router.match(method, path);
    const c = new Context(request, {
      path,
      matchResult,
      env,
      executionCtx,
      notFoundHandler: this.#notFoundHandler
    });
    if (matchResult[0].length === 1) {
      let res;
      try {
        res = matchResult[0][0][0][0](c, async () => {
          c.res = await this.#notFoundHandler(c);
        });
      } catch (err) {
        return this.#handleError(err, c);
      }
      return res instanceof Promise ? res.then(
        (resolved) => resolved || (c.finalized ? c.res : this.#notFoundHandler(c))
      ).catch((err) => this.#handleError(err, c)) : res ?? this.#notFoundHandler(c);
    }
    const composed = compose(matchResult[0], this.errorHandler, this.#notFoundHandler);
    return (async () => {
      try {
        const context = await composed(c);
        if (!context.finalized) {
          throw new Error(
            "Context is not finalized. Did you forget to return a Response object or `await next()`?"
          );
        }
        return context.res;
      } catch (err) {
        return this.#handleError(err, c);
      }
    })();
  }
  fetch = (request, ...rest) => {
    return this.#dispatch(request, rest[1], rest[0], request.method);
  };
  request = (input, requestInit, Env, executionCtx) => {
    if (input instanceof Request) {
      return this.fetch(requestInit ? new Request(input, requestInit) : input, Env, executionCtx);
    }
    input = input.toString();
    return this.fetch(
      new Request(
        /^https?:\/\//.test(input) ? input : `http://localhost${mergePath("/", input)}`,
        requestInit
      ),
      Env,
      executionCtx
    );
  };
  fire = () => {
    addEventListener("fetch", (event) => {
      event.respondWith(this.#dispatch(event.request, event, void 0, event.request.method));
    });
  };
};

// node_modules/.pnpm/hono@4.10.8/node_modules/hono/dist/router/reg-exp-router/matcher.js
var emptyParam = [];
function match(method, path) {
  const matchers = this.buildAllMatchers();
  const match2 = (method2, path2) => {
    const matcher = matchers[method2] || matchers[METHOD_NAME_ALL];
    const staticMatch = matcher[2][path2];
    if (staticMatch) {
      return staticMatch;
    }
    const match3 = path2.match(matcher[0]);
    if (!match3) {
      return [[], emptyParam];
    }
    const index = match3.indexOf("", 1);
    return [matcher[1][index], match3];
  };
  this.match = match2;
  return match2(method, path);
}

// node_modules/.pnpm/hono@4.10.8/node_modules/hono/dist/router/reg-exp-router/node.js
var LABEL_REG_EXP_STR = "[^/]+";
var ONLY_WILDCARD_REG_EXP_STR = ".*";
var TAIL_WILDCARD_REG_EXP_STR = "(?:|/.*)";
var PATH_ERROR = Symbol();
var regExpMetaChars = new Set(".\\+*[^]$()");
function compareKey(a, b) {
  if (a.length === 1) {
    return b.length === 1 ? a < b ? -1 : 1 : -1;
  }
  if (b.length === 1) {
    return 1;
  }
  if (a === ONLY_WILDCARD_REG_EXP_STR || a === TAIL_WILDCARD_REG_EXP_STR) {
    return 1;
  } else if (b === ONLY_WILDCARD_REG_EXP_STR || b === TAIL_WILDCARD_REG_EXP_STR) {
    return -1;
  }
  if (a === LABEL_REG_EXP_STR) {
    return 1;
  } else if (b === LABEL_REG_EXP_STR) {
    return -1;
  }
  return a.length === b.length ? a < b ? -1 : 1 : b.length - a.length;
}
var Node = class {
  #index;
  #varIndex;
  #children = /* @__PURE__ */ Object.create(null);
  insert(tokens, index, paramMap, context, pathErrorCheckOnly) {
    if (tokens.length === 0) {
      if (this.#index !== void 0) {
        throw PATH_ERROR;
      }
      if (pathErrorCheckOnly) {
        return;
      }
      this.#index = index;
      return;
    }
    const [token, ...restTokens] = tokens;
    const pattern = token === "*" ? restTokens.length === 0 ? ["", "", ONLY_WILDCARD_REG_EXP_STR] : ["", "", LABEL_REG_EXP_STR] : token === "/*" ? ["", "", TAIL_WILDCARD_REG_EXP_STR] : token.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
    let node;
    if (pattern) {
      const name = pattern[1];
      let regexpStr = pattern[2] || LABEL_REG_EXP_STR;
      if (name && pattern[2]) {
        if (regexpStr === ".*") {
          throw PATH_ERROR;
        }
        regexpStr = regexpStr.replace(/^\((?!\?:)(?=[^)]+\)$)/, "(?:");
        if (/\((?!\?:)/.test(regexpStr)) {
          throw PATH_ERROR;
        }
      }
      node = this.#children[regexpStr];
      if (!node) {
        if (Object.keys(this.#children).some(
          (k) => k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR
        )) {
          throw PATH_ERROR;
        }
        if (pathErrorCheckOnly) {
          return;
        }
        node = this.#children[regexpStr] = new Node();
        if (name !== "") {
          node.#varIndex = context.varIndex++;
        }
      }
      if (!pathErrorCheckOnly && name !== "") {
        paramMap.push([name, node.#varIndex]);
      }
    } else {
      node = this.#children[token];
      if (!node) {
        if (Object.keys(this.#children).some(
          (k) => k.length > 1 && k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR
        )) {
          throw PATH_ERROR;
        }
        if (pathErrorCheckOnly) {
          return;
        }
        node = this.#children[token] = new Node();
      }
    }
    node.insert(restTokens, index, paramMap, context, pathErrorCheckOnly);
  }
  buildRegExpStr() {
    const childKeys = Object.keys(this.#children).sort(compareKey);
    const strList = childKeys.map((k) => {
      const c = this.#children[k];
      return (typeof c.#varIndex === "number" ? `(${k})@${c.#varIndex}` : regExpMetaChars.has(k) ? `\\${k}` : k) + c.buildRegExpStr();
    });
    if (typeof this.#index === "number") {
      strList.unshift(`#${this.#index}`);
    }
    if (strList.length === 0) {
      return "";
    }
    if (strList.length === 1) {
      return strList[0];
    }
    return "(?:" + strList.join("|") + ")";
  }
};

// node_modules/.pnpm/hono@4.10.8/node_modules/hono/dist/router/reg-exp-router/trie.js
var Trie = class {
  #context = { varIndex: 0 };
  #root = new Node();
  insert(path, index, pathErrorCheckOnly) {
    const paramAssoc = [];
    const groups = [];
    for (let i = 0; ; ) {
      let replaced = false;
      path = path.replace(/\{[^}]+\}/g, (m) => {
        const mark = `@\\${i}`;
        groups[i] = [mark, m];
        i++;
        replaced = true;
        return mark;
      });
      if (!replaced) {
        break;
      }
    }
    const tokens = path.match(/(?::[^\/]+)|(?:\/\*$)|./g) || [];
    for (let i = groups.length - 1; i >= 0; i--) {
      const [mark] = groups[i];
      for (let j = tokens.length - 1; j >= 0; j--) {
        if (tokens[j].indexOf(mark) !== -1) {
          tokens[j] = tokens[j].replace(mark, groups[i][1]);
          break;
        }
      }
    }
    this.#root.insert(tokens, index, paramAssoc, this.#context, pathErrorCheckOnly);
    return paramAssoc;
  }
  buildRegExp() {
    let regexp = this.#root.buildRegExpStr();
    if (regexp === "") {
      return [/^$/, [], []];
    }
    let captureIndex = 0;
    const indexReplacementMap = [];
    const paramReplacementMap = [];
    regexp = regexp.replace(/#(\d+)|@(\d+)|\.\*\$/g, (_, handlerIndex, paramIndex) => {
      if (handlerIndex !== void 0) {
        indexReplacementMap[++captureIndex] = Number(handlerIndex);
        return "$()";
      }
      if (paramIndex !== void 0) {
        paramReplacementMap[Number(paramIndex)] = ++captureIndex;
        return "";
      }
      return "";
    });
    return [new RegExp(`^${regexp}`), indexReplacementMap, paramReplacementMap];
  }
};

// node_modules/.pnpm/hono@4.10.8/node_modules/hono/dist/router/reg-exp-router/router.js
var nullMatcher = [/^$/, [], /* @__PURE__ */ Object.create(null)];
var wildcardRegExpCache = /* @__PURE__ */ Object.create(null);
function buildWildcardRegExp(path) {
  return wildcardRegExpCache[path] ??= new RegExp(
    path === "*" ? "" : `^${path.replace(
      /\/\*$|([.\\+*[^\]$()])/g,
      (_, metaChar) => metaChar ? `\\${metaChar}` : "(?:|/.*)"
    )}$`
  );
}
function clearWildcardRegExpCache() {
  wildcardRegExpCache = /* @__PURE__ */ Object.create(null);
}
function buildMatcherFromPreprocessedRoutes(routes) {
  const trie = new Trie();
  const handlerData = [];
  if (routes.length === 0) {
    return nullMatcher;
  }
  const routesWithStaticPathFlag = routes.map(
    (route) => [!/\*|\/:/.test(route[0]), ...route]
  ).sort(
    ([isStaticA, pathA], [isStaticB, pathB]) => isStaticA ? 1 : isStaticB ? -1 : pathA.length - pathB.length
  );
  const staticMap = /* @__PURE__ */ Object.create(null);
  for (let i = 0, j = -1, len = routesWithStaticPathFlag.length; i < len; i++) {
    const [pathErrorCheckOnly, path, handlers] = routesWithStaticPathFlag[i];
    if (pathErrorCheckOnly) {
      staticMap[path] = [handlers.map(([h]) => [h, /* @__PURE__ */ Object.create(null)]), emptyParam];
    } else {
      j++;
    }
    let paramAssoc;
    try {
      paramAssoc = trie.insert(path, j, pathErrorCheckOnly);
    } catch (e) {
      throw e === PATH_ERROR ? new UnsupportedPathError(path) : e;
    }
    if (pathErrorCheckOnly) {
      continue;
    }
    handlerData[j] = handlers.map(([h, paramCount]) => {
      const paramIndexMap = /* @__PURE__ */ Object.create(null);
      paramCount -= 1;
      for (; paramCount >= 0; paramCount--) {
        const [key, value] = paramAssoc[paramCount];
        paramIndexMap[key] = value;
      }
      return [h, paramIndexMap];
    });
  }
  const [regexp, indexReplacementMap, paramReplacementMap] = trie.buildRegExp();
  for (let i = 0, len = handlerData.length; i < len; i++) {
    for (let j = 0, len2 = handlerData[i].length; j < len2; j++) {
      const map = handlerData[i][j]?.[1];
      if (!map) {
        continue;
      }
      const keys = Object.keys(map);
      for (let k = 0, len3 = keys.length; k < len3; k++) {
        map[keys[k]] = paramReplacementMap[map[keys[k]]];
      }
    }
  }
  const handlerMap = [];
  for (const i in indexReplacementMap) {
    handlerMap[i] = handlerData[indexReplacementMap[i]];
  }
  return [regexp, handlerMap, staticMap];
}
function findMiddleware(middleware, path) {
  if (!middleware) {
    return void 0;
  }
  for (const k of Object.keys(middleware).sort((a, b) => b.length - a.length)) {
    if (buildWildcardRegExp(k).test(path)) {
      return [...middleware[k]];
    }
  }
  return void 0;
}
var RegExpRouter = class {
  name = "RegExpRouter";
  #middleware;
  #routes;
  constructor() {
    this.#middleware = { [METHOD_NAME_ALL]: /* @__PURE__ */ Object.create(null) };
    this.#routes = { [METHOD_NAME_ALL]: /* @__PURE__ */ Object.create(null) };
  }
  add(method, path, handler) {
    const middleware = this.#middleware;
    const routes = this.#routes;
    if (!middleware || !routes) {
      throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    }
    if (!middleware[method]) {
      ;
      [middleware, routes].forEach((handlerMap) => {
        handlerMap[method] = /* @__PURE__ */ Object.create(null);
        Object.keys(handlerMap[METHOD_NAME_ALL]).forEach((p) => {
          handlerMap[method][p] = [...handlerMap[METHOD_NAME_ALL][p]];
        });
      });
    }
    if (path === "/*") {
      path = "*";
    }
    const paramCount = (path.match(/\/:/g) || []).length;
    if (/\*$/.test(path)) {
      const re = buildWildcardRegExp(path);
      if (method === METHOD_NAME_ALL) {
        Object.keys(middleware).forEach((m) => {
          middleware[m][path] ||= findMiddleware(middleware[m], path) || findMiddleware(middleware[METHOD_NAME_ALL], path) || [];
        });
      } else {
        middleware[method][path] ||= findMiddleware(middleware[method], path) || findMiddleware(middleware[METHOD_NAME_ALL], path) || [];
      }
      Object.keys(middleware).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          Object.keys(middleware[m]).forEach((p) => {
            re.test(p) && middleware[m][p].push([handler, paramCount]);
          });
        }
      });
      Object.keys(routes).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          Object.keys(routes[m]).forEach(
            (p) => re.test(p) && routes[m][p].push([handler, paramCount])
          );
        }
      });
      return;
    }
    const paths2 = checkOptionalParameter(path) || [path];
    for (let i = 0, len = paths2.length; i < len; i++) {
      const path2 = paths2[i];
      Object.keys(routes).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          routes[m][path2] ||= [
            ...findMiddleware(middleware[m], path2) || findMiddleware(middleware[METHOD_NAME_ALL], path2) || []
          ];
          routes[m][path2].push([handler, paramCount - len + i + 1]);
        }
      });
    }
  }
  match = match;
  buildAllMatchers() {
    const matchers = /* @__PURE__ */ Object.create(null);
    Object.keys(this.#routes).concat(Object.keys(this.#middleware)).forEach((method) => {
      matchers[method] ||= this.#buildMatcher(method);
    });
    this.#middleware = this.#routes = void 0;
    clearWildcardRegExpCache();
    return matchers;
  }
  #buildMatcher(method) {
    const routes = [];
    let hasOwnRoute = method === METHOD_NAME_ALL;
    [this.#middleware, this.#routes].forEach((r) => {
      const ownRoute = r[method] ? Object.keys(r[method]).map((path) => [path, r[method][path]]) : [];
      if (ownRoute.length !== 0) {
        hasOwnRoute ||= true;
        routes.push(...ownRoute);
      } else if (method !== METHOD_NAME_ALL) {
        routes.push(
          ...Object.keys(r[METHOD_NAME_ALL]).map((path) => [path, r[METHOD_NAME_ALL][path]])
        );
      }
    });
    if (!hasOwnRoute) {
      return null;
    } else {
      return buildMatcherFromPreprocessedRoutes(routes);
    }
  }
};

// node_modules/.pnpm/hono@4.10.8/node_modules/hono/dist/router/smart-router/router.js
var SmartRouter = class {
  name = "SmartRouter";
  #routers = [];
  #routes = [];
  constructor(init) {
    this.#routers = init.routers;
  }
  add(method, path, handler) {
    if (!this.#routes) {
      throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    }
    this.#routes.push([method, path, handler]);
  }
  match(method, path) {
    if (!this.#routes) {
      throw new Error("Fatal error");
    }
    const routers = this.#routers;
    const routes = this.#routes;
    const len = routers.length;
    let i = 0;
    let res;
    for (; i < len; i++) {
      const router = routers[i];
      try {
        for (let i2 = 0, len2 = routes.length; i2 < len2; i2++) {
          router.add(...routes[i2]);
        }
        res = router.match(method, path);
      } catch (e) {
        if (e instanceof UnsupportedPathError) {
          continue;
        }
        throw e;
      }
      this.match = router.match.bind(router);
      this.#routers = [router];
      this.#routes = void 0;
      break;
    }
    if (i === len) {
      throw new Error("Fatal error");
    }
    this.name = `SmartRouter + ${this.activeRouter.name}`;
    return res;
  }
  get activeRouter() {
    if (this.#routes || this.#routers.length !== 1) {
      throw new Error("No active router has been determined yet.");
    }
    return this.#routers[0];
  }
};

// node_modules/.pnpm/hono@4.10.8/node_modules/hono/dist/router/trie-router/node.js
var emptyParams = /* @__PURE__ */ Object.create(null);
var Node2 = class {
  #methods;
  #children;
  #patterns;
  #order = 0;
  #params = emptyParams;
  constructor(method, handler, children) {
    this.#children = children || /* @__PURE__ */ Object.create(null);
    this.#methods = [];
    if (method && handler) {
      const m = /* @__PURE__ */ Object.create(null);
      m[method] = { handler, possibleKeys: [], score: 0 };
      this.#methods = [m];
    }
    this.#patterns = [];
  }
  insert(method, path, handler) {
    this.#order = ++this.#order;
    let curNode = this;
    const parts = splitRoutingPath(path);
    const possibleKeys = [];
    for (let i = 0, len = parts.length; i < len; i++) {
      const p = parts[i];
      const nextP = parts[i + 1];
      const pattern = getPattern(p, nextP);
      const key = Array.isArray(pattern) ? pattern[0] : p;
      if (key in curNode.#children) {
        curNode = curNode.#children[key];
        if (pattern) {
          possibleKeys.push(pattern[1]);
        }
        continue;
      }
      curNode.#children[key] = new Node2();
      if (pattern) {
        curNode.#patterns.push(pattern);
        possibleKeys.push(pattern[1]);
      }
      curNode = curNode.#children[key];
    }
    curNode.#methods.push({
      [method]: {
        handler,
        possibleKeys: possibleKeys.filter((v, i, a) => a.indexOf(v) === i),
        score: this.#order
      }
    });
    return curNode;
  }
  #getHandlerSets(node, method, nodeParams, params) {
    const handlerSets = [];
    for (let i = 0, len = node.#methods.length; i < len; i++) {
      const m = node.#methods[i];
      const handlerSet = m[method] || m[METHOD_NAME_ALL];
      const processedSet = {};
      if (handlerSet !== void 0) {
        handlerSet.params = /* @__PURE__ */ Object.create(null);
        handlerSets.push(handlerSet);
        if (nodeParams !== emptyParams || params && params !== emptyParams) {
          for (let i2 = 0, len2 = handlerSet.possibleKeys.length; i2 < len2; i2++) {
            const key = handlerSet.possibleKeys[i2];
            const processed = processedSet[handlerSet.score];
            handlerSet.params[key] = params?.[key] && !processed ? params[key] : nodeParams[key] ?? params?.[key];
            processedSet[handlerSet.score] = true;
          }
        }
      }
    }
    return handlerSets;
  }
  search(method, path) {
    const handlerSets = [];
    this.#params = emptyParams;
    const curNode = this;
    let curNodes = [curNode];
    const parts = splitPath(path);
    const curNodesQueue = [];
    for (let i = 0, len = parts.length; i < len; i++) {
      const part = parts[i];
      const isLast = i === len - 1;
      const tempNodes = [];
      for (let j = 0, len2 = curNodes.length; j < len2; j++) {
        const node = curNodes[j];
        const nextNode = node.#children[part];
        if (nextNode) {
          nextNode.#params = node.#params;
          if (isLast) {
            if (nextNode.#children["*"]) {
              handlerSets.push(
                ...this.#getHandlerSets(nextNode.#children["*"], method, node.#params)
              );
            }
            handlerSets.push(...this.#getHandlerSets(nextNode, method, node.#params));
          } else {
            tempNodes.push(nextNode);
          }
        }
        for (let k = 0, len3 = node.#patterns.length; k < len3; k++) {
          const pattern = node.#patterns[k];
          const params = node.#params === emptyParams ? {} : { ...node.#params };
          if (pattern === "*") {
            const astNode = node.#children["*"];
            if (astNode) {
              handlerSets.push(...this.#getHandlerSets(astNode, method, node.#params));
              astNode.#params = params;
              tempNodes.push(astNode);
            }
            continue;
          }
          const [key, name, matcher] = pattern;
          if (!part && !(matcher instanceof RegExp)) {
            continue;
          }
          const child = node.#children[key];
          const restPathString = parts.slice(i).join("/");
          if (matcher instanceof RegExp) {
            const m = matcher.exec(restPathString);
            if (m) {
              params[name] = m[0];
              handlerSets.push(...this.#getHandlerSets(child, method, node.#params, params));
              if (Object.keys(child.#children).length) {
                child.#params = params;
                const componentCount = m[0].match(/\//)?.length ?? 0;
                const targetCurNodes = curNodesQueue[componentCount] ||= [];
                targetCurNodes.push(child);
              }
              continue;
            }
          }
          if (matcher === true || matcher.test(part)) {
            params[name] = part;
            if (isLast) {
              handlerSets.push(...this.#getHandlerSets(child, method, params, node.#params));
              if (child.#children["*"]) {
                handlerSets.push(
                  ...this.#getHandlerSets(child.#children["*"], method, params, node.#params)
                );
              }
            } else {
              child.#params = params;
              tempNodes.push(child);
            }
          }
        }
      }
      curNodes = tempNodes.concat(curNodesQueue.shift() ?? []);
    }
    if (handlerSets.length > 1) {
      handlerSets.sort((a, b) => {
        return a.score - b.score;
      });
    }
    return [handlerSets.map(({ handler, params }) => [handler, params])];
  }
};

// node_modules/.pnpm/hono@4.10.8/node_modules/hono/dist/router/trie-router/router.js
var TrieRouter = class {
  name = "TrieRouter";
  #node;
  constructor() {
    this.#node = new Node2();
  }
  add(method, path, handler) {
    const results = checkOptionalParameter(path);
    if (results) {
      for (let i = 0, len = results.length; i < len; i++) {
        this.#node.insert(method, results[i], handler);
      }
      return;
    }
    this.#node.insert(method, path, handler);
  }
  match(method, path) {
    return this.#node.search(method, path);
  }
};

// node_modules/.pnpm/hono@4.10.8/node_modules/hono/dist/hono.js
var Hono2 = class extends Hono {
  constructor(options = {}) {
    super(options);
    this.router = options.router ?? new SmartRouter({
      routers: [new RegExpRouter(), new TrieRouter()]
    });
  }
};

// node_modules/.pnpm/hono@4.10.8/node_modules/hono/dist/utils/stream.js
var StreamingApi = class {
  writer;
  encoder;
  writable;
  abortSubscribers = [];
  responseReadable;
  aborted = false;
  closed = false;
  constructor(writable, _readable) {
    this.writable = writable;
    this.writer = writable.getWriter();
    this.encoder = new TextEncoder();
    const reader = _readable.getReader();
    this.abortSubscribers.push(async () => {
      await reader.cancel();
    });
    this.responseReadable = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        done ? controller.close() : controller.enqueue(value);
      },
      cancel: () => {
        this.abort();
      }
    });
  }
  async write(input) {
    try {
      if (typeof input === "string") {
        input = this.encoder.encode(input);
      }
      await this.writer.write(input);
    } catch {
    }
    return this;
  }
  async writeln(input) {
    await this.write(input + "\n");
    return this;
  }
  sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
  }
  async close() {
    try {
      await this.writer.close();
    } catch {
    }
    this.closed = true;
  }
  async pipe(body) {
    this.writer.releaseLock();
    await body.pipeTo(this.writable, { preventClose: true });
    this.writer = this.writable.getWriter();
  }
  onAbort(listener) {
    this.abortSubscribers.push(listener);
  }
  abort() {
    if (!this.aborted) {
      this.aborted = true;
      this.abortSubscribers.forEach((subscriber) => subscriber());
    }
  }
};

// node_modules/.pnpm/hono@4.10.8/node_modules/hono/dist/helper/streaming/utils.js
var isOldBunVersion = () => {
  const version = typeof Bun !== "undefined" ? Bun.version : void 0;
  if (version === void 0) {
    return false;
  }
  const result = version.startsWith("1.1") || version.startsWith("1.0") || version.startsWith("0.");
  isOldBunVersion = () => result;
  return result;
};

// node_modules/.pnpm/hono@4.10.8/node_modules/hono/dist/helper/streaming/sse.js
var SSEStreamingApi = class extends StreamingApi {
  constructor(writable, readable) {
    super(writable, readable);
  }
  async writeSSE(message) {
    const data = await resolveCallback(message.data, HtmlEscapedCallbackPhase.Stringify, false, {});
    const dataLines = data.split("\n").map((line) => {
      return `data: ${line}`;
    }).join("\n");
    const sseData = [
      message.event && `event: ${message.event}`,
      dataLines,
      message.id && `id: ${message.id}`,
      message.retry && `retry: ${message.retry}`
    ].filter(Boolean).join("\n") + "\n\n";
    await this.write(sseData);
  }
};
var run = async (stream2, cb, onError) => {
  try {
    await cb(stream2);
  } catch (e) {
    if (e instanceof Error && onError) {
      await onError(e, stream2);
      await stream2.writeSSE({
        event: "error",
        data: e.message
      });
    } else {
      console.error(e);
    }
  } finally {
    stream2.close();
  }
};
var contextStash = /* @__PURE__ */ new WeakMap();
var streamSSE = (c, cb, onError) => {
  const { readable, writable } = new TransformStream();
  const stream2 = new SSEStreamingApi(writable, readable);
  if (isOldBunVersion()) {
    c.req.raw.signal.addEventListener("abort", () => {
      if (!stream2.closed) {
        stream2.abort();
      }
    });
  }
  contextStash.set(stream2.responseReadable, c);
  c.header("Transfer-Encoding", "chunked");
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  run(stream2, cb, onError);
  return c.newResponse(stream2.responseReadable);
};

// node_modules/.pnpm/@hono+node-server@1.19.17_hono@4.10.8/node_modules/@hono/node-server/dist/index.mjs
import { createServer as createServerHTTP } from "http";
import { Http2ServerRequest as Http2ServerRequest2, constants as h2constants } from "http2";
import { Http2ServerRequest } from "http2";
import { Readable } from "stream";
import crypto from "crypto";
var RequestError = class extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RequestError";
  }
};
var toRequestError = (e) => {
  if (e instanceof RequestError) {
    return e;
  }
  return new RequestError(e.message, { cause: e });
};
var GlobalRequest = global.Request;
var Request2 = class extends GlobalRequest {
  constructor(input, options) {
    if (typeof input === "object" && getRequestCache in input) {
      input = input[getRequestCache]();
    }
    if (typeof options?.body?.getReader !== "undefined") {
      ;
      options.duplex ??= "half";
    }
    super(input, options);
  }
};
var newHeadersFromIncoming = (incoming) => {
  const headerRecord = [];
  const rawHeaders = incoming.rawHeaders;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const { [i]: key, [i + 1]: value } = rawHeaders;
    if (key.charCodeAt(0) !== /*:*/
    58) {
      headerRecord.push([key, value]);
    }
  }
  return new Headers(headerRecord);
};
var wrapBodyStream = Symbol("wrapBodyStream");
var newRequestFromIncoming = (method, url, headers, incoming, abortController) => {
  const init = {
    method,
    headers,
    signal: abortController.signal
  };
  if (method === "TRACE") {
    init.method = "GET";
    const req = new Request2(url, init);
    Object.defineProperty(req, "method", {
      get() {
        return "TRACE";
      }
    });
    return req;
  }
  if (!(method === "GET" || method === "HEAD")) {
    if ("rawBody" in incoming && incoming.rawBody instanceof Buffer) {
      init.body = new ReadableStream({
        start(controller) {
          controller.enqueue(incoming.rawBody);
          controller.close();
        }
      });
    } else if (incoming[wrapBodyStream]) {
      let reader;
      init.body = new ReadableStream({
        async pull(controller) {
          try {
            reader ||= Readable.toWeb(incoming).getReader();
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
            } else {
              controller.enqueue(value);
            }
          } catch (error) {
            controller.error(error);
          }
        }
      });
    } else {
      init.body = Readable.toWeb(incoming);
    }
  }
  return new Request2(url, init);
};
var getRequestCache = Symbol("getRequestCache");
var requestCache = Symbol("requestCache");
var incomingKey = Symbol("incomingKey");
var urlKey = Symbol("urlKey");
var headersKey = Symbol("headersKey");
var abortControllerKey = Symbol("abortControllerKey");
var getAbortController = Symbol("getAbortController");
var requestPrototype = {
  get method() {
    return this[incomingKey].method || "GET";
  },
  get url() {
    return this[urlKey];
  },
  get headers() {
    return this[headersKey] ||= newHeadersFromIncoming(this[incomingKey]);
  },
  [getAbortController]() {
    this[getRequestCache]();
    return this[abortControllerKey];
  },
  [getRequestCache]() {
    this[abortControllerKey] ||= new AbortController();
    return this[requestCache] ||= newRequestFromIncoming(
      this.method,
      this[urlKey],
      this.headers,
      this[incomingKey],
      this[abortControllerKey]
    );
  }
};
[
  "body",
  "bodyUsed",
  "cache",
  "credentials",
  "destination",
  "integrity",
  "mode",
  "redirect",
  "referrer",
  "referrerPolicy",
  "signal",
  "keepalive"
].forEach((k) => {
  Object.defineProperty(requestPrototype, k, {
    get() {
      return this[getRequestCache]()[k];
    }
  });
});
["arrayBuffer", "blob", "clone", "formData", "json", "text"].forEach((k) => {
  Object.defineProperty(requestPrototype, k, {
    value: function() {
      return this[getRequestCache]()[k]();
    }
  });
});
Object.defineProperty(requestPrototype, Symbol.for("nodejs.util.inspect.custom"), {
  value: function(depth, options, inspectFn) {
    const props = {
      method: this.method,
      url: this.url,
      headers: this.headers,
      nativeRequest: this[requestCache]
    };
    return `Request (lightweight) ${inspectFn(props, { ...options, depth: depth == null ? null : depth - 1 })}`;
  }
});
Object.setPrototypeOf(requestPrototype, Request2.prototype);
var newRequest = (incoming, defaultHostname) => {
  const req = Object.create(requestPrototype);
  req[incomingKey] = incoming;
  const incomingUrl = incoming.url || "";
  if (incomingUrl[0] !== "/" && // short-circuit for performance. most requests are relative URL.
  (incomingUrl.startsWith("http://") || incomingUrl.startsWith("https://"))) {
    if (incoming instanceof Http2ServerRequest) {
      throw new RequestError("Absolute URL for :path is not allowed in HTTP/2");
    }
    try {
      const url2 = new URL(incomingUrl);
      req[urlKey] = url2.href;
    } catch (e) {
      throw new RequestError("Invalid absolute URL", { cause: e });
    }
    return req;
  }
  const host = (incoming instanceof Http2ServerRequest ? incoming.authority : incoming.headers.host) || defaultHostname;
  if (!host) {
    throw new RequestError("Missing host header");
  }
  let scheme;
  if (incoming instanceof Http2ServerRequest) {
    scheme = incoming.scheme;
    if (!(scheme === "http" || scheme === "https")) {
      throw new RequestError("Unsupported scheme");
    }
  } else {
    scheme = incoming.socket && incoming.socket.encrypted ? "https" : "http";
  }
  const url = new URL(`${scheme}://${host}${incomingUrl}`);
  if (url.hostname.length !== host.length && url.hostname !== host.replace(/:\d+$/, "")) {
    throw new RequestError("Invalid host header");
  }
  req[urlKey] = url.href;
  return req;
};
var responseCache = Symbol("responseCache");
var getResponseCache = Symbol("getResponseCache");
var cacheKey = Symbol("cache");
var GlobalResponse = global.Response;
var Response2 = class _Response {
  #body;
  #init;
  [getResponseCache]() {
    delete this[cacheKey];
    return this[responseCache] ||= new GlobalResponse(this.#body, this.#init);
  }
  constructor(body, init) {
    let headers;
    this.#body = body;
    if (init instanceof _Response) {
      const cachedGlobalResponse = init[responseCache];
      if (cachedGlobalResponse) {
        this.#init = cachedGlobalResponse;
        this[getResponseCache]();
        return;
      } else {
        this.#init = init.#init;
        headers = new Headers(init.#init.headers);
      }
    } else {
      this.#init = init;
    }
    if (typeof body === "string" || typeof body?.getReader !== "undefined" || body instanceof Blob || body instanceof Uint8Array) {
      ;
      this[cacheKey] = [init?.status || 200, body, headers || init?.headers];
    }
  }
  get headers() {
    const cache = this[cacheKey];
    if (cache) {
      if (!(cache[2] instanceof Headers)) {
        cache[2] = new Headers(
          cache[2] || { "content-type": "text/plain; charset=UTF-8" }
        );
      }
      return cache[2];
    }
    return this[getResponseCache]().headers;
  }
  get status() {
    return this[cacheKey]?.[0] ?? this[getResponseCache]().status;
  }
  get ok() {
    const status = this.status;
    return status >= 200 && status < 300;
  }
};
["body", "bodyUsed", "redirected", "statusText", "trailers", "type", "url"].forEach((k) => {
  Object.defineProperty(Response2.prototype, k, {
    get() {
      return this[getResponseCache]()[k];
    }
  });
});
["arrayBuffer", "blob", "clone", "formData", "json", "text"].forEach((k) => {
  Object.defineProperty(Response2.prototype, k, {
    value: function() {
      return this[getResponseCache]()[k]();
    }
  });
});
Object.defineProperty(Response2.prototype, Symbol.for("nodejs.util.inspect.custom"), {
  value: function(depth, options, inspectFn) {
    const props = {
      status: this.status,
      headers: this.headers,
      ok: this.ok,
      nativeResponse: this[responseCache]
    };
    return `Response (lightweight) ${inspectFn(props, { ...options, depth: depth == null ? null : depth - 1 })}`;
  }
});
Object.setPrototypeOf(Response2, GlobalResponse);
Object.setPrototypeOf(Response2.prototype, GlobalResponse.prototype);
async function readWithoutBlocking(readPromise) {
  return Promise.race([readPromise, Promise.resolve().then(() => Promise.resolve(void 0))]);
}
function writeFromReadableStreamDefaultReader(reader, writable, currentReadPromise) {
  const cancel = (error) => {
    reader.cancel(error).catch(() => {
    });
  };
  writable.on("close", cancel);
  writable.on("error", cancel);
  (currentReadPromise ?? reader.read()).then(flow, handleStreamError);
  return reader.closed.finally(() => {
    writable.off("close", cancel);
    writable.off("error", cancel);
  });
  function handleStreamError(error) {
    if (error) {
      writable.destroy(error);
    }
  }
  function onDrain() {
    reader.read().then(flow, handleStreamError);
  }
  function flow({ done, value }) {
    try {
      if (done) {
        writable.end();
      } else if (!writable.write(value)) {
        writable.once("drain", onDrain);
      } else {
        return reader.read().then(flow, handleStreamError);
      }
    } catch (e) {
      handleStreamError(e);
    }
  }
}
function writeFromReadableStream(stream2, writable) {
  if (stream2.locked) {
    throw new TypeError("ReadableStream is locked.");
  } else if (writable.destroyed) {
    return;
  }
  return writeFromReadableStreamDefaultReader(stream2.getReader(), writable);
}
var buildOutgoingHttpHeaders = (headers) => {
  const res = {};
  if (!(headers instanceof Headers)) {
    headers = new Headers(headers ?? void 0);
  }
  const cookies = [];
  for (const [k, v] of headers) {
    if (k === "set-cookie") {
      cookies.push(v);
    } else {
      res[k] = v;
    }
  }
  if (cookies.length > 0) {
    res["set-cookie"] = cookies;
  }
  res["content-type"] ??= "text/plain; charset=UTF-8";
  return res;
};
var X_ALREADY_SENT = "x-hono-already-sent";
if (typeof global.crypto === "undefined") {
  global.crypto = crypto;
}
var outgoingEnded = Symbol("outgoingEnded");
var incomingDraining = Symbol("incomingDraining");
var DRAIN_TIMEOUT_MS = 500;
var MAX_DRAIN_BYTES = 64 * 1024 * 1024;
var drainIncoming = (incoming) => {
  const incomingWithDrainState = incoming;
  if (incoming.destroyed || incomingWithDrainState[incomingDraining]) {
    return;
  }
  incomingWithDrainState[incomingDraining] = true;
  if (incoming instanceof Http2ServerRequest2) {
    try {
      ;
      incoming.stream?.close?.(h2constants.NGHTTP2_NO_ERROR);
    } catch {
    }
    return;
  }
  let bytesRead = 0;
  const cleanup = () => {
    clearTimeout(timer);
    incoming.off("data", onData);
    incoming.off("end", cleanup);
    incoming.off("error", cleanup);
  };
  const forceClose = () => {
    cleanup();
    const socket = incoming.socket;
    if (socket && !socket.destroyed) {
      socket.destroySoon();
    }
  };
  const timer = setTimeout(forceClose, DRAIN_TIMEOUT_MS);
  timer.unref?.();
  const onData = (chunk) => {
    bytesRead += chunk.length;
    if (bytesRead > MAX_DRAIN_BYTES) {
      forceClose();
    }
  };
  incoming.on("data", onData);
  incoming.on("end", cleanup);
  incoming.on("error", cleanup);
  incoming.resume();
};
var handleRequestError = () => new Response(null, {
  status: 400
});
var handleFetchError = (e) => new Response(null, {
  status: e instanceof Error && (e.name === "TimeoutError" || e.constructor.name === "TimeoutError") ? 504 : 500
});
var handleResponseError = (e, outgoing) => {
  const err = e instanceof Error ? e : new Error("unknown error", { cause: e });
  if (err.code === "ERR_STREAM_PREMATURE_CLOSE") {
    console.info("The user aborted a request.");
  } else {
    console.error(e);
    if (!outgoing.headersSent) {
      outgoing.writeHead(500, { "Content-Type": "text/plain" });
    }
    outgoing.end(`Error: ${err.message}`);
    outgoing.destroy(err);
  }
};
var flushHeaders = (outgoing) => {
  if ("flushHeaders" in outgoing && outgoing.writable) {
    outgoing.flushHeaders();
  }
};
var responseViaCache = async (res, outgoing) => {
  let [status, body, header] = res[cacheKey];
  let hasContentLength = false;
  if (!header) {
    header = { "content-type": "text/plain; charset=UTF-8" };
  } else if (header instanceof Headers) {
    hasContentLength = header.has("content-length");
    header = buildOutgoingHttpHeaders(header);
  } else if (Array.isArray(header)) {
    const headerObj = new Headers(header);
    hasContentLength = headerObj.has("content-length");
    header = buildOutgoingHttpHeaders(headerObj);
  } else {
    for (const key in header) {
      if (key.length === 14 && key.toLowerCase() === "content-length") {
        hasContentLength = true;
        break;
      }
    }
  }
  if (!hasContentLength) {
    if (typeof body === "string") {
      header["Content-Length"] = Buffer.byteLength(body);
    } else if (body instanceof Uint8Array) {
      header["Content-Length"] = body.byteLength;
    } else if (body instanceof Blob) {
      header["Content-Length"] = body.size;
    }
  }
  outgoing.writeHead(status, header);
  if (typeof body === "string" || body instanceof Uint8Array) {
    outgoing.end(body);
  } else if (body instanceof Blob) {
    outgoing.end(new Uint8Array(await body.arrayBuffer()));
  } else {
    flushHeaders(outgoing);
    await writeFromReadableStream(body, outgoing)?.catch(
      (e) => handleResponseError(e, outgoing)
    );
  }
  ;
  outgoing[outgoingEnded]?.();
};
var isPromise = (res) => typeof res.then === "function";
var responseViaResponseObject = async (res, outgoing, options = {}) => {
  if (isPromise(res)) {
    if (options.errorHandler) {
      try {
        res = await res;
      } catch (err) {
        const errRes = await options.errorHandler(err);
        if (!errRes) {
          return;
        }
        res = errRes;
      }
    } else {
      res = await res.catch(handleFetchError);
    }
  }
  if (cacheKey in res) {
    return responseViaCache(res, outgoing);
  }
  const resHeaderRecord = buildOutgoingHttpHeaders(res.headers);
  if (res.body) {
    const reader = res.body.getReader();
    const values = [];
    let done = false;
    let currentReadPromise = void 0;
    if (resHeaderRecord["transfer-encoding"] !== "chunked") {
      let maxReadCount = 2;
      for (let i = 0; i < maxReadCount; i++) {
        currentReadPromise ||= reader.read();
        const chunk = await readWithoutBlocking(currentReadPromise).catch((e) => {
          console.error(e);
          done = true;
        });
        if (!chunk) {
          if (i === 1) {
            await new Promise((resolve) => setTimeout(resolve));
            maxReadCount = 3;
            continue;
          }
          break;
        }
        currentReadPromise = void 0;
        if (chunk.value) {
          values.push(chunk.value);
        }
        if (chunk.done) {
          done = true;
          break;
        }
      }
      if (done && !("content-length" in resHeaderRecord)) {
        resHeaderRecord["content-length"] = values.reduce((acc, value) => acc + value.length, 0);
      }
    }
    outgoing.writeHead(res.status, resHeaderRecord);
    values.forEach((value) => {
      ;
      outgoing.write(value);
    });
    if (done) {
      outgoing.end();
    } else {
      if (values.length === 0) {
        flushHeaders(outgoing);
      }
      await writeFromReadableStreamDefaultReader(reader, outgoing, currentReadPromise);
    }
  } else if (resHeaderRecord[X_ALREADY_SENT]) {
  } else {
    outgoing.writeHead(res.status, resHeaderRecord);
    outgoing.end();
  }
  ;
  outgoing[outgoingEnded]?.();
};
var getRequestListener = (fetchCallback, options = {}) => {
  const autoCleanupIncoming = options.autoCleanupIncoming ?? true;
  if (options.overrideGlobalObjects !== false && global.Request !== Request2) {
    Object.defineProperty(global, "Request", {
      value: Request2
    });
    Object.defineProperty(global, "Response", {
      value: Response2
    });
  }
  return async (incoming, outgoing) => {
    let res, req;
    try {
      req = newRequest(incoming, options.hostname);
      let incomingEnded = !autoCleanupIncoming || incoming.method === "GET" || incoming.method === "HEAD";
      if (!incomingEnded) {
        ;
        incoming[wrapBodyStream] = true;
        incoming.on("end", () => {
          incomingEnded = true;
        });
        if (incoming instanceof Http2ServerRequest2) {
          ;
          outgoing[outgoingEnded] = () => {
            if (!incomingEnded) {
              setTimeout(() => {
                if (!incomingEnded) {
                  setTimeout(() => {
                    drainIncoming(incoming);
                  });
                }
              });
            }
          };
        }
        outgoing.on("finish", () => {
          if (!incomingEnded) {
            drainIncoming(incoming);
          }
        });
      }
      outgoing.on("close", () => {
        const abortController = req[abortControllerKey];
        if (abortController) {
          if (incoming.errored) {
            req[abortControllerKey].abort(incoming.errored.toString());
          } else if (!outgoing.writableFinished) {
            req[abortControllerKey].abort("Client connection prematurely closed.");
          }
        }
        if (!incomingEnded) {
          setTimeout(() => {
            if (!incomingEnded) {
              setTimeout(() => {
                drainIncoming(incoming);
              });
            }
          });
        }
      });
      res = fetchCallback(req, { incoming, outgoing });
      if (cacheKey in res) {
        return responseViaCache(res, outgoing);
      }
    } catch (e) {
      if (!res) {
        if (options.errorHandler) {
          res = await options.errorHandler(req ? e : toRequestError(e));
          if (!res) {
            return;
          }
        } else if (!req) {
          res = handleRequestError();
        } else {
          res = handleFetchError(e);
        }
      } else {
        return handleResponseError(e, outgoing);
      }
    }
    try {
      return await responseViaResponseObject(res, outgoing, options);
    } catch (e) {
      return handleResponseError(e, outgoing);
    }
  };
};
var createAdaptorServer = (options) => {
  const fetchCallback = options.fetch;
  const requestListener = getRequestListener(fetchCallback, {
    hostname: options.hostname,
    overrideGlobalObjects: options.overrideGlobalObjects,
    autoCleanupIncoming: options.autoCleanupIncoming
  });
  const createServer = options.createServer || createServerHTTP;
  const server = createServer(options.serverOptions || {}, requestListener);
  return server;
};
var serve = (options, listeningListener) => {
  const server = createAdaptorServer(options);
  server.listen(options?.port ?? 3e3, options.hostname, () => {
    const serverInfo = server.address();
    listeningListener && listeningListener(serverInfo);
  });
  return server;
};

// src/punch-list/store.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync as mkdirSync2, readdirSync, readFileSync as readFileSync2, renameSync, rmSync, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";

// src/punch-list/model.ts
var QUESTION_TYPES = ["yes-no", "single", "multi", "text", "number", "scale", "rank", "custom"];
var LAYOUT_TYPES = ["list", "tabs", "wizard", "columns", "custom"];
var BOARD_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
var QUESTION_ID = /^[A-Za-z0-9_-]{1,64}$/;
var NEEDS_OPTIONS = ["single", "multi", "rank"];
function hasValue(a) {
  if (!a) return false;
  const v = a.value;
  if (v === void 0 || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  return true;
}
function questionStatus(board, qid) {
  const s = board.qstate[qid];
  if (s?.withdrawn) return "withdrawn";
  if (hasValue(board.drafts[qid])) return "answered";
  if (s?.skipped) return "skipped";
  return "open";
}
function fail(path, msg) {
  throw new Error(`${path}: ${msg}`);
}
function isRecord(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function validateQuestion(q, path) {
  if (!isRecord(q)) fail(path, "must be an object");
  if (typeof q.id !== "string" || !QUESTION_ID.test(q.id)) fail(`${path}.id`, 'must be 1-64 letters, digits, "_" or "-"');
  if (typeof q.title !== "string" || !q.title.trim()) fail(`${path}.title`, "must be a non-empty string");
  if (!QUESTION_TYPES.includes(q.type)) fail(`${path}.type`, `must be one of ${QUESTION_TYPES.join(", ")}`);
  if (q.body !== void 0 && typeof q.body !== "string") fail(`${path}.body`, "must be an HTML string");
  if (NEEDS_OPTIONS.includes(q.type)) {
    if (!Array.isArray(q.options) || q.options.length === 0) fail(`${path}.options`, `is required for type "${q.type}"`);
  }
  if (q.options !== void 0) {
    if (!Array.isArray(q.options)) fail(`${path}.options`, "must be an array");
    const seen = /* @__PURE__ */ new Set();
    q.options.forEach((o, i) => {
      if (!isRecord(o) || typeof o.value !== "string" || typeof o.label !== "string") {
        fail(`${path}.options[${i}]`, 'must have string "value" and "label"');
      }
      if (seen.has(o.value)) fail(`${path}.options[${i}].value`, `duplicate "${o.value}"`);
      seen.add(o.value);
    });
  }
  if (q.showIf !== void 0 && !isRecord(q.showIf)) fail(`${path}.showIf`, "must be an object of question id to value(s)");
  return q;
}
function validateLayout(l, path = "layout") {
  if (!isRecord(l)) fail(path, "must be an object");
  if (!LAYOUT_TYPES.includes(l.type)) fail(`${path}.type`, `must be one of ${LAYOUT_TYPES.join(", ")}`);
  if (l.groups !== void 0) {
    if (!Array.isArray(l.groups)) fail(`${path}.groups`, "must be an array");
    l.groups.forEach((g, i) => {
      if (!isRecord(g) || typeof g.id !== "string" || typeof g.title !== "string") fail(`${path}.groups[${i}]`, 'must have string "id" and "title"');
    });
  }
  if (l.type === "custom" && typeof l.html !== "string") fail(`${path}.html`, "is required for a custom layout");
  return l;
}
function validateQuestions(list, path = "questions") {
  if (!Array.isArray(list)) fail(path, "must be an array");
  if (path === "questions" && list.length === 0) fail(path, "needs at least one question");
  const seen = /* @__PURE__ */ new Set();
  return list.map((q, i) => {
    const v = validateQuestion(q, `${path}[${i}]`);
    if (seen.has(v.id)) fail(`${path}[${i}].id`, `duplicate "${v.id}"`);
    seen.add(v.id);
    return v;
  });
}
function validateBoardInput(x) {
  if (!isRecord(x)) fail("board", "must be an object");
  if (typeof x.title !== "string" || !x.title.trim()) fail("title", "must be a non-empty string");
  return {
    title: x.title,
    intro: typeof x.intro === "string" ? x.intro : void 0,
    layout: x.layout === void 0 ? void 0 : validateLayout(x.layout),
    questions: validateQuestions(x.questions)
  };
}
function validatePatch(x) {
  if (!isRecord(x)) fail("patch", "must be an object");
  if (x.title !== void 0 && (typeof x.title !== "string" || !x.title.trim())) fail("title", "must be a non-empty string");
  return {
    title: x.title,
    intro: typeof x.intro === "string" ? x.intro : void 0,
    layout: x.layout === void 0 ? void 0 : validateLayout(x.layout),
    questions: x.questions === void 0 ? void 0 : validateQuestions(x.questions)
  };
}

// src/punch-list/store.ts
var emptyState = () => ({ skipped: false, withdrawn: false, changed: false, explaining: false, explanations: [] });
var canonical = (x) => JSON.stringify(x, (_k, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
var same = (a, b) => canonical(a) === canonical(b);
function checkId(id) {
  if (!BOARD_ID.test(id)) throw new Error(`board id "${id}" must be lowercase letters, digits and "-" (max 63)`);
}
var BoardStore = class {
  constructor(onChange = () => {
  }) {
    this.onChange = onChange;
  }
  cache = /* @__PURE__ */ new Map();
  create(id, raw2, opts = {}) {
    checkId(id);
    const input = validateBoardInput(raw2);
    if (this.exists(id) && !opts.replace) throw new Error(`board "${id}" already exists; use push to change it, or replace to start over`);
    rmSync(paths().boardDir(id), { recursive: true, force: true });
    const board = {
      id,
      title: input.title,
      intro: input.intro,
      layout: input.layout ?? { type: "list" },
      questions: input.questions,
      qstate: Object.fromEntries(input.questions.map((q) => [q.id, emptyState()])),
      drafts: {},
      sent: {},
      forceSend: [],
      done: false,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      rev: 1,
      nextSeq: 1,
      readCursor: 0
    };
    this.save(board);
    return board;
  }
  exists(id) {
    if (!BOARD_ID.test(id)) return false;
    return this.cache.has(id) || existsSync2(join2(paths().boardDir(id), "board.json"));
  }
  get(id) {
    checkId(id);
    const cached = this.cache.get(id);
    if (cached) return cached;
    const file = join2(paths().boardDir(id), "board.json");
    if (!existsSync2(file)) throw new Error(`board "${id}" not found`);
    const board = JSON.parse(readFileSync2(file, "utf8"));
    this.cache.set(id, board);
    return board;
  }
  list() {
    const dir = paths().boards;
    if (!existsSync2(dir)) return [];
    return readdirSync(dir).filter((id) => existsSync2(join2(dir, id, "board.json"))).map((id) => this.get(id));
  }
  remove(id) {
    this.get(id);
    this.cache.delete(id);
    rmSync(paths().boardDir(id), { recursive: true, force: true });
    this.onChange(id);
  }
  /** Agent update: upserts Questions and replaces title, intro or Layout. */
  push(id, raw2) {
    const patch = validatePatch(raw2);
    const board = this.get(id);
    if (patch.title !== void 0) board.title = patch.title;
    if (patch.intro !== void 0) board.intro = patch.intro;
    if (patch.layout !== void 0) board.layout = patch.layout;
    for (const q of patch.questions ?? []) this.upsert(board, q);
    board.done = false;
    return this.commit(board);
  }
  upsert(board, q) {
    const i = board.questions.findIndex((x) => x.id === q.id);
    if (i === -1) {
      board.questions.push(q);
      board.qstate[q.id] = emptyState();
      return;
    }
    const answered = hasValue(board.drafts[q.id]) || board.sent[q.id] !== void 0;
    if (answered && !same(board.questions[i], q)) board.qstate[q.id].changed = true;
    board.questions[i] = q;
  }
  explain(id, qid, html) {
    const board = this.get(id);
    const s = this.state(board, qid);
    s.explanations.push({ at: (/* @__PURE__ */ new Date()).toISOString(), html, ...s.pendingQuestion ? { question: s.pendingQuestion } : {} });
    s.explaining = false;
    delete s.pendingQuestion;
    board.done = false;
    return this.commit(board);
  }
  withdraw(id, qid, reason) {
    const board = this.get(id);
    const s = this.state(board, qid);
    s.withdrawn = true;
    s.withdrawReason = reason;
    return this.commit(board);
  }
  /** Person typing or choosing: saved, not sent. */
  saveDraft(id, qid, answer) {
    const board = this.get(id);
    const s = this.state(board, qid);
    this.reopenForPerson(board);
    board.drafts[qid] = answer.note ? { value: answer.value, note: answer.note } : { value: answer.value };
    if (hasValue(board.drafts[qid])) s.skipped = false;
    return this.commit(board);
  }
  skip(id, qid, skipped) {
    const board = this.get(id);
    this.state(board, qid).skipped = skipped;
    return this.commit(board);
  }
  /** Person accepts a Changed question's Answer as it stands; it goes out on the next send. */
  confirm(id, qid) {
    const board = this.get(id);
    this.state(board, qid).changed = false;
    if (!board.forceSend.includes(qid)) board.forceSend.push(qid);
    return this.commit(board);
  }
  requestExplain(id, qid, text) {
    const board = this.get(id);
    const s = this.state(board, qid);
    s.explaining = true;
    if (text.trim()) s.pendingQuestion = text.trim();
    else delete s.pendingQuestion;
    const event = this.event(board, "explain", { qid, title: this.question(board, qid).title, text: text.trim() });
    this.commit(board);
    return event;
  }
  /** Unsent Answers: drafts that differ from what was last sent, plus confirmed Changed questions. */
  unsent(board) {
    return board.questions.map((q) => q.id).filter((qid) => {
      const d = board.drafts[qid];
      if (board.forceSend.includes(qid)) return true;
      if (d === void 0) return false;
      return !same(d, board.sent[qid]);
    });
  }
  send(id) {
    const board = this.get(id);
    this.reopenForPerson(board);
    const qids = this.unsent(board);
    if (qids.length === 0) return null;
    const answers = qids.map((qid) => {
      const d = board.drafts[qid] ?? { value: null };
      board.sent[qid] = d;
      board.qstate[qid].changed = false;
      return { qid, title: this.question(board, qid).title, value: d.value, ...d.note ? { note: d.note } : {} };
    });
    board.forceSend = [];
    const event = this.event(board, "answers", { answers });
    this.commit(board);
    return event;
  }
  done(id) {
    this.send(id);
    const board = this.get(id);
    const summary = { answered: [], skipped: [], unanswered: [] };
    for (const q of board.questions) {
      const status = questionStatus(board, q.id);
      if (status === "answered") summary.answered.push(q.id);
      else if (status === "skipped") summary.skipped.push(q.id);
      else if (status === "open") summary.unanswered.push(q.id);
    }
    board.done = true;
    const event = this.event(board, "done", summary);
    this.commit(board);
    return event;
  }
  reopen(id) {
    const board = this.get(id);
    board.done = false;
    const event = this.event(board, "reopened", {});
    this.commit(board);
    return event;
  }
  /** Events after the read cursor. With `advance`, they count as delivered. */
  readEvents(id, advance = true) {
    const board = this.get(id);
    const file = join2(paths().boardDir(id), "events.jsonl");
    if (!existsSync2(file)) return [];
    const events = readFileSync2(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.seq > board.readCursor);
    if (advance && events.length) {
      board.readCursor = events[events.length - 1].seq;
      this.persist(board);
    }
    return events;
  }
  /** A person changing answers on a done Board reopens it, so the agent listens again. */
  reopenForPerson(board) {
    if (!board.done) return;
    board.done = false;
    this.event(board, "reopened", { reason: "answer changed after done" });
  }
  question(board, qid) {
    const q = board.questions.find((x) => x.id === qid);
    if (!q) throw new Error(`question "${qid}" not found on board "${board.id}"`);
    return q;
  }
  state(board, qid) {
    this.question(board, qid);
    return board.qstate[qid] ??= emptyState();
  }
  event(board, type, data) {
    const event = { seq: board.nextSeq++, at: (/* @__PURE__ */ new Date()).toISOString(), type, data };
    mkdirSync2(paths().boardDir(board.id), { recursive: true });
    appendFileSync(join2(paths().boardDir(board.id), "events.jsonl"), JSON.stringify(event) + "\n");
    return event;
  }
  commit(board) {
    board.rev++;
    this.save(board);
    return board;
  }
  save(board) {
    this.persist(board);
    this.onChange(board.id);
  }
  persist(board) {
    this.cache.set(board.id, board);
    const dir = paths().boardDir(board.id);
    mkdirSync2(dir, { recursive: true });
    const tmp = join2(dir, "board.json.tmp");
    writeFileSync2(tmp, JSON.stringify(board, null, 2));
    renameSync(tmp, join2(dir, "board.json"));
  }
};

// src/punch-list/retention.ts
import { existsSync as existsSync3, readdirSync as readdirSync2, readFileSync as readFileSync3, rmSync as rmSync2 } from "node:fs";
import { join as join3 } from "node:path";
var DAY_MS = 864e5;
function cleanupBoards(now = /* @__PURE__ */ new Date()) {
  const { retentionDays } = loadConfig();
  const dir = paths().boards;
  if (!existsSync3(dir)) return [];
  const removed = [];
  for (const id of readdirSync2(dir)) {
    const file = join3(dir, id, "board.json");
    let createdAt;
    try {
      createdAt = Date.parse(JSON.parse(readFileSync3(file, "utf8")).createdAt);
    } catch {
      continue;
    }
    if (now.getTime() - createdAt > retentionDays * DAY_MS) {
      rmSync2(join3(dir, id), { recursive: true, force: true });
      removed.push(id);
    }
  }
  return removed.sort();
}

// src/punch-list/version.ts
var VERSION = "0.1.0";

// raw:/Users/valeriimaslenykov/Projects/personal/sidekick/src/punch-list/page/index.html
var page_default = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>punch-list boards</title>
<link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
<div class="page">
  <header class="head">
    <div class="eyebrow"><span class="brand">punch-list</span></div>
    <h1>Boards</h1>
  </header>
  <main id="list" class="index-list"><p class="muted">Loading\u2026</p></main>
</div>
<script type="module">
  const t = new URLSearchParams(location.search).get('t') || '';
  const list = document.getElementById('list');
  const res = await fetch('/api/index', { headers: { 'x-sidekick-token': t } });
  if (!res.ok) {
    list.innerHTML = '<p class="muted">Open this page from the link your agent printed; it carries the access token.</p>';
  } else {
    const { boards } = await res.json();
    list.replaceChildren();
    if (!boards.length) list.innerHTML = '<p class="muted">No boards yet. When an agent opens one, it shows up here.</p>';
    boards.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const b of boards) {
      const a = document.createElement('a');
      a.className = 'index-row';
      a.href = \`/b/\${encodeURIComponent(b.id)}?t=\${encodeURIComponent(t)}\`;
      const status = b.done ? 'done' : \`\${b.open} open\`;
      a.innerHTML = \`<span class="index-title"></span><span class="chip \${b.done ? 'ok' : ''}">\${status}</span><span class="muted index-date"></span>\`;
      a.querySelector('.index-title').textContent = b.title;
      a.querySelector('.index-date').textContent = new Date(b.createdAt).toLocaleString();
      list.append(a);
    }
  }
</script>
</body>
</html>
`;

// raw:/Users/valeriimaslenykov/Projects/personal/sidekick/src/punch-list/page/board.html
var board_default = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>punch-list</title>
<link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
<div class="page">
  <header class="head">
    <div class="eyebrow"><span class="brand">punch-list</span><span id="board-id"></span></div>
    <h1 id="title">Loading\u2026</h1>
    <div id="intro" class="intro rich"></div>
  </header>

  <div id="banner-conn" class="banner warn" hidden>Lost connection to the punch-list server. Reconnecting\u2026</div>
  <div id="banner-listen" class="banner warn" hidden>
    <div><strong>Claude isn't listening.</strong> Your answers are saved. Paste this into your agent to pick the board back up:</div>
    <div class="copyrow"><code id="resume-prompt"></code><button type="button" class="btn small" id="copy-resume">Copy</button></div>
  </div>
  <div id="banner-done" class="banner ok" hidden>
    <span>Marked done. Claude has your answers.</span>
    <button type="button" class="btn small ghost" id="reopen">Reopen</button>
  </div>

  <main id="board" class="board"></main>
</div>

<div class="bar" id="bar">
  <div class="bar-in">
    <div class="counts" id="counts"></div>
    <div class="actions" id="actions">
      <span class="listen-dot" id="listen-dot" title=""></span>
      <button type="button" class="btn" id="send">Send to Claude</button>
      <button type="button" class="btn ghost" id="done">Done</button>
    </div>
    <div class="actions" id="confirm-done" hidden>
      <span id="confirm-text"></span>
      <button type="button" class="btn ghost" id="keep">Keep answering</button>
      <button type="button" class="btn" id="done-anyway">Mark done anyway</button>
    </div>
  </div>
</div>

<div class="modal" id="modal" hidden>
  <div class="modal-back" data-close></div>
  <div class="modal-card" role="dialog" aria-modal="true">
    <button type="button" class="btn small ghost modal-x" data-close aria-label="Close">Close</button>
    <div id="modal-body"></div>
  </div>
</div>

<div class="toast" id="toast" hidden></div>
<script type="module" src="/assets/app.js"></script>
</body>
</html>
`;

// raw:/Users/valeriimaslenykov/Projects/personal/sidekick/src/punch-list/page/app.js
var app_default = "// punch-list Board page. Renders the Board the server streams over SSE, keeps the\n// person's typing local until it is saved, and talks back with small POSTs.\n\nconst token = new URLSearchParams(location.search).get('t') || '';\nconst boardId = decodeURIComponent(location.pathname.split('/')[2] || '');\nconst $ = (id) => document.getElementById(id);\n\nlet view = null;\n/** Answers typed here but not yet confirmed saved by the server: qid -> {value, note}. */\nconst local = {};\nconst saveTimers = {};\nconst inflight = new Set();\n/** qid -> { el, parts, keys } */\nconst cards = new Map();\nlet layoutKey = null;\nlet modal = null; // { qid, parent, next }\nconst listeners = {};\nconst ui = loadUi();\n\n// ---------- helpers ----------\n\nfunction el(tag, attrs = {}, ...kids) {\n  const n = document.createElement(tag);\n  for (const [k, v] of Object.entries(attrs)) {\n    if (v === undefined || v === null || v === false) continue;\n    if (k === 'class') n.className = v;\n    else if (k === 'text') n.textContent = v;\n    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);\n    else n.setAttribute(k, v === true ? '' : v);\n  }\n  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid);\n  return n;\n}\n\nfunction loadUi() {\n  try { return JSON.parse(localStorage.getItem(`pl:${boardId}:ui`) || '{}'); } catch { return {}; }\n}\nfunction saveUi() {\n  try { localStorage.setItem(`pl:${boardId}:ui`, JSON.stringify(ui)); } catch {}\n}\n\n/** Inserts agent HTML and runs any scripts in it (innerHTML alone never runs them). */\nfunction setRich(node, html) {\n  node.innerHTML = html || '';\n  for (const old of node.querySelectorAll('script')) {\n    const s = document.createElement('script');\n    for (const a of old.attributes) s.setAttribute(a.name, a.value);\n    s.textContent = old.textContent;\n    old.replaceWith(s);\n  }\n  queueMermaid();\n}\n\nlet mermaidQueued = false;\nlet mermaidLib = null;\nfunction queueMermaid() {\n  if (mermaidQueued) return;\n  mermaidQueued = true;\n  requestAnimationFrame(async () => {\n    mermaidQueued = false;\n    const pending = document.querySelectorAll('.mermaid:not([data-processed])');\n    if (!pending.length) return;\n    try {\n      if (!mermaidLib) {\n        mermaidLib = (await import('https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs')).default;\n        const dark = matchMedia('(prefers-color-scheme: dark)').matches;\n        mermaidLib.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default' });\n      }\n      await mermaidLib.run({ nodes: [...pending] });\n    } catch (err) {\n      console.warn('punch-list: mermaid failed', err);\n    }\n  });\n}\n\nasync function post(path, body = {}) {\n  let res;\n  try {\n    res = await fetch(`/b/${encodeURIComponent(boardId)}/${path}`, {\n      method: 'POST',\n      headers: { 'content-type': 'application/json', 'x-sidekick-token': token },\n      body: JSON.stringify(body),\n      // Lets a draft save finish even when the page is being closed or reloaded.\n      keepalive: true,\n    });\n  } catch (err) {\n    toast(\"Can't reach the punch-list server. Your answers are kept here and saved when it's back.\");\n    throw err;\n  }\n  if (!res.ok) {\n    const msg = (await res.json().catch(() => ({}))).error || res.statusText;\n    toast(`Couldn't save: ${msg}`);\n    throw new Error(msg);\n  }\n  return res.json();\n}\n\nlet toastTimer;\nfunction toast(text) {\n  const t = $('toast');\n  t.textContent = text;\n  t.hidden = false;\n  clearTimeout(toastTimer);\n  toastTimer = setTimeout(() => (t.hidden = true), 2600);\n}\n\nfunction hasValue(a) {\n  if (!a) return false;\n  const v = a.value;\n  if (v === undefined || v === null) return false;\n  if (typeof v === 'string') return v.trim() !== '';\n  if (Array.isArray(v)) return v.length > 0;\n  return true;\n}\n\nfunction answerOf(qid) {\n  return local[qid] ?? view?.drafts?.[qid];\n}\n\nfunction statusOf(q) {\n  if (q.state?.withdrawn) return 'withdrawn';\n  if (hasValue(answerOf(q.id))) return 'answered';\n  if (q.state?.skipped) return 'skipped';\n  return 'open';\n}\n\nfunction isUnsent(qid) {\n  return view.unsent.includes(qid) || qid in local;\n}\n\nfunction visible(q) {\n  if (!q.showIf) return true;\n  return Object.entries(q.showIf).every(([dep, want]) => {\n    const got = answerOf(dep)?.value;\n    const wants = Array.isArray(want) ? want.map(String) : [String(want)];\n    if (Array.isArray(got)) return got.some((g) => wants.includes(String(g)));\n    return got !== undefined && got !== null && wants.includes(String(got));\n  });\n}\n\n// ---------- answers ----------\n\nfunction setAnswer(qid, patch) {\n  const cur = answerOf(qid) || { value: null };\n  const next = { ...cur, ...patch };\n  if (!next.note) delete next.note;\n  local[qid] = next;\n  clearTimeout(saveTimers[qid]);\n  saveTimers[qid] = setTimeout(() => flushOne(qid), 400);\n  refreshDerived();\n  emit('answer', { qid, answer: next });\n}\n\nasync function flushOne(qid) {\n  clearTimeout(saveTimers[qid]);\n  delete saveTimers[qid];\n  const answer = local[qid];\n  if (!answer) return;\n  const p = post('draft', { qid, answer }).then(() => {\n    if (local[qid] === answer) delete local[qid];\n  });\n  inflight.add(p);\n  try { await p; } finally { inflight.delete(p); }\n}\n\n/** Saves every answer that isn't on the server yet, including ones whose save failed earlier. */\nasync function flushAll() {\n  await Promise.all([...inflight].map((p) => p.catch(() => {})));\n  await Promise.all(Object.keys(local).map(flushOne));\n}\n\n// ---------- question cards ----------\n\nfunction defKey(q) {\n  const { state, status, ...def } = q;\n  return JSON.stringify([def, state?.changed, state?.withdrawn, state?.withdrawReason]);\n}\nfunction threadKey(q) {\n  return JSON.stringify([q.state?.explanations, q.state?.explaining, q.state?.pendingQuestion]);\n}\n\nfunction makeCard(q) {\n  const parts = {\n    head: el('div', { class: 'card-head' }),\n    body: el('div', { class: 'card-body rich' }),\n    notice: el('div'),\n    input: el('div', { class: 'card-input' }),\n    note: el('div'),\n    thread: el('div', { class: 'thread' }),\n    ask: el('div'),\n    actions: el('div', { class: 'card-actions' }),\n  };\n  const node = el('section', { class: 'card', 'data-qid': q.id }, Object.values(parts));\n  const card = { el: node, parts, keys: {} };\n  cards.set(q.id, card);\n  return card;\n}\n\nfunction updateCard(q) {\n  const card = cards.get(q.id) || makeCard(q);\n  const { parts, keys } = card;\n  const dk = defKey(q);\n  const focusedInside = card.el.contains(document.activeElement) && document.activeElement !== document.body;\n\n  if (keys.def !== dk) {\n    keys.def = dk;\n    renderHead(q, parts.head);\n    setRich(parts.body, q.body);\n    parts.body.hidden = !q.body;\n    renderNotice(q, parts.notice);\n    renderInput(q, parts.input);\n    renderNote(q, parts.note);\n    renderActions(q, parts.actions, parts.ask);\n    keys.draft = JSON.stringify(view.drafts[q.id]);\n  } else {\n    // Another tab or a reload changed the saved answer: show it unless the person is typing here.\n    const dkey = JSON.stringify(view.drafts[q.id]);\n    if (keys.draft !== dkey && !(q.id in local) && !focusedInside) {\n      renderInput(q, parts.input);\n      renderNote(q, parts.note);\n    }\n    keys.draft = dkey;\n  }\n\n  const tk = threadKey(q);\n  if (keys.thread !== tk) {\n    keys.thread = tk;\n    renderThread(q, parts.thread);\n  }\n  refreshCardStatus(q, card);\n  return card;\n}\n\nfunction refreshCardStatus(q, card) {\n  const status = statusOf(q);\n  card.el.classList.toggle('is-answered', status === 'answered');\n  card.el.classList.toggle('is-withdrawn', status === 'withdrawn');\n  card.el.classList.toggle('is-changed', !!q.state?.changed);\n  const meta = card.parts.head.querySelector('.card-meta');\n  if (meta) {\n    meta.querySelector('[data-chip=status]').replaceWith(statusChip(q, status));\n    const unsent = meta.querySelector('[data-chip=unsent]');\n    unsent.hidden = !isUnsent(q.id) || status === 'withdrawn';\n  }\n  const skipBtn = card.parts.actions.querySelector('[data-act=skip]');\n  if (skipBtn) {\n    skipBtn.textContent = q.state?.skipped ? 'Unskip' : 'Skip for now';\n    skipBtn.hidden = status === 'answered' || status === 'withdrawn';\n  }\n  card.el.hidden = !visible(q);\n}\n\nfunction statusChip(q, status) {\n  const label = q.state?.changed ? 'changed' : q.state?.explaining ? 'explaining' : status;\n  const tone = q.state?.changed ? 'attn' : q.state?.explaining ? 'accent' : status === 'answered' ? 'ok' : status === 'skipped' ? 'attn' : '';\n  return el('span', { class: `chip ${tone}`, 'data-chip': 'status', text: label });\n}\n\nfunction renderHead(q, head) {\n  head.replaceChildren(\n    el('h3', { class: 'card-title', text: q.title }),\n    el('div', { class: 'card-meta' },\n      el('span', { 'data-chip': 'status' }),\n      el('span', { class: 'chip accent', 'data-chip': 'unsent', text: 'unsent', title: 'Not sent to Claude yet' }),\n      view.layout.type === 'columns' ? null : el('button', { type: 'button', class: 'btn small link', title: 'Open in a larger view', text: 'Expand', onclick: () => openModal(q.id) }),\n    ),\n  );\n}\n\nfunction renderNotice(q, box) {\n  box.replaceChildren();\n  if (q.state?.withdrawn) {\n    box.append(el('div', { class: 'notice muted-box', text: `Withdrawn${q.state.withdrawReason ? `: ${q.state.withdrawReason}` : ''}` }));\n  } else if (q.state?.changed) {\n    box.append(el('div', { class: 'notice attn' },\n      el('span', { text: 'Claude changed this question after you answered. Check your answer.' }),\n      el('button', { type: 'button', class: 'btn small ghost', text: 'My answer still stands', onclick: () => post('confirm', { qid: q.id }) }),\n    ));\n  }\n}\n\nfunction renderInput(q, box) {\n  box.replaceChildren();\n  if (q.state?.withdrawn) return;\n  const cur = answerOf(q.id)?.value;\n  const name = `q-${q.id}`;\n  switch (q.type) {\n    case 'yes-no':\n      box.append(seg([['yes', 'Yes'], ['no', 'No']], cur, (v) => setAnswer(q.id, { value: v })));\n      break;\n    case 'single':\n    case 'multi': {\n      const multi = q.type === 'multi';\n      const chosen = new Set(multi ? (Array.isArray(cur) ? cur : []) : [cur]);\n      box.append(el('div', { class: 'opts', role: multi ? 'group' : 'radiogroup' },\n        (q.options || []).map((o) => {\n          const input = el('input', { type: multi ? 'checkbox' : 'radio', name, value: o.value, checked: chosen.has(o.value) });\n          input.addEventListener('change', () => {\n            if (!multi) return setAnswer(q.id, { value: o.value });\n            const now = new Set(Array.isArray(answerOf(q.id)?.value) ? answerOf(q.id).value : []);\n            input.checked ? now.add(o.value) : now.delete(o.value);\n            setAnswer(q.id, { value: (q.options || []).map((x) => x.value).filter((v) => now.has(v)) });\n          });\n          const label = el('span', { class: 'opt-label' }, el('span', { class: 'rich' }));\n          setRich(label.firstChild, o.label);\n          if (o.recommended) label.append(el('span', { class: 'chip attn', text: 'recommended' }));\n          const body = el('span', { class: 'rich' }, label);\n          if (o.detail) {\n            const d = el('span', { class: 'opt-detail rich' });\n            setRich(d, o.detail);\n            body.append(d);\n          }\n          return el('label', { class: 'opt' }, input, body);\n        }),\n      ));\n      break;\n    }\n    case 'text': {\n      const ta = el('textarea', { name, placeholder: 'Type your answer' });\n      ta.value = typeof cur === 'string' ? cur : '';\n      ta.addEventListener('input', () => setAnswer(q.id, { value: ta.value }));\n      box.append(ta);\n      break;\n    }\n    case 'number': {\n      const inp = el('input', { type: 'number', name, min: q.min, max: q.max, step: q.step });\n      inp.value = cur ?? '';\n      inp.addEventListener('input', () => setAnswer(q.id, { value: inp.value === '' ? null : Number(inp.value) }));\n      box.append(inp);\n      break;\n    }\n    case 'scale': {\n      const min = q.min ?? 1, max = q.max ?? 5, step = q.step ?? 1;\n      const vals = [];\n      for (let v = min; v <= max + 1e-9; v += step) vals.push([v, String(v)]);\n      box.append(seg(vals, cur, (v) => setAnswer(q.id, { value: v })));\n      break;\n    }\n    case 'rank':\n      box.append(rankList(q, cur));\n      break;\n    case 'custom':\n      if (hasValue(answerOf(q.id))) box.append(el('div', { class: 'muted', text: `Recorded: ${JSON.stringify(cur)}` }));\n      break;\n  }\n}\n\nfunction seg(values, cur, onPick) {\n  return el('div', { class: 'seg' },\n    values.map(([v, label]) =>\n      el('button', { type: 'button', class: 'btn ghost', 'aria-pressed': String(cur === v), text: label, onclick: (e) => {\n        for (const b of e.currentTarget.parentNode.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));\n        onPick(v);\n      } }),\n    ),\n  );\n}\n\nfunction rankList(q, cur) {\n  const all = (q.options || []).map((o) => o.value);\n  const order = Array.isArray(cur) ? [...cur.filter((v) => all.includes(v)), ...all.filter((v) => !cur.includes(v))] : all;\n  const labelOf = (v) => q.options.find((o) => o.value === v)?.label ?? v;\n  const move = (i, d) => {\n    const next = [...order];\n    [next[i], next[i + d]] = [next[i + d], next[i]];\n    setAnswer(q.id, { value: next });\n    renderInput(q, cards.get(q.id).parts.input);\n  };\n  const list = el('ol', { class: 'rank' },\n    order.map((v, i) => el('li', {},\n      el('span', { text: labelOf(v) }),\n      el('button', { type: 'button', class: 'btn small ghost', text: '\u2191', 'aria-label': 'Move up', disabled: i === 0, onclick: () => move(i, -1) }),\n      el('button', { type: 'button', class: 'btn small ghost', text: '\u2193', 'aria-label': 'Move down', disabled: i === order.length - 1, onclick: () => move(i, 1) }),\n    )),\n  );\n  const wrap = el('div', { class: 'section' }, list);\n  if (!Array.isArray(cur)) wrap.append(el('button', { type: 'button', class: 'btn small ghost', text: 'This order is fine', onclick: () => { setAnswer(q.id, { value: order }); renderInput(q, cards.get(q.id).parts.input); } }));\n  return wrap;\n}\n\nfunction renderNote(q, box) {\n  box.replaceChildren();\n  if (q.state?.withdrawn) return;\n  const note = answerOf(q.id)?.note || '';\n  const ta = el('textarea', { placeholder: 'Note for Claude (optional)', rows: 2 });\n  ta.value = note;\n  ta.style.minHeight = '44px';\n  ta.addEventListener('input', () => setAnswer(q.id, { note: ta.value }));\n  if (note) return box.append(ta);\n  const toggle = el('button', { type: 'button', class: 'btn small link note-toggle', text: '+ Add a note', onclick: () => { toggle.replaceWith(ta); ta.focus(); } });\n  box.append(toggle);\n}\n\nfunction renderThread(q, box) {\n  box.replaceChildren();\n  for (const x of q.state?.explanations || []) {\n    const item = el('div', { class: 'expl' });\n    if (x.question) item.append(el('div', { class: 'expl-q' }, el('strong', { text: 'You asked: ' }), document.createTextNode(x.question)));\n    const body = el('div', { class: 'rich' });\n    setRich(body, x.html);\n    item.append(body);\n    box.append(item);\n  }\n  if (q.state?.explaining) {\n    box.append(el('div', { class: 'explaining' },\n      el('span', { class: 'dots', text: 'Claude is explaining' }),\n      q.state.pendingQuestion ? el('span', { class: 'muted', text: `(${q.state.pendingQuestion})` }) : null,\n    ));\n  }\n}\n\nfunction renderActions(q, actions, ask) {\n  actions.replaceChildren();\n  ask.replaceChildren();\n  if (q.state?.withdrawn) return;\n  const askBox = () => {\n    const ta = el('textarea', { placeholder: \"What's unclear? Ask your own question, or leave empty for a simpler explanation.\" });\n    const submit = async () => {\n      await post('explain', { qid: q.id, text: ta.value });\n      ask.replaceChildren();\n    };\n    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); });\n    ask.replaceChildren(el('div', { class: 'ask' }, ta,\n      el('div', { class: 'card-actions' },\n        el('button', { type: 'button', class: 'btn small', text: 'Ask Claude', onclick: submit }),\n        el('button', { type: 'button', class: 'btn small ghost', text: 'Cancel', onclick: () => ask.replaceChildren() }),\n      )));\n    ta.focus();\n  };\n  actions.append(\n    el('button', { type: 'button', class: 'btn small ghost', text: 'Wait, what? Explain better', onclick: askBox }),\n    el('button', { type: 'button', class: 'btn small link', 'data-act': 'skip', onclick: () => post('skip', { qid: q.id, skipped: !q.state?.skipped }) }),\n  );\n}\n\n// ---------- layouts ----------\n\nfunction groupsOf() {\n  const qs = view.questions;\n  const defined = view.layout.groups || [];\n  if (!defined.length) return null;\n  const ids = new Set(defined.map((g) => g.id));\n  const groups = defined.map((g) => ({ ...g, qs: qs.filter((q) => q.group === g.id) }));\n  const rest = qs.filter((q) => !ids.has(q.group));\n  if (rest.length) groups.push({ id: '_other', title: 'Other', qs: rest });\n  return groups.filter((g) => g.qs.length);\n}\n\nfunction computeLayoutKey() {\n  return JSON.stringify([view.layout, view.questions.map((q) => [q.id, q.group])]);\n}\n\nfunction buildLayout() {\n  closeModal();\n  const root = $('board');\n  root.replaceChildren();\n  const type = view.layout.type;\n  for (const q of view.questions) updateCard(q);\n  if (type === 'tabs') buildTabs(root);\n  else if (type === 'wizard') buildWizard(root);\n  else if (type === 'columns') buildColumns(root);\n  else if (type === 'custom') buildCustom(root);\n  else buildList(root);\n}\n\nfunction buildList(root) {\n  const groups = groupsOf();\n  if (!groups) return root.append(...view.questions.map((q) => cards.get(q.id).el));\n  for (const g of groups) root.append(el('div', { class: 'section' }, el('h2', { text: g.title }), g.qs.map((q) => cards.get(q.id).el)));\n}\n\nfunction pages() {\n  const groups = groupsOf();\n  if (groups) return groups;\n  return view.questions.map((q, i) => ({ id: q.id, title: `${i + 1}. ${q.title.length > 28 ? q.title.slice(0, 27) + '\u2026' : q.title}`, qs: [q] }));\n}\n\nfunction buildTabs(root) {\n  const ps = pages();\n  if (!ps.length) return;\n  if (!ps.some((p) => p.id === ui.tab)) ui.tab = ps[0]?.id;\n  const bar = el('div', { class: 'tabs', role: 'tablist' });\n  const panel = el('div', { class: 'section' });\n  const show = (id) => {\n    ui.tab = id;\n    saveUi();\n    for (const b of bar.children) b.setAttribute('aria-selected', String(b.dataset.id === id));\n    panel.replaceChildren(...ps.find((p) => p.id === id).qs.map((q) => cards.get(q.id).el));\n    queueMermaid();\n  };\n  for (const p of ps) {\n    bar.append(el('button', { type: 'button', class: 'tab', role: 'tab', 'data-id': p.id, onclick: () => show(p.id) },\n      el('span', { text: p.title }), el('span', { class: 'count', 'data-count': p.id })));\n  }\n  root.append(bar, panel);\n  show(ui.tab);\n}\n\nfunction buildWizard(root) {\n  const ps = pages();\n  if (!ps.length) return;\n  ui.step = Math.min(Math.max(0, ui.step || 0), ps.length - 1);\n  const progress = el('div', { class: 'progress' }, el('div'));\n  const label = el('span', { class: 'muted' });\n  const panel = el('div', { class: 'section' });\n  const back = el('button', { type: 'button', class: 'btn ghost', text: 'Back' });\n  const next = el('button', { type: 'button', class: 'btn', text: 'Next' });\n  const show = (i) => {\n    ui.step = i;\n    saveUi();\n    const p = ps[i];\n    label.textContent = `Step ${i + 1} of ${ps.length}${p && view.layout.groups?.length ? ` \xB7 ${p.title}` : ''}`;\n    progress.firstChild.style.width = `${((i + 1) / ps.length) * 100}%`;\n    panel.replaceChildren(...(p ? p.qs.map((q) => cards.get(q.id).el) : []));\n    back.disabled = i === 0;\n    next.disabled = i === ps.length - 1;\n    next.textContent = i === ps.length - 1 ? 'Last step' : 'Next';\n    queueMermaid();\n    scrollTo({ top: 0, behavior: 'smooth' });\n  };\n  back.onclick = () => show(ui.step - 1);\n  next.onclick = () => show(ui.step + 1);\n  root.append(progress, el('div', { class: 'wizard-nav' }, label), panel, el('div', { class: 'wizard-nav' }, back, next));\n  show(ui.step);\n}\n\nfunction buildColumns(root) {\n  root.append(el('div', { class: 'columns', id: 'columns' }));\n  fillColumns();\n}\n\nfunction fillColumns() {\n  const wrap = $('columns');\n  if (!wrap) return;\n  const byStatus = view.layout.columnsBy === 'status' || !view.layout.groups?.length;\n  const cols = byStatus\n    ? [['open', 'Open'], ['skipped', 'Skipped'], ['answered', 'Answered'], ['withdrawn', 'Withdrawn']].map(([id, title]) => ({ id, title, qs: view.questions.filter((q) => statusOf(q) === id) }))\n    : groupsOf();\n  wrap.replaceChildren(...cols.filter((c) => c.qs.length || c.id === 'open').map((c) => {\n    const shown = c.qs.filter(visible);\n    return el('div', { class: 'column' },\n      el('h2', {}, el('span', { text: c.title }), el('span', { text: String(shown.length) })),\n      shown.map((q) => {\n        const status = statusOf(q);\n        return el('button', { type: 'button', class: 'mini', onclick: () => openModal(q.id) },\n          el('span', { class: 'mini-title', text: q.title }),\n          el('span', { class: 'card-meta' }, statusChip(q, status), isUnsent(q.id) ? el('span', { class: 'chip accent', text: 'unsent' }) : null),\n        );\n      }),\n    );\n  }));\n}\n\nfunction buildCustom(root) {\n  setRich(root, view.layout.html);\n  const placed = new Set();\n  for (const slot of root.querySelectorAll('[data-pl-question]')) {\n    const card = cards.get(slot.getAttribute('data-pl-question'));\n    if (card) {\n      slot.replaceChildren(card.el);\n      placed.add(slot.getAttribute('data-pl-question'));\n    }\n  }\n  const rest = view.questions.filter((q) => !placed.has(q.id));\n  if (rest.length) root.append(el('div', { class: 'section' }, el('h2', { text: 'More questions' }), rest.map((q) => cards.get(q.id).el)));\n  if (view.layout.script) {\n    try { new Function('punchList', view.layout.script)(api); } catch (err) { console.error('punch-list: layout script failed', err); toast('The custom layout script failed; see the console.'); }\n  }\n}\n\n// ---------- modal ----------\n\nfunction openModal(qid) {\n  closeModal();\n  const card = cards.get(qid);\n  if (!card) return;\n  modal = { qid, parent: card.el.parentNode, next: card.el.nextSibling };\n  $('modal-body').replaceChildren(card.el);\n  card.el.hidden = false;\n  $('modal').hidden = false;\n  queueMermaid();\n}\n\nfunction closeModal() {\n  if (!modal) return;\n  const card = cards.get(modal.qid);\n  if (card && modal.parent) modal.parent.insertBefore(card.el, modal.next);\n  else card?.el.remove();\n  modal = null;\n  $('modal').hidden = true;\n  if (view?.layout.type === 'columns') fillColumns();\n}\n\ndocument.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });\ndocument.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });\n\n// ---------- bar, banners, counts ----------\n\nfunction refreshDerived() {\n  if (!view) return;\n  for (const q of view.questions) {\n    const card = cards.get(q.id);\n    if (card) refreshCardStatus(q, card);\n  }\n  const shown = view.questions.filter((q) => visible(q) && statusOf(q) !== 'withdrawn');\n  const count = (s) => shown.filter((q) => statusOf(q) === s).length;\n  const unsent = shown.filter((q) => isUnsent(q.id)).length;\n  $('counts').replaceChildren(...[\n    el('span', { text: `${count('answered')}/${shown.length} answered` }),\n    count('skipped') ? el('span', { text: `${count('skipped')} skipped` }) : null,\n    el('span', { text: unsent ? `${unsent} unsent` : 'all sent' }),\n  ].filter(Boolean));\n  const send = $('send');\n  send.textContent = unsent ? `Send to Claude (${unsent})` : 'Send to Claude';\n  send.disabled = unsent === 0;\n  $('done').textContent = view.done ? 'Done \u2713' : 'Done';\n  $('done').disabled = view.done;\n  for (const badge of document.querySelectorAll('[data-count]')) {\n    const p = pages().find((x) => x.id === badge.dataset.count);\n    const open = p ? p.qs.filter((q) => visible(q) && ['open', 'skipped'].includes(statusOf(q))).length : 0;\n    badge.textContent = open ? String(open) : '\u2713';\n  }\n  if (view.layout.type === 'columns' && !modal) fillColumns();\n}\n\nfunction refreshBanners() {\n  $('banner-listen').hidden = view.listening || view.done;\n  $('resume-prompt').textContent = view.resumePrompt;\n  $('banner-done').hidden = !view.done;\n  const dot = $('listen-dot');\n  dot.classList.toggle('on', view.listening);\n  dot.title = view.listening ? 'Claude is listening' : \"Claude isn't listening\";\n}\n\n$('copy-resume').addEventListener('click', async () => {\n  const text = $('resume-prompt').textContent;\n  try { await navigator.clipboard.writeText(text); toast('Copied. Paste it into your agent.'); }\n  catch { const r = document.createRange(); r.selectNodeContents($('resume-prompt')); getSelection().removeAllRanges(); getSelection().addRange(r); }\n});\n\n$('send').addEventListener('click', async () => {\n  await flushAll();\n  const { sent } = await post('send');\n  toast(sent ? 'Sent to Claude.' : 'Nothing new to send.');\n});\n\n$('done').addEventListener('click', async () => {\n  await flushAll();\n  const shown = view.questions.filter((q) => visible(q) && statusOf(q) !== 'withdrawn');\n  const open = shown.filter((q) => statusOf(q) === 'open').length;\n  const skipped = shown.filter((q) => statusOf(q) === 'skipped').length;\n  if (open + skipped === 0) return finish();\n  $('confirm-text').textContent = [open && `${open} not answered`, skipped && `${skipped} skipped`].filter(Boolean).join(', ') + '.';\n  $('actions').hidden = true;\n  $('confirm-done').hidden = false;\n});\n$('keep').addEventListener('click', () => { $('actions').hidden = false; $('confirm-done').hidden = true; });\n$('done-anyway').addEventListener('click', finish);\nasync function finish() {\n  $('actions').hidden = false;\n  $('confirm-done').hidden = true;\n  await flushAll();\n  await post('done');\n  toast('Marked done. Claude has your answers.');\n}\n$('reopen').addEventListener('click', () => post('reopen'));\n\n// ---------- custom-layout API ----------\n\nfunction emit(name, payload) {\n  for (const fn of listeners[name] || []) {\n    try { fn(payload); } catch (err) { console.error(err); }\n  }\n}\n\nconst api = {\n  answer: (qid, value) => setAnswer(qid, { value }),\n  note: (qid, note) => setAnswer(qid, { note }),\n  explain: (qid, text = '') => post('explain', { qid, text }),\n  skip: (qid, skipped = true) => post('skip', { qid, skipped }),\n  send: () => $('send').click(),\n  done: () => $('done').click(),\n  open: (qid) => openModal(qid),\n  state: () => ({ ...view, answers: Object.fromEntries(view.questions.map((q) => [q.id, answerOf(q.id)])) }),\n  on: (name, fn) => { (listeners[name] ||= []).push(fn); return () => { listeners[name] = listeners[name].filter((f) => f !== fn); }; },\n  renderQuestion: (qid, node) => { const c = cards.get(qid); if (c) node.replaceChildren(c.el); },\n};\nwindow.punchList = api;\n\n// ---------- live connection ----------\n\nfunction render(next) {\n  const firstRender = !view;\n  view = next;\n  document.title = `${view.title} \xB7 punch-list`;\n  $('title').textContent = view.title;\n  $('board-id').textContent = view.id;\n  if ($('intro').dataset.html !== (view.intro || '')) {\n    $('intro').dataset.html = view.intro || '';\n    setRich($('intro'), view.intro);\n  }\n  const lk = computeLayoutKey();\n  if (lk !== layoutKey) {\n    layoutKey = lk;\n    buildLayout();\n  } else {\n    for (const q of view.questions) updateCard(q);\n  }\n  for (const id of [...cards.keys()]) if (!view.questions.some((q) => q.id === id)) cards.delete(id);\n  refreshBanners();\n  refreshDerived();\n  emit('state', api.state());\n  if (firstRender) queueMermaid();\n}\n\nfunction connect() {\n  const es = new EventSource(`/b/${encodeURIComponent(boardId)}/stream?t=${encodeURIComponent(token)}`);\n  let lostTimer;\n  let lost = false;\n  es.addEventListener('state', (e) => {\n    clearTimeout(lostTimer);\n    $('banner-conn').hidden = true;\n    render(JSON.parse(e.data));\n    if (lost) {\n      lost = false;\n      // Back online: save anything that failed while the server was away.\n      flushAll().catch(() => {});\n    }\n  });\n  es.onerror = () => {\n    lost = true;\n    clearTimeout(lostTimer);\n    lostTimer = setTimeout(() => ($('banner-conn').hidden = false), 1500);\n  };\n}\n\nwindow.addEventListener('beforeunload', () => { for (const qid of Object.keys(saveTimers)) flushOne(qid); });\nconnect();\n";

// raw:/Users/valeriimaslenykov/Projects/personal/sidekick/src/punch-list/page/styles.css
var styles_default = '/* Layout: one reading column of question cards, a sticky action bar at the bottom. */\n:root {\n  --bg: #f4f5f7;\n  --surface: #ffffff;\n  --sunk: #eef0f3;\n  --ink: #1b2130;\n  --muted: #5d6677;\n  --line: #d8dce3;\n  --accent: #2c56c9;\n  --accent-ink: #ffffff;\n  --accent-soft: #e6edfb;\n  --attn: #9a5b00;\n  --attn-soft: #fcf0d9;\n  --ok: #1d7a43;\n  --ok-soft: #e0f2e7;\n  --bad: #b3261e;\n  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;\n  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;\n  color-scheme: light;\n}\n@media (prefers-color-scheme: dark) {\n  :root {\n    --bg: #13161c;\n    --surface: #1b1f27;\n    --sunk: #151920;\n    --ink: #e6e9ef;\n    --muted: #9aa3b2;\n    --line: #2d333f;\n    --accent: #7ea2ff;\n    --accent-ink: #0d1424;\n    --accent-soft: #1f2a44;\n    --attn: #f2b55c;\n    --attn-soft: #3a2c15;\n    --ok: #6fd39a;\n    --ok-soft: #173326;\n    --bad: #ff8a80;\n    color-scheme: dark;\n  }\n}\n\n* { box-sizing: border-box; }\nhtml, body { margin: 0; }\nbody { background: var(--bg); color: var(--ink); font: 15px/1.5 var(--font); }\n[hidden] { display: none !important; }\na { color: var(--accent); }\ncode { font-family: var(--mono); font-size: 0.9em; background: var(--sunk); padding: 1px 5px; border-radius: 4px; overflow-wrap: anywhere; }\npre { overflow-x: auto; background: var(--sunk); padding: 10px 12px; border-radius: 8px; font-size: 13px; }\npre code { background: none; padding: 0; }\nimg, svg, canvas, video { max-width: 100%; }\n\n.page { max-width: 820px; margin: 0 auto; padding: 28px 16px 140px; display: flex; flex-direction: column; gap: 16px; }\n.head { display: flex; flex-direction: column; gap: 4px; }\n.eyebrow { display: flex; gap: 10px; font-family: var(--mono); font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }\n.brand { color: var(--accent); font-weight: 600; }\nh1 { margin: 0; font-size: 26px; line-height: 1.2; text-wrap: balance; }\n.intro { color: var(--muted); max-width: 70ch; }\n.intro:empty { display: none; }\n.muted { color: var(--muted); }\n\n.banner { border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }\n.banner.warn { background: var(--attn-soft); color: var(--attn); }\n.banner.ok { background: var(--ok-soft); color: var(--ok); flex-direction: row; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }\n.copyrow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }\n.copyrow code { color: var(--ink); flex: 1 1 300px; padding: 6px 8px; }\n\n.board { display: flex; flex-direction: column; gap: 14px; }\n.section { display: flex; flex-direction: column; gap: 12px; }\n.section > h2 { margin: 8px 0 0; font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }\n\n/* Question card */\n.card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }\n.card.is-answered { border-color: color-mix(in srgb, var(--ok) 45%, var(--line)); }\n.card.is-changed { border-color: var(--attn); }\n.card.is-withdrawn { opacity: .55; }\n.card-head { display: flex; gap: 10px; align-items: flex-start; justify-content: space-between; }\n.card-title { margin: 0; font-size: 17px; line-height: 1.35; text-wrap: balance; min-width: 0; }\n.card-meta { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }\n.chip { font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; padding: 2px 8px; border-radius: 999px; background: var(--sunk); color: var(--muted); white-space: nowrap; }\n.chip.ok { background: var(--ok-soft); color: var(--ok); }\n.chip.attn { background: var(--attn-soft); color: var(--attn); }\n.chip.accent { background: var(--accent-soft); color: var(--accent); }\n.rich { min-width: 0; overflow-wrap: anywhere; }\n.rich > :first-child { margin-top: 0; }\n.rich > :last-child { margin-bottom: 0; }\n.rich table { border-collapse: collapse; display: block; overflow-x: auto; }\n.rich th, .rich td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; }\n.card-body { color: var(--ink); }\n.notice { border-radius: 8px; padding: 8px 10px; font-size: 14px; display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }\n.notice.attn { background: var(--attn-soft); color: var(--attn); }\n.notice.muted-box { background: var(--sunk); color: var(--muted); }\n\n/* Inputs */\n.opts { display: grid; gap: 8px; }\n.opt { display: grid; grid-template-columns: 18px 1fr; gap: 10px; align-items: start; padding: 10px 12px; border: 1px solid var(--line); border-radius: 9px; cursor: pointer; background: var(--surface); }\n.opt:hover { border-color: var(--accent); }\n.opt:has(input:checked) { border-color: var(--accent); background: var(--accent-soft); }\n.opt input { margin: 3px 0 0; accent-color: var(--accent); }\n.opt-label { font-weight: 600; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }\n.opt-detail { color: var(--muted); font-size: 14px; display: block; margin-top: 2px; }\n.seg { display: flex; flex-wrap: wrap; gap: 8px; }\n.seg button { min-width: 64px; }\n.seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }\ntextarea, input[type="number"] { width: 100%; font: inherit; color: var(--ink); background: var(--sunk); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }\ntextarea { min-height: 80px; resize: vertical; }\ninput[type="number"] { max-width: 200px; }\ntextarea:focus-visible, input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }\n.rank { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; counter-reset: rank; }\n.rank li { display: flex; gap: 10px; align-items: center; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }\n.rank li::before { counter-increment: rank; content: counter(rank); font-family: var(--mono); color: var(--muted); width: 1.5em; }\n.rank li span { flex: 1; min-width: 0; }\n.note-toggle { align-self: flex-start; }\n\n/* Explanations */\n.thread { display: flex; flex-direction: column; gap: 10px; border-left: 3px solid var(--accent); padding-left: 12px; }\n.thread:empty { display: none; }\n.expl-q { font-size: 13px; color: var(--muted); }\n.expl-q strong { color: var(--ink); font-weight: 600; }\n.explaining { color: var(--accent); font-size: 14px; display: flex; align-items: center; gap: 8px; }\n.dots::after { content: "\u2026"; animation: dots 1.2s steps(4, end) infinite; display: inline-block; width: 1.2em; overflow: hidden; vertical-align: bottom; }\n@keyframes dots { from { width: 0; } to { width: 1.2em; } }\n.ask { display: flex; flex-direction: column; gap: 8px; background: var(--sunk); border-radius: 10px; padding: 10px; }\n.ask textarea { min-height: 56px; background: var(--surface); }\n.card-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }\n\n/* Buttons */\n.btn { font: inherit; font-weight: 600; font-size: 14px; border-radius: 8px; padding: 8px 14px; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink); cursor: pointer; }\n.btn.ghost { background: transparent; color: var(--accent); border-color: var(--line); }\n.btn.ghost:hover { border-color: var(--accent); }\n.btn.small { padding: 4px 10px; font-size: 13px; }\n.btn.link { background: none; border: none; color: var(--accent); padding: 4px 2px; font-weight: 500; }\n.btn:disabled { opacity: .45; cursor: not-allowed; }\n\n/* Tabs */\n.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); overflow-x: auto; }\n.tab { font: inherit; font-weight: 600; font-size: 14px; background: none; border: none; border-bottom: 2px solid transparent; padding: 8px 12px; color: var(--muted); cursor: pointer; white-space: nowrap; display: flex; gap: 6px; align-items: center; }\n.tab[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--accent); }\n.tab .count { font-family: var(--mono); font-size: 11px; background: var(--sunk); padding: 0 6px; border-radius: 999px; }\n\n/* Wizard */\n.wizard-nav { display: flex; justify-content: space-between; align-items: center; gap: 10px; }\n.progress { height: 4px; background: var(--sunk); border-radius: 999px; overflow: hidden; }\n.progress > div { height: 100%; background: var(--accent); transition: width .2s; }\n\n/* Columns */\n.columns { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(230px, 1fr); gap: 12px; overflow-x: auto; padding-bottom: 6px; }\n.column { background: var(--sunk); border-radius: 12px; padding: 10px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }\n.column > h2 { margin: 2px 4px 4px; font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); display: flex; justify-content: space-between; }\n.mini { background: var(--surface); border: 1px solid var(--line); border-radius: 9px; padding: 10px; text-align: left; font: inherit; color: var(--ink); cursor: pointer; display: flex; flex-direction: column; gap: 6px; }\n.mini:hover { border-color: var(--accent); }\n.mini-title { font-weight: 600; font-size: 14px; }\n.page:has(.columns) { max-width: 1200px; }\n\n/* Bar */\n.bar { position: fixed; left: 0; right: 0; bottom: 0; background: color-mix(in srgb, var(--surface) 94%, transparent); backdrop-filter: blur(8px); border-top: 1px solid var(--line); }\n.bar-in { max-width: 1200px; margin: 0 auto; padding: 10px 16px; display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; }\n.counts { font-family: var(--mono); font-size: 13px; color: var(--muted); display: flex; gap: 12px; flex-wrap: wrap; }\n.actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }\n.listen-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); }\n.listen-dot.on { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }\n\n/* Modal */\n.modal { position: fixed; inset: 0; display: grid; place-items: center; padding: 16px; z-index: 20; }\n.modal-back { position: absolute; inset: 0; background: rgb(0 0 0 / .45); }\n.modal-card { position: relative; width: min(760px, 100%); max-height: calc(100vh - 32px); overflow: auto; background: var(--bg); border-radius: 14px; padding: 44px 14px 14px; }\n.modal-x { position: absolute; top: 10px; right: 10px; }\n\n.toast { position: fixed; left: 50%; bottom: 78px; transform: translateX(-50%); background: var(--ink); color: var(--bg); padding: 8px 14px; border-radius: 8px; font-size: 14px; z-index: 30; }\n\n.index-list { display: flex; flex-direction: column; gap: 8px; }\n.index-row { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; padding: 12px 14px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; text-decoration: none; color: var(--ink); }\n.index-row:hover { border-color: var(--accent); }\n.index-title { font-weight: 600; }\n.index-date { font-size: 13px; grid-column: 1 / -1; }\n\n@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }\n';

// src/punch-list/server.ts
var LISTENER_GRACE_MS = 1e4;
var MAX_WAIT_S = 25;
var EVENT_SETTLE_MS = 150;
function resumePrompt(id) {
  return `Use the punch-list skill to resume board "${id}": run its \`status ${id}\` command, handle anything pending, then run \`wait ${id}\` in the background.`;
}
function createApp({ token, now = Date.now }) {
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const store = new BoardStore((id) => bus.emit("change", id));
  const listeners = /* @__PURE__ */ new Map();
  const isListening = (id) => {
    const l = listeners.get(id);
    if (!l) return false;
    return l.open > 0 || now() - l.lastSeen < LISTENER_GRACE_MS;
  };
  const touchListener = (id, delta) => {
    const l = listeners.get(id) ?? { open: 0, lastSeen: 0 };
    l.open = Math.max(0, l.open + delta);
    l.lastSeen = now();
    listeners.set(id, l);
    bus.emit("change", id);
    if (l.open === 0) setTimeout(() => bus.emit("change", id), LISTENER_GRACE_MS + 50).unref?.();
  };
  const view = (board) => ({
    id: board.id,
    title: board.title,
    intro: board.intro,
    layout: board.layout,
    rev: board.rev,
    done: board.done,
    questions: board.questions.map((q) => ({ ...q, state: board.qstate[q.id], status: questionStatus(board, q.id) })),
    drafts: board.drafts,
    sent: board.sent,
    unsent: store.unsent(board),
    listening: isListening(board.id),
    resumePrompt: resumePrompt(board.id)
  });
  const app = new Hono2();
  const hasToken = (c) => c.req.header("x-sidekick-token") === token || c.req.query("t") === token;
  app.get("/api/health", (c) => c.json({ app: "punch-list", version: VERSION, pid: process.pid }));
  app.get("/favicon.ico", (c) => c.body(null, 204));
  app.get("/assets/app.js", (c) => c.body(app_default, 200, { "content-type": "text/javascript; charset=utf-8" }));
  app.get("/assets/styles.css", (c) => c.body(styles_default, 200, { "content-type": "text/css; charset=utf-8" }));
  app.use("*", async (c, next) => {
    if (!hasToken(c)) return c.json({ error: "missing or wrong token" }, 401);
    await next();
  });
  app.onError((err, c) => {
    const msg = err instanceof Error ? err.message : String(err);
    const status = /not found/.test(msg) ? 404 : /already exists/.test(msg) ? 409 : 400;
    return c.json({ error: msg }, status);
  });
  app.post("/api/boards", async (c) => {
    const { id, input, replace, projectDir, sessionId } = await c.req.json();
    const board = store.create(id, input, { replace, projectDir, sessionId });
    return c.json({ id: board.id });
  });
  app.get(
    "/api/boards",
    (c) => c.json({ boards: store.list().map((b) => ({ id: b.id, title: b.title, done: b.done, createdAt: b.createdAt, listening: isListening(b.id), projectDir: b.projectDir })) })
  );
  app.get("/api/boards/:id", (c) => {
    const board = store.get(c.req.param("id"));
    return c.json({ board, unsent: store.unsent(board), listening: isListening(board.id), pending: store.readEvents(board.id, false) });
  });
  app.delete("/api/boards/:id", (c) => {
    store.remove(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/boards/:id/push", async (c) => {
    store.push(c.req.param("id"), await c.req.json());
    return c.json({ ok: true });
  });
  app.post("/api/boards/:id/explain", async (c) => {
    const { qid, html } = await c.req.json();
    store.explain(c.req.param("id"), qid, html);
    return c.json({ ok: true });
  });
  app.post("/api/boards/:id/close", (c) => {
    store.done(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/boards/:id/withdraw", async (c) => {
    const { qid, reason } = await c.req.json();
    store.withdraw(c.req.param("id"), qid, reason ?? "");
    return c.json({ ok: true });
  });
  app.get("/api/boards/:id/wait", async (c) => {
    const id = c.req.param("id");
    store.get(id);
    const timeoutS = Math.min(MAX_WAIT_S, Math.max(0, Number(c.req.query("timeout") ?? MAX_WAIT_S)));
    const signal = c.req.raw.signal;
    touchListener(id, 1);
    try {
      let events = store.readEvents(id);
      if (events.length === 0 && timeoutS > 0) {
        events = await new Promise((resolve, reject) => {
          const done = (result) => {
            clearTimeout(timer);
            clearTimeout(settling);
            bus.off("change", onChange);
            signal.removeEventListener("abort", onAbort);
            resolve(result);
          };
          const onAbort = () => done([]);
          signal.addEventListener("abort", onAbort);
          let settling;
          const onChange = (changed) => {
            if (changed !== id || settling) return;
            settling = setTimeout(() => {
              settling = void 0;
              if (signal.aborted) return done([]);
              if (!store.exists(id)) {
                reject(new Error(`board "${id}" not found`));
                return done([]);
              }
              const fresh = store.readEvents(id);
              if (fresh.length) done(fresh);
            }, EVENT_SETTLE_MS);
          };
          const timer = setTimeout(() => done([]), timeoutS * 1e3);
          bus.on("change", onChange);
        });
      }
      return c.json({ events });
    } finally {
      touchListener(id, -1);
    }
  });
  app.get("/api/listening", (c) => {
    const session = c.req.query("session");
    const cwd = c.req.query("cwd");
    const boards = store.list().filter((b) => !b.done && !isListening(b.id)).filter((b) => session ? b.sessionId === session : cwd ? b.projectDir === cwd : true).map((b) => ({ id: b.id, title: b.title, resumePrompt: resumePrompt(b.id) }));
    return c.json({ boards });
  });
  app.get("/", (c) => c.html(page_default));
  app.get("/b/:id", (c) => {
    store.get(c.req.param("id"));
    return c.html(board_default);
  });
  app.get("/b/:id/stream", (c) => {
    const id = c.req.param("id");
    store.get(id);
    return streamSSE(c, async (stream2) => {
      let closed = false;
      const send = async () => {
        if (closed || !store.exists(id)) return;
        await stream2.writeSSE({ event: "state", data: JSON.stringify(view(store.get(id))) });
      };
      const onChange = (changed) => {
        if (changed === id) void send();
      };
      bus.on("change", onChange);
      stream2.onAbort(() => {
        closed = true;
        bus.off("change", onChange);
      });
      await send();
      while (!closed) {
        await stream2.sleep(15e3);
        if (!closed) await stream2.writeSSE({ event: "ping", data: "" });
      }
    });
  });
  app.get(
    "/api/index",
    (c) => c.json({ boards: store.list().map((b) => ({ id: b.id, title: b.title, done: b.done, createdAt: b.createdAt, listening: isListening(b.id), open: b.questions.filter((q) => questionStatus(b, q.id) === "open").length })) })
  );
  app.post("/b/:id/draft", async (c) => {
    const { qid, answer } = await c.req.json();
    store.saveDraft(c.req.param("id"), qid, answer);
    return c.json({ ok: true });
  });
  app.post("/b/:id/skip", async (c) => {
    const { qid, skipped } = await c.req.json();
    store.skip(c.req.param("id"), qid, skipped !== false);
    return c.json({ ok: true });
  });
  app.post("/b/:id/confirm", async (c) => {
    const { qid } = await c.req.json();
    store.confirm(c.req.param("id"), qid);
    return c.json({ ok: true });
  });
  app.post("/b/:id/explain", async (c) => {
    const { qid, text } = await c.req.json();
    store.requestExplain(c.req.param("id"), qid, text ?? "");
    return c.json({ ok: true });
  });
  app.post("/b/:id/send", (c) => c.json({ sent: store.send(c.req.param("id")) !== null }));
  app.post("/b/:id/done", (c) => {
    store.done(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/b/:id/reopen", (c) => {
    store.reopen(c.req.param("id"));
    return c.json({ ok: true });
  });
  return { app, store, isListening };
}
async function startServer() {
  const { port } = loadConfig();
  cleanupBoards();
  const { app } = createApp({ token: getToken() });
  await new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => resolve());
    server.on("error", reject);
  });
  return { port };
}

// src/punch-list/cli.ts
var BIN = fileURLToPath(import.meta.url);
var USAGE = `punch-list ${VERSION}: put an agent's questions on a live local web page.

  open <board> --file <path|-> [--replace] [--no-open]   create a Board from JSON, print its URL
  push <board> --file <path|->                           add or update Questions, title, intro or Layout
  explain <board> <question> (--html <html> | --file <path|->)   add an Explanation to a Question
  withdraw <board> <question> --reason <text>           grey out a Question that is no longer needed
  close <board>                                          mark the Board done from the agent side
  wait <board> [--timeout <seconds>]                     block until Events arrive, print them as JSON
  status <board>                                         full snapshot: Questions, Answers, pending Events
  url <board> | list | rm <board> | stop

Board format: see reference/board-format.md next to this skill's SKILL.md.`;
function parse(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== void 0 && !next.startsWith("--")) {
        out.flags[key] = next;
        i++;
      } else out.flags[key] = true;
    } else out._.push(a);
  }
  return out;
}
function readSource(file, what) {
  if (typeof file !== "string") throw new Error(`${what} needs --file <path> (or --file - for stdin)`);
  return file === "-" ? readFileSync4(0, "utf8") : readFileSync4(file, "utf8");
}
function readJson(file, what) {
  const text = readSource(file, what);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${what}: the file is not valid JSON (${err.message})`);
  }
}
function need(value, name) {
  if (!value) throw new Error(`missing <${name}>

${USAGE}`);
  return value;
}
var enc = encodeURIComponent;
var print = (x) => {
  process.stdout.write(JSON.stringify(x, null, 2) + "\n");
};
var boardUrl = (id) => `${baseUrl()}/b/${encodeURIComponent(id)}?t=${getToken()}`;
function openBrowser(url) {
  if (process.env.PUNCH_LIST_NO_OPEN) return;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn2(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
  }
}
function snapshot(board, listening, pending) {
  return {
    id: board.id,
    title: board.title,
    url: boardUrl(board.id),
    done: board.done,
    listening,
    layout: board.layout.type,
    questions: board.questions.map((q) => {
      const s = board.qstate[q.id];
      return {
        id: q.id,
        title: q.title,
        type: q.type,
        status: questionStatus(board, q.id),
        ...board.drafts[q.id] ? { answer: board.drafts[q.id] } : {},
        sentToAgent: board.sent[q.id] !== void 0,
        changed: s.changed,
        explaining: s.explaining,
        ...s.pendingQuestion ? { pendingQuestion: s.pendingQuestion } : {},
        explanations: s.explanations.length,
        ...s.withdrawn ? { withdrawn: s.withdrawReason || true } : {}
      };
    }),
    pendingEvents: pending
  };
}
async function waitCmd(id, timeoutFlag) {
  const total = typeof timeoutFlag === "string" ? Number(timeoutFlag) : Infinity;
  if (Number.isNaN(total) || total < 0) throw new Error("--timeout must be a number of seconds");
  const deadline = Date.now() + total * 1e3;
  for (; ; ) {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1e3));
    const slice = Math.min(25, left);
    try {
      const { events } = await call("GET", `/api/boards/${encodeURIComponent(id)}/wait?timeout=${slice}`);
      if (events.length || Date.now() >= deadline) return print(events);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      await new Promise((r) => setTimeout(r, 500));
      await ensureServer(BIN).catch((e) => {
        if (e instanceof PortTakenError) throw e;
      });
      if (Date.now() >= deadline) return print([]);
    }
  }
}
async function hookStop() {
  let input = {};
  try {
    input = JSON.parse(readFileSync4(0, "utf8") || "{}");
  } catch {
    return;
  }
  if (!input.session_id || input.stop_hook_active) return;
  let boards;
  try {
    ({ boards } = await call("GET", `/api/listening?session=${encodeURIComponent(input.session_id)}`));
  } catch {
    boards = new BoardStore().list().filter((b) => !b.done && b.sessionId === input.session_id).map((b) => ({ id: b.id, title: b.title, resumePrompt: resumePrompt(b.id) }));
  }
  if (!boards.length) return;
  const list = boards.map((b) => `"${b.id}" (${b.title})`).join(", ");
  print({
    decision: "block",
    reason: `punch-list board ${list} is open and nobody is listening. Run \`node ${process.argv[1]} wait <board>\` in the background (run_in_background) before ending your turn. If the person no longer needs the board, run \`node ${process.argv[1]} close <board>\`.`
  });
}
async function main(argv) {
  const args = parse(argv);
  const [cmd, a1, a2] = args._;
  const f = args.flags;
  try {
    switch (cmd) {
      case "serve": {
        process.on("uncaughtException", (err) => console.error(`punch-list: uncaught error: ${err.stack ?? err}`));
        process.on("unhandledRejection", (err) => console.error(`punch-list: unhandled rejection: ${err}`));
        const { port } = await startServer();
        writeFileSync3(`${paths().home}/server.pid`, String(process.pid));
        console.log(`punch-list ${VERSION} listening on http://127.0.0.1:${port}`);
        return new Promise(() => {
        });
      }
      case "hook-stop":
        await hookStop();
        return 0;
      case "stop": {
        if (await health() === "ours") {
          const { pid } = await call("GET", "/api/health");
          try {
            process.kill(pid);
          } catch {
          }
        }
        rmSync3(`${paths().home}/server.pid`, { force: true });
        print({ stopped: true });
        return 0;
      }
      case void 0:
      case "help":
      case "--help":
        console.log(USAGE);
        return 0;
    }
    await ensureServer(BIN);
    switch (cmd) {
      case "open": {
        const id = need(a1, "board");
        const input = readJson(f.file, "open");
        await call("POST", "/api/boards", { id, input, replace: f.replace === true, projectDir: process.cwd(), sessionId: process.env.CLAUDE_CODE_SESSION_ID });
        const url = boardUrl(id);
        if (f["no-open"] !== true) openBrowser(url);
        const notice = takeRetentionNotice();
        print({
          url,
          ...notice ? { notice: `Tell the person: ${notice}` } : {},
          next: `Give the person the url, then run \`punch-list wait ${id}\` in the background and handle each batch of Events.`
        });
        return 0;
      }
      case "close":
        await call("POST", `/api/boards/${enc(need(a1, "board"))}/close`, {});
        print({ closed: a1 });
        return 0;
      case "push":
        await call("POST", `/api/boards/${enc(need(a1, "board"))}/push`, readJson(f.file, "push"));
        print({ ok: true });
        return 0;
      case "explain": {
        const html = typeof f.html === "string" ? f.html : readSource(f.file, "explain");
        await call("POST", `/api/boards/${enc(need(a1, "board"))}/explain`, { qid: need(a2, "question"), html });
        print({ ok: true });
        return 0;
      }
      case "withdraw":
        await call("POST", `/api/boards/${enc(need(a1, "board"))}/withdraw`, { qid: need(a2, "question"), reason: typeof f.reason === "string" ? f.reason : "" });
        print({ ok: true });
        return 0;
      case "wait":
        await waitCmd(need(a1, "board"), f.timeout);
        return 0;
      case "status": {
        const id = need(a1, "board");
        const r = await call("GET", `/api/boards/${enc(id)}`);
        print(snapshot(r.board, r.listening, r.pending));
        return 0;
      }
      case "url":
        print({ url: boardUrl(need(a1, "board")) });
        return 0;
      case "list": {
        const r = await call("GET", "/api/boards");
        print({ index: `${baseUrl()}/?t=${getToken()}`, boards: r.boards });
        return 0;
      }
      case "rm":
        await call("DELETE", `/api/boards/${enc(need(a1, "board"))}`);
        print({ removed: a1 });
        return 0;
      default:
        throw new Error(`unknown command "${cmd}"

${USAGE}`);
    }
  } catch (err) {
    process.stderr.write(`punch-list: ${err.message}
`);
    return err instanceof PortTakenError ? 2 : 1;
  }
}
main(process.argv.slice(2)).then((code) => process.exit(code));
export {
  main
};
