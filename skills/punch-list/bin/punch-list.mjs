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
var LAYOUT_TYPES = ["focus", "list", "tabs", "wizard", "columns", "custom"];
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
function isAnswered(a) {
  return hasValue(a) || !!a?.note?.trim();
}
function questionStatus(board, qid) {
  const s = board.qstate[qid];
  if (s?.withdrawn) return "withdrawn";
  if (isAnswered(board.drafts[qid])) return "answered";
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
      layout: input.layout ?? { type: "focus" },
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
    const answered = isAnswered(board.drafts[q.id]) || board.sent[q.id] !== void 0;
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
    if (isAnswered(board.drafts[qid])) s.skipped = false;
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
      const title = this.question(board, qid).title;
      if (!hasValue(d) && d.note?.trim()) return { qid, title, value: null, ownAnswer: d.note };
      return { qid, title, value: d.value, ...d.note ? { note: d.note } : {} };
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap">
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/assets/styles.css">
</head>
<body class="shell">
<a class="skip-link" href="#main">Skip to the questions</a>
<div class="sr" role="status" aria-atomic="true" id="live"></div>
<div class="app" id="app">
  <header class="titlebar">
    <button type="button" class="icon-btn" id="toggleSide" aria-controls="sidebar" aria-expanded="true" title="Toggle question list (\u2318B or L)">
      <svg class="g" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 2.5v11" stroke="currentColor" stroke-width="1.3"/></svg>
      <span class="sr">Toggle question list</span>
    </button>
    <nav class="crumbs" aria-label="Breadcrumb"><b>punch-list</b><span class="sep">/</span><span id="crumbBoard"></span><span class="sep" id="crumbSep">/</span><span class="cur" id="crumbQ"></span></nav>
  </header>

  <nav class="sidebar" id="sidebar" aria-label="Questions">
    <div class="side-head"><span>Questions</span></div>
    <div class="side-scroll" id="sideList"></div>
  </nav>

  <main class="main" id="main" tabindex="-1">
    <div class="main-in" id="mainIn">
      <div class="board-head"><h1 id="title">Loading\u2026</h1><div id="intro" class="intro rich"></div></div>
      <div id="banner-conn" class="banner warn" hidden>Lost connection to the punch-list server. Reconnecting\u2026</div>
      <div id="banner-listen" class="banner warn" hidden>
        <div><strong>Claude isn't listening.</strong> Your answers are saved. Paste this into your agent to pick the board back up:</div>
        <div class="copyrow"><code id="resume-prompt"></code><button type="button" class="btn small" id="copy-resume">Copy</button></div>
      </div>
      <div id="banner-done" class="banner ok" hidden>
        <span>Marked done. Claude has your answers.</span>
        <button type="button" class="btn small ghost" id="reopen">Reopen</button>
      </div>
      <div id="progress" class="progress"></div>
      <div id="board" class="board"></div>
    </div>
  </main>

  <aside class="inspector" id="inspector" aria-label="Explanation">
    <div class="resizer" id="inspResizer" role="separator" aria-orientation="vertical" aria-label="Resize the explanation panel" title="Drag to resize \xB7 double-click to reset" tabindex="0"></div>
    <div class="insp-head"><span>Explanation</span><span><kbd>?</kbd> ask</span></div>
    <div class="insp-body" id="inspBody"></div>
  </aside>

  <footer class="statusbar">
    <span class="live" id="listen"><i></i><span id="listenText">listening</span></span>
    <span class="counts" id="sbCounts"></span>
    <span class="spacer"></span>
    <span id="sbUnsent"></span>
    <span class="confirm" id="confirm-done" hidden>
      <span id="confirm-text"></span>
      <button type="button" class="sb-btn" id="keep">Keep answering</button>
      <button type="button" class="sb-btn primary" id="done-anyway">Mark done anyway</button>
    </span>
    <span id="actions" style="display:flex">
      <button type="button" class="sb-btn primary" id="send">Send to Claude <kbd>\u2318\u21B5</kbd></button>
      <button type="button" class="sb-btn" id="done">Done</button>
    </span>
  </footer>
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
var app_default = `// punch-list Board page. Renders the Board the server streams over SSE inside an
// editor-style frame (sidebar, main, explanation panel, status bar), keeps the person's
// typing local until it is saved, and talks back with small POSTs.

const token = new URLSearchParams(location.search).get('t') || '';
const boardId = decodeURIComponent(location.pathname.split('/')[2] || '');
const $ = (id) => document.getElementById(id);

let view = null;
/** Answers typed here but not yet confirmed saved by the server: qid -> {value, note}. */
const local = {};
const saveTimers = {};
const inflight = new Set();
const listeners = {};
const ui = loadUi();
ui.closed ||= [2, 3, 4];
ui.seen ||= {};

// ---------- status groups ----------

const GROUP_NAME = ['Needs you', 'Claude is explaining', 'Answered', 'Skipped', 'Withdrawn'];
const GROUP_CLASS = ['need', 'wait', 'ok', 'skip', 'skip'];
/** Status is shown by shape as well as colour: ! needs you, \u2026 explaining, \u2713 answered, dashed \u2013 skipped, slashed withdrawn. */
const GLYPH = [
  '<svg class="g need" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M8 4.5v4.2M8 11.2v.3" stroke="var(--bg)" stroke-width="1.8" stroke-linecap="round"/></svg>',
  '<svg class="g wait" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="5" cy="8" r="1.1" fill="currentColor"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/><circle cx="11" cy="8" r="1.1" fill="currentColor"/></svg>',
  '<svg class="g ok" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.8 8.3l2.1 2.1 4.3-4.6" fill="none" stroke="var(--bg)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  '<svg class="g skip" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.4 2"/><path d="M5.5 8h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  '<svg class="g skip" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4.5 11.5l7-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
];
const CHEV = '<svg class="g chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

function hasValue(a) {
  if (!a) return false;
  const v = a.value;
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}
const answerOf = (qid) => local[qid] ?? view?.drafts?.[qid];
/** A note typed with no option picked is the person's own answer. */
const isOwnAnswer = (a) => !hasValue(a) && !!a?.note?.trim();
const isAnswered = (a) => hasValue(a) || isOwnAnswer(a);
const qById = (qid) => view.questions.find((q) => q.id === qid);

function groupOf(q) {
  const s = q.state || {};
  if (s.withdrawn) return 4;
  if (s.explaining) return 1;
  if (s.changed) return 0;
  if (isAnswered(answerOf(q.id))) return 2;
  if (s.skipped) return 3;
  return 0;
}
const isUnsent = (qid) => view.unsent.includes(qid) || qid in local;
const isFresh = (q) => (q.state?.explanations?.length || 0) > (ui.seen[q.id] || 0);

function visible(q) {
  if (!q.showIf) return true;
  return Object.entries(q.showIf).every(([dep, want]) => {
    const got = answerOf(dep)?.value;
    const wants = Array.isArray(want) ? want.map(String) : [String(want)];
    if (Array.isArray(got)) return got.some((g) => wants.includes(String(g)));
    return got !== undefined && got !== null && wants.includes(String(got));
  });
}

/** Visible Questions, needs-you first, then explaining, answered, skipped, withdrawn; board order inside a group. */
function sortedIds() {
  return view.questions
    .map((q, i) => [q, i])
    .filter(([q]) => visible(q))
    .sort(([a, ai], [b, bi]) => groupOf(a) - groupOf(b) || ai - bi)
    .map(([q]) => q.id);
}

const stripTags = (s) => String(s).replace(/<[^>]+>/g, '');
function answerText(q) {
  const a = answerOf(q.id);
  if (isOwnAnswer(a)) return 'own answer';
  if (!hasValue(a)) return '';
  const v = a.value;
  if (q.type === 'yes-no') return v === 'yes' ? 'Yes' : v === 'no' ? 'No' : String(v);
  const label = (x) => {
    const o = (q.options || []).find((o) => o.value === x);
    return o ? stripTags(o.label) : String(x);
  };
  if (Array.isArray(v)) return v.map(label).join(', ');
  if (q.options) return label(v);
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

// ---------- helpers ----------

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false && kid !== '') n.append(kid);
  return n;
}

function loadUi() {
  try { return JSON.parse(localStorage.getItem(\`pl:\${boardId}:ui\`) || '{}'); } catch { return {}; }
}
function saveUi() {
  try { localStorage.setItem(\`pl:\${boardId}:ui\`, JSON.stringify(ui)); } catch {}
}

/** Inserts agent HTML and runs any scripts in it (innerHTML alone never runs them). */
function setRich(node, html) {
  node.innerHTML = html || '';
  for (const old of node.querySelectorAll('script')) {
    const s = document.createElement('script');
    for (const a of old.attributes) s.setAttribute(a.name, a.value);
    s.textContent = old.textContent;
    old.replaceWith(s);
  }
  queueMermaid();
}
const rich = (html, cls = 'rich') => { const n = el('div', { class: cls }); setRich(n, html); return n; };

let mermaidQueued = false;
let mermaidLib = null;
function queueMermaid() {
  if (mermaidQueued) return;
  mermaidQueued = true;
  requestAnimationFrame(async () => {
    mermaidQueued = false;
    const pending = document.querySelectorAll('.mermaid:not([data-processed])');
    if (!pending.length) return;
    try {
      if (!mermaidLib) {
        mermaidLib = (await import('https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs')).default;
        const dark = !matchMedia('(prefers-color-scheme: light)').matches;
        mermaidLib.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default' });
      }
      await mermaidLib.run({ nodes: [...pending] });
    } catch (err) {
      console.warn('punch-list: mermaid failed', err);
    }
  });
}

async function post(path, body = {}) {
  let res;
  try {
    res = await fetch(\`/b/\${encodeURIComponent(boardId)}/\${path}\`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sidekick-token': token },
      body: JSON.stringify(body),
      // Lets a draft save finish even when the page is being closed or reloaded.
      keepalive: true,
    });
  } catch (err) {
    toast("Can't reach the punch-list server. Your answers are kept here and saved when it's back.");
    throw err;
  }
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({}))).error || res.statusText;
    toast(\`Couldn't save: \${msg}\`);
    throw new Error(msg);
  }
  return res.json();
}

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}
function announce(text) {
  const l = $('live');
  l.textContent = '';
  setTimeout(() => (l.textContent = text), 30);
}

const isFocus = () => view?.layout.type === 'focus';
const wide = () => matchMedia('(min-width: 1400px)').matches;

// ---------- answers ----------

function setAnswer(qid, patch) {
  const cur = answerOf(qid) || { value: null };
  const next = { ...cur, ...patch };
  if (!next.note) delete next.note;
  local[qid] = next;
  clearTimeout(saveTimers[qid]);
  saveTimers[qid] = setTimeout(() => flushOne(qid), 400);
  refresh();
  emit('answer', { qid, answer: next });
}

async function flushOne(qid) {
  clearTimeout(saveTimers[qid]);
  delete saveTimers[qid];
  const answer = local[qid];
  if (!answer) return;
  const p = post('draft', { qid, answer }).then(() => {
    if (local[qid] === answer) delete local[qid];
  });
  inflight.add(p);
  try { await p; } finally { inflight.delete(p); }
}

/** Saves every answer that isn't on the server yet, including ones whose save failed earlier. */
async function flushAll() {
  await Promise.all([...inflight].map((p) => p.catch(() => {})));
  await Promise.all(Object.keys(local).map(flushOne));
}

// ---------- shared answer inputs ----------

function choicesFor(q) {
  if (q.type === 'yes-no') return [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];
  if (q.type === 'scale') {
    const min = q.min ?? 1, max = q.max ?? 5, step = q.step ?? 1;
    const out = [];
    for (let v = min; v <= max + 1e-9; v += step) out.push({ value: v, label: String(v) });
    return out;
  }
  return q.options || [];
}

/** Records a picked choice. Returns true for single-answer types, so the focus layout can move on. */
function pick(q, value) {
  if (q.type === 'multi') {
    const set = new Set(Array.isArray(answerOf(q.id)?.value) ? answerOf(q.id).value : []);
    set.has(value) ? set.delete(value) : set.add(value);
    setAnswer(q.id, { value: (q.options || []).map((o) => o.value).filter((v) => set.has(v)) });
    return false;
  }
  setAnswer(q.id, { value });
  return true;
}

function renderInput(q, box, opts = {}) {
  const { keys = false, onPicked } = opts;
  box.replaceChildren();
  if (q.state?.withdrawn) return;
  const cur = answerOf(q.id)?.value;
  switch (q.type) {
    case 'yes-no':
    case 'single':
    case 'multi':
    case 'scale': {
      const multi = q.type === 'multi';
      const chosen = new Set(multi ? (Array.isArray(cur) ? cur : []) : [cur]);
      const list = el('div', { class: \`choices\${q.type === 'scale' ? ' row' : ''}\`, role: 'group', 'aria-label': q.title });
      choicesFor(q).forEach((o, i) => {
        const on = chosen.has(o.value);
        const b = el('button', { type: 'button', class: \`choice\${on ? ' on' : ''}\`, 'aria-pressed': String(on) });
        if (keys && i < 9) b.append(el('span', { class: 'key', text: String(i + 1) }));
        else b.style.gridTemplateColumns = '1fr';
        const body = el('span', { class: 'rich' });
        const label = el('b');
        setRich(label, o.label);
        body.append(label);
        if (o.recommended) body.append(el('span', { class: 'rec', text: 'recommended' }));
        if (o.detail) { const d = el('small'); setRich(d, o.detail); body.append(d); }
        b.append(body);
        b.addEventListener('click', () => {
          const single = pick(q, o.value);
          if (multi) {
            b.classList.toggle('on');
            b.setAttribute('aria-pressed', String(b.classList.contains('on')));
          } else {
            for (const x of list.children) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); }
          }
          if (single) onPicked?.();
        });
        list.append(b);
      });
      box.append(list);
      break;
    }
    case 'text': {
      const ta = el('textarea', { placeholder: 'Type your answer', 'aria-label': q.title, 'data-edit': 'answer' });
      ta.value = typeof cur === 'string' ? cur : '';
      ta.addEventListener('input', () => setAnswer(q.id, { value: ta.value }));
      box.append(ta);
      break;
    }
    case 'number': {
      const inp = el('input', { type: 'number', min: q.min, max: q.max, step: q.step, 'aria-label': q.title, 'data-edit': 'answer' });
      inp.value = cur ?? '';
      inp.addEventListener('input', () => setAnswer(q.id, { value: inp.value === '' ? null : Number(inp.value) }));
      box.append(inp);
      break;
    }
    case 'rank':
      box.append(rankList(q, cur, box, opts));
      break;
    case 'custom':
      if (hasValue(answerOf(q.id))) box.append(el('div', { class: 'muted', text: \`Recorded: \${JSON.stringify(cur)}\` }));
      break;
  }
}

function rankList(q, cur, box, opts) {
  const all = (q.options || []).map((o) => o.value);
  const order = Array.isArray(cur) ? [...cur.filter((v) => all.includes(v)), ...all.filter((v) => !cur.includes(v))] : all;
  const labelOf = (v) => stripTags(q.options.find((o) => o.value === v)?.label ?? v);
  const move = (i, d) => {
    const next = [...order];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setAnswer(q.id, { value: next });
    renderInput(q, box, opts);
  };
  const list = el('ol', { class: 'rank' },
    order.map((v, i) => el('li', {},
      el('span', { text: labelOf(v) }),
      el('button', { type: 'button', class: 'btn small ghost', text: '\u2191', 'aria-label': \`Move \${labelOf(v)} up\`, disabled: i === 0, onclick: () => move(i, -1) }),
      el('button', { type: 'button', class: 'btn small ghost', text: '\u2193', 'aria-label': \`Move \${labelOf(v)} down\`, disabled: i === order.length - 1, onclick: () => move(i, 1) }),
    )),
  );
  const wrap = el('div', { class: 'section' }, list);
  if (!Array.isArray(cur)) wrap.append(el('button', { type: 'button', class: 'btn small ghost', text: 'This order is fine', onclick: () => { setAnswer(q.id, { value: order }); renderInput(q, box, opts); } }));
  return wrap;
}

function noteField(q, { hint } = {}) {
  const id = \`note-\${q.id}\`;
  const ta = el('textarea', { id, class: 'note', placeholder: 'Optional', 'data-edit': 'note' });
  ta.value = answerOf(q.id)?.note || '';
  ta.addEventListener('input', () => setAnswer(q.id, { note: ta.value }));
  const label = el('label', { for: id, html: \`Note for Claude <span style="color:var(--faint)">\xB7\${hint ? ' <kbd>e</kbd> to type,' : ''} <kbd>\u21E7\u21B5</kbd> new line, <kbd>\u21B5</kbd> next</span>\` });
  return el('div', { class: 'field' }, label, ta);
}

function threadNode(q) {
  const th = el('div', { class: 'thread' });
  for (const x of q.state?.explanations || []) {
    const item = el('div', { class: 'expl' });
    if (x.question) item.append(el('div', { class: 'asked', text: \`you asked: \${x.question}\` }));
    item.append(rich(x.html));
    th.append(item);
  }
  if (q.state?.explaining) th.append(el('div', { class: 'typing', text: \`Claude is explaining\${q.state.pendingQuestion ? \` \u201C\${q.state.pendingQuestion}\u201D\` : ''}\` }));
  return th;
}

function askBox(q, { onAsked } = {}) {
  const box = el('div', { class: 'ask', 'data-role': 'ask', hidden: true });
  const ta = el('textarea', { placeholder: "What's unclear? Ask your own question, or leave empty for a simpler explanation.", 'aria-label': 'Your question to Claude' });
  const submit = async () => {
    await post('explain', { qid: q.id, text: ta.value });
    box.hidden = true;
    ta.value = '';
    ta.blur();
    toast(isFocus() ? 'Claude is on it. Moving to the next question meanwhile.' : 'Claude is on it.');
    onAsked?.();
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.stopPropagation(); submit(); }
  });
  box.append(ta, el('div', { class: 'actions' },
    el('button', { type: 'button', class: 'btn', html: 'Ask Claude <kbd>\u21B5</kbd>', onclick: submit }),
    el('button', { type: 'button', class: 'btn ghost', html: 'Cancel <kbd>Esc</kbd>', onclick: () => (box.hidden = true) }),
  ));
  return box;
}

function changedNotice(q, after) {
  const box = el('div', { class: 'notice attn' });
  const said = answerText(q);
  box.append(el('span', { text: \`Claude changed this question after you answered\${said ? \` (you said \${said})\` : ''}. Check your answer.\` }));
  box.append(el('button', { type: 'button', class: 'btn small ghost', text: 'My answer still stands', onclick: async () => { await post('confirm', { qid: q.id }); after?.(); } }));
  return box;
}

// ---------- chrome: sidebar, progress, status bar ----------

function renderSidebar() {
  const list = $('sideList');
  const scroll = list.scrollTop;
  list.replaceChildren();
  const ids = sortedIds();
  const current = isFocus() ? focus.current : null;
  for (let g = 0; g < 5; g++) {
    const inGroup = ids.filter((id) => groupOf(qById(id)) === g);
    if (!inGroup.length) continue;
    const closed = ui.closed.includes(g) && !inGroup.includes(current);
    const sec = el('section', { class: \`sec\${closed ? ' closed' : ''}\` });
    sec.append(el('button', {
      type: 'button', class: 'sec-head', 'aria-expanded': String(!closed),
      html: \`\${CHEV}\${GLYPH[g]}<span>\${GROUP_NAME[g]}</span><span class="n">\${inGroup.length}</span>\`,
      onclick: () => { ui.closed = ui.closed.includes(g) ? ui.closed.filter((x) => x !== g) : [...ui.closed, g]; saveUi(); renderSidebar(); },
    }));
    const items = el('div', { class: 'items' });
    for (const id of inGroup) {
      const q = qById(id);
      const cls = ['item', id === current && 'current', isFresh(q) && 'fresh', isUnsent(id) && g !== 4 && 'unsent', g === 4 && 'withdrawn'].filter(Boolean).join(' ');
      const b = el('button', { type: 'button', class: cls, title: q.title, html: \`\${GLYPH[g]}<span class="t"></span><span class="a"></span>\` });
      b.querySelector('.t').textContent = q.title;
      b.querySelector('.a').textContent = answerText(q);
      b.setAttribute('aria-label', \`\${q.title}, \${GROUP_NAME[g].toLowerCase()}\${answerText(q) ? \`, answer \${answerText(q)}\` : ''}\`);
      if (id === current) b.setAttribute('aria-current', 'true');
      b.addEventListener('click', () => reveal(id));
      items.append(b);
    }
    sec.append(items);
    list.append(sec);
  }
  list.scrollTop = scroll;
}

function renderProgress() {
  const shown = view.questions.filter((q) => visible(q) && groupOf(q) !== 4);
  const counts = [0, 0, 0, 0];
  for (const q of shown) counts[groupOf(q)]++;
  const segs = el('div', { class: 'segments' });
  const labels = el('div', { class: 'labels' });
  const jump = (g) => { const id = sortedIds().find((x) => groupOf(qById(x)) === g); if (id) reveal(id); };
  counts.forEach((n, g) => {
    if (n) {
      const s = el('button', { type: 'button', class: \`segment \${GROUP_CLASS[g]}\`, title: \`\${GROUP_NAME[g]}: \${n}\`, 'aria-label': \`\${GROUP_NAME[g]}: \${n}\`, onclick: () => jump(g) });
      s.style.flexGrow = n;
      segs.append(s);
    }
    labels.append(el('button', { type: 'button', html: \`\${GLYPH[g]}<b>\${n}</b> \${GROUP_NAME[g].toLowerCase()}\`, onclick: () => jump(g) }));
  });
  $('progress').replaceChildren(segs, labels);
  $('sbCounts').innerHTML = counts.map((n, g) => \`<span title="\${GROUP_NAME[g]}">\${GLYPH[g]}\${n}</span>\`).join('');
  const unsent = shown.filter((q) => isUnsent(q.id)).length;
  $('sbUnsent').textContent = unsent ? \`\${unsent} unsent\` : focus.lastSentAt ? \`sent \${clock(focus.lastSentAt)}\` : 'all sent';
  $('send').disabled = unsent === 0;
  $('done').textContent = view.done ? 'Done \u2713' : 'Done';
  $('done').disabled = view.done;
}

function renderChrome() {
  document.title = \`\${view.title} \xB7 punch-list\`;
  $('title').textContent = view.title;
  $('crumbBoard').textContent = view.id;
  const cq = isFocus() && focus.current ? qById(focus.current) : null;
  $('crumbQ').textContent = cq ? cq.title : '';
  $('crumbSep').hidden = !cq;
  if ($('intro').dataset.html !== (view.intro || '')) {
    $('intro').dataset.html = view.intro || '';
    setRich($('intro'), view.intro);
  }
  $('banner-listen').hidden = view.listening || view.done;
  $('resume-prompt').textContent = view.resumePrompt;
  $('banner-done').hidden = !view.done;
  $('listen').classList.toggle('off', !view.listening);
  $('listenText').textContent = view.listening ? 'listening' : 'not listening';
  $('app').classList.toggle('no-insp', !isFocus());
  $('mainIn').classList.toggle('wide', view.layout.type === 'columns' || view.layout.type === 'custom');
  renderSidebar();
  renderProgress();
}

/** Cheap update after a local change (an answer, a note): status, counts, sidebar. */
function refresh() {
  if (!view) return;
  renderChrome();
  if (isFocus()) renderFocusSoft();
  else refreshCards();
}

// ---------- focus layout ----------

const focus = { current: null, lastDir: 1, hardKey: null, pendingAdvance: null, deferred: false };

function firstNeeding(after) {
  const ids = sortedIds();
  const start = after == null || !ids.includes(after) ? 0 : ids.indexOf(after) + 1;
  return [...ids.slice(start), ...ids.slice(0, start)].find((id) => groupOf(qById(id)) === 0) || null;
}

function goTo(id, dir) {
  const ids = sortedIds();
  focus.lastDir = dir ?? (ids.indexOf(id) >= ids.indexOf(focus.current) ? 1 : -1);
  focus.current = id;
  focus.hardKey = null;
  renderFocus();
  renderChrome();
  $('main').scrollTo({ top: 0 });
  const q = id && qById(id);
  if (q) announce(\`\${q.title}. \${GROUP_NAME[groupOf(q)]}. Question \${ids.indexOf(id) + 1} of \${ids.length}.\`);
  else announce('Nothing needs you right now.');
}

function nextNeeding() {
  clearTimeout(focus.pendingAdvance);
  const next = firstNeeding(focus.current);
  if (!next && !focus.current) return;
  goTo(next && next !== focus.current ? next : null, 1);
}

/** Changes that need the question card rebuilt; answers typed here never do. */
function focusHardKey(q) {
  const { state, status, ...def } = q;
  return JSON.stringify([q.id, def, state?.changed, state?.withdrawn, state?.explanations?.length, state?.explaining, state?.pendingQuestion, wide()]);
}

function renderFocus() {
  const board = $('board');
  if (focus.current && (!view.questions.some((q) => q.id === focus.current) || !visible(qById(focus.current)))) focus.current = firstNeeding(null);
  const q = focus.current && qById(focus.current);
  const key = q ? focusHardKey(q) : \`done:\${view.done}:\${unsentCount()}:\${focus.lastSentAt}:\${JSON.stringify(view.questions.map((x) => [x.id, groupOf(x)]))}\`;
  if (key === focus.hardKey) return renderFocusSoft();
  // Never rebuild under the person's cursor; catch up when they leave the field.
  const typing = document.activeElement?.matches?.('textarea, input') && ($('board').contains(document.activeElement) || $('inspBody').contains(document.activeElement));
  if (typing && q && focus.hardKey && focus.hardKey.startsWith(\`["\${q.id}"\`)) {
    focus.deferred = true;
    return renderFocusSoft();
  }
  focus.deferred = false;
  focus.hardKey = key;
  board.replaceChildren();
  if (!q) {
    board.append(doneCard());
  } else {
    if (isFresh(q)) { ui.seen[q.id] = q.state.explanations.length; saveUi(); }
    board.append(el('div', { 'data-slot': 'prev' }), focusCard(q), el('div', { 'data-slot': 'next' }));
  }
  board.append(el('div', { class: 'hint', html: '<span><kbd>1</kbd>\u2013<kbd>9</kbd> pick</span><span><kbd>e</kbd> edit text</span><span><kbd>\u21B5</kbd> next that needs me</span><span><kbd>\u2191</kbd><kbd>\u2193</kbd> move</span><span><kbd>s</kbd> skip</span><span><kbd>?</kbd> wait, what?</span><span><kbd>\u2318B</kbd> list</span><span><kbd>\u2318\u21B5</kbd> send to Claude</span>' }));
  renderFocusSoft();
  renderInspector();
}
document.addEventListener('focusout', () => setTimeout(() => { if (focus.deferred && isFocus()) renderFocus(); }, 0));

/** Updates what can change while the person is typing: status line, colour, neighbours. */
function renderFocusSoft() {
  const q = focus.current && qById(focus.current);
  const card = $('board').querySelector('.f-card[data-qid]');
  if (!q || !card) return;
  const g = groupOf(q);
  card.classList.remove('need-c', 'wait-c', 'ok-c', 'skip-c');
  card.classList.add(\`\${GROUP_CLASS[g]}-c\`);
  const ids = sortedIds();
  const inGroup = ids.filter((id) => groupOf(qById(id)) === g);
  card.querySelector('[data-slot=status]').innerHTML = \`\${GLYPH[g]}\${GROUP_NAME[g]} \xB7 \${inGroup.indexOf(q.id) + 1} of \${inGroup.length}\`;
  card.querySelector('[data-slot=pos]').textContent = \`\${ids.indexOf(q.id) + 1} / \${ids.length}\`;
  const skip = card.querySelector('[data-act=skip]');
  if (skip) skip.innerHTML = q.state?.skipped ? 'Unskip <kbd>s</kbd>' : 'Skip for now <kbd>s</kbd>';
  const i = ids.indexOf(q.id);
  $('board').querySelector('[data-slot=prev]')?.replaceChildren(peek(ids[i - 1], '\u2191 prev'));
  $('board').querySelector('[data-slot=next]')?.replaceChildren(peek(ids[i + 1], '\u2193 next'));
}

function peek(id, where) {
  if (!id) return el('div', { class: 'peek empty', 'aria-hidden': 'true' });
  const q = qById(id);
  const g = groupOf(q);
  const b = el('button', { type: 'button', class: 'peek', html: \`\${GLYPH[g]}<span class="t"></span><span class="chip \${GROUP_CLASS[g]}"></span><span class="where">\${where}</span>\` });
  b.querySelector('.t').textContent = q.title;
  b.querySelector('.chip').textContent = g === 2 ? answerText(q) : GROUP_NAME[g].toLowerCase();
  b.setAttribute('aria-label', \`\${where.replace(/[\u2191\u2193]\\s*/, '')}: \${q.title}, \${GROUP_NAME[g].toLowerCase()}\`);
  b.addEventListener('click', () => goTo(id, where.includes('\u2191') ? -1 : 1));
  return b;
}

function focusCard(q) {
  const card = el('section', { class: 'f-card enter', 'data-qid': q.id, 'aria-labelledby': 'qtitle' });
  card.style.setProperty('--from', \`\${focus.lastDir * 10}px\`);
  card.append(el('div', { class: 'f-top' }, el('span', { 'data-slot': 'status' }), el('span', { 'data-slot': 'pos' })));
  card.append(el('h2', { id: 'qtitle', text: q.title }));
  if (q.state?.withdrawn) card.append(el('div', { class: 'notice muted-box', text: \`Withdrawn\${q.state.withdrawReason ? \`: \${q.state.withdrawReason}\` : ''}\` }));
  else if (q.state?.changed) card.append(changedNotice(q, nextNeeding));
  if (q.body) card.append(rich(q.body, 'rich body'));
  if (q.state?.withdrawn) return card;

  const input = el('div');
  renderInput(q, input, {
    keys: true,
    onPicked: () => { clearTimeout(focus.pendingAdvance); focus.pendingAdvance = setTimeout(nextNeeding, 380); },
  });
  const editable = q.type === 'text' || q.type === 'number';
  if (editable) card.append(el('div', { class: 'field' }, el('label', { html: 'Your answer <span style="color:var(--faint)">\xB7 <kbd>e</kbd> to type, <kbd>\u21E7\u21B5</kbd> new line, <kbd>\u21B5</kbd> next, <kbd>Esc</kbd> to leave</span>' }), input));
  else card.append(input);
  if (!editable && q.type !== 'custom') card.append(noteField(q, { hint: true }));
  if (!wide()) {
    if (q.state?.explanations?.length || q.state?.explaining) card.append(threadNode(q));
    card.append(askBox(q, { onAsked: () => setTimeout(nextNeeding, 300) }));
  }
  card.append(el('div', { class: 'actions' },
    el('button', { type: 'button', class: 'btn ghost', 'data-act': 'what', html: 'Wait, what? <kbd>?</kbd>', onclick: openAsk }),
    el('button', { type: 'button', class: 'btn link', 'data-act': 'skip', onclick: skipCurrent }),
    el('span', { class: 'spacer' }),
    el('button', { type: 'button', class: 'btn', html: 'Next that needs me <kbd>\u21B5</kbd>', onclick: nextNeeding }),
  ));
  return card;
}

const unsentCount = () => view.questions.filter((q) => visible(q) && groupOf(q) !== 4 && isUnsent(q.id)).length;
const clock = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** What Enter does when nothing needs the person: send unsent answers, else mark the board done. */
function primaryAction() {
  if (unsentCount() > 0) return sendAll();
  if (!view.done) return $('done').click();
}

function doneCard() {
  const shown = view.questions.filter(visible);
  const skipped = shown.filter((q) => groupOf(q) === 3);
  const explaining = shown.filter((q) => groupOf(q) === 1);
  const unsent = unsentCount();
  const card = el('section', { class: 'f-card done-card enter ok-c' });
  card.innerHTML = '<svg class="big" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.8 8.3l2.1 2.1 4.3-4.6" fill="none" stroke="var(--bg)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const actions = el('div', { class: 'actions' });
  if (view.done) {
    card.append(el('h2', { text: 'Board marked done' }), el('p', { class: 'muted', style: 'margin:0', text: 'Claude has everything and is working on it. You can close this tab; reopen the board if you want to change something.' }));
    actions.append(el('button', { type: 'button', class: 'btn ghost', text: 'Reopen', onclick: () => post('reopen') }));
  } else if (unsent > 0) {
    card.append(el('h2', { text: skipped.length || explaining.length ? 'Nothing needs you right now' : 'Everything is answered' }), el('p', { class: 'muted', style: 'margin:0', text: \`\${unsent} answer\${unsent === 1 ? " hasn't" : "s haven't"} been sent to Claude yet.\` }));
    actions.append(
      el('button', { type: 'button', class: 'btn', 'data-primary': '', html: 'Send to Claude <kbd>\u21B5</kbd>', onclick: sendAll }),
      el('button', { type: 'button', class: 'btn ghost', text: 'Done', onclick: () => $('done').click() }),
    );
  } else {
    const at = focus.lastSentAt ? \` at \${clock(focus.lastSentAt)}\` : '';
    card.append(el('h2', { text: \`Sent to Claude\${at}\` }), el('p', { class: 'muted', style: 'margin:0', text: "Claude has your answers. Mark the board done when you're finished, or keep editing: changes show up here as unsent." }));
    const firstAnswered = sortedIds().find((id) => groupOf(qById(id)) === 2);
    actions.append(
      el('button', { type: 'button', class: 'btn', 'data-primary': '', html: 'Mark board done <kbd>\u21B5</kbd>', onclick: () => $('done').click() }),
      firstAnswered ? el('button', { type: 'button', class: 'btn ghost', text: 'Review answers', onclick: () => goTo(firstAnswered, -1) }) : null,
    );
  }
  if (explaining.length) card.append(el('p', { class: 'muted', style: 'margin:0', text: \`Claude is still explaining \${explaining.length} question\${explaining.length > 1 ? 's' : ''}; it comes back to the top when the answer lands.\` }));
  if (skipped.length) {
    const later = el('div', { class: 'later' }, el('div', { class: 'f-top' }, el('span', { text: 'You skipped' })));
    for (const q of skipped) later.append(peek(q.id, 'go back'));
    card.append(later);
  }
  card.append(actions);
  return card;
}

function renderInspector() {
  const body = $('inspBody');
  body.replaceChildren();
  if (!isFocus() || !wide()) return;
  const q = focus.current && qById(focus.current);
  if (!q) return body.append(el('div', { class: 'empty-state', text: 'Explanations for the current question show up here.' }));
  body.append(el('div', { class: 'insp-q' }, el('b', { text: q.title })));
  if (q.state?.explanations?.length || q.state?.explaining) body.append(threadNode(q));
  else body.append(el('div', { class: 'empty-state', html: 'Not sure what this question means? Press <kbd>?</kbd> and ask. Claude answers here while you carry on with the next question.' }));
  if (!q.state?.withdrawn) body.append(askBox(q, { onAsked: () => setTimeout(nextNeeding, 300) }));
}

function openAsk() {
  const scope = isFocus() && wide() ? $('inspBody') : $('board');
  const box = scope.querySelector('[data-role=ask]');
  if (!box) return;
  box.hidden = false;
  box.querySelector('textarea').focus();
}

async function skipCurrent() {
  const q = focus.current && qById(focus.current);
  if (!q) return;
  const skipping = !q.state?.skipped;
  await post('skip', { qid: q.id, skipped: skipping });
  if (skipping) nextNeeding();
}

// ---------- card layouts (list, tabs, wizard, columns, custom) ----------

const cards = new Map();
let layoutKey = null;
let modal = null;

function defKey(q) {
  const { state, status, ...def } = q;
  return JSON.stringify([def, state?.changed, state?.withdrawn, state?.withdrawReason]);
}
const threadKey = (q) => JSON.stringify([q.state?.explanations, q.state?.explaining, q.state?.pendingQuestion]);

function makeCard(q) {
  const parts = {
    head: el('div', { class: 'card-head' }),
    body: el('div', { class: 'rich' }),
    notice: el('div'),
    input: el('div'),
    note: el('div'),
    thread: el('div'),
    ask: el('div'),
    actions: el('div', { class: 'card-actions' }),
  };
  const node = el('section', { class: 'card', 'data-qid': q.id }, Object.values(parts));
  const card = { el: node, parts, keys: {} };
  cards.set(q.id, card);
  return card;
}

function updateCard(q) {
  const card = cards.get(q.id) || makeCard(q);
  const { parts, keys } = card;
  const dk = defKey(q);
  const focusedInside = card.el.contains(document.activeElement) && document.activeElement !== document.body;
  if (keys.def !== dk) {
    keys.def = dk;
    renderHead(q, parts.head);
    setRich(parts.body, q.body);
    parts.body.hidden = !q.body;
    parts.notice.replaceChildren();
    if (q.state?.withdrawn) parts.notice.append(el('div', { class: 'notice muted-box', text: \`Withdrawn\${q.state.withdrawReason ? \`: \${q.state.withdrawReason}\` : ''}\` }));
    else if (q.state?.changed) parts.notice.append(changedNotice(q));
    renderInput(q, parts.input);
    parts.note.replaceChildren();
    if (!q.state?.withdrawn && q.type !== 'custom') parts.note.append(noteField(q));
    renderActions(q, parts.actions, parts.ask);
    keys.draft = JSON.stringify(view.drafts[q.id]);
  } else {
    const dkey = JSON.stringify(view.drafts[q.id]);
    if (keys.draft !== dkey && !(q.id in local) && !focusedInside) {
      renderInput(q, parts.input);
      parts.note.replaceChildren();
      if (!q.state?.withdrawn && q.type !== 'custom') parts.note.append(noteField(q));
    }
    keys.draft = dkey;
  }
  const tk = threadKey(q);
  if (keys.thread !== tk) {
    keys.thread = tk;
    parts.thread.replaceChildren(threadNode(q));
  }
  refreshCardStatus(q, card);
  return card;
}

function statusChip(q) {
  const g = groupOf(q);
  return el('span', { class: \`chip \${GROUP_CLASS[g]}\`, 'data-chip': 'status', text: q.state?.changed ? 'changed' : GROUP_NAME[g].toLowerCase() });
}

function refreshCardStatus(q, card) {
  const g = groupOf(q);
  card.el.classList.toggle('is-answered', g === 2);
  card.el.classList.toggle('is-withdrawn', g === 4);
  card.el.classList.toggle('is-changed', !!q.state?.changed);
  card.el.classList.toggle('is-explaining', g === 1);
  const meta = card.parts.head.querySelector('.card-meta');
  if (meta) {
    meta.querySelector('[data-chip=status]').replaceWith(statusChip(q));
    meta.querySelector('[data-chip=unsent]').hidden = !isUnsent(q.id) || g === 4;
  }
  const skip = card.parts.actions.querySelector('[data-act=skip]');
  if (skip) {
    skip.textContent = q.state?.skipped ? 'Unskip' : 'Skip for now';
    skip.hidden = g === 2 || g === 4;
  }
  card.el.hidden = !visible(q);
}

function renderHead(q, head) {
  head.replaceChildren(
    el('h3', { class: 'card-title', text: q.title }),
    el('div', { class: 'card-meta' },
      el('span', { 'data-chip': 'status' }),
      el('span', { class: 'chip accent', 'data-chip': 'unsent', text: 'unsent', title: 'Not sent to Claude yet' }),
      view.layout.type === 'columns' ? null : el('button', { type: 'button', class: 'btn small link', text: 'Expand', onclick: () => openModal(q.id) }),
    ),
  );
}

function renderActions(q, actions, ask) {
  actions.replaceChildren();
  ask.replaceChildren();
  if (q.state?.withdrawn) return;
  const box = askBox(q);
  ask.append(box);
  actions.append(
    el('button', { type: 'button', class: 'btn small ghost', text: 'Wait, what? Explain better', onclick: () => { box.hidden = false; box.querySelector('textarea').focus(); } }),
    el('button', { type: 'button', class: 'btn small link', 'data-act': 'skip', onclick: () => post('skip', { qid: q.id, skipped: !qById(q.id).state?.skipped }) }),
  );
}

function groupsOf() {
  const qs = view.questions;
  const defined = view.layout.groups || [];
  if (!defined.length) return null;
  const ids = new Set(defined.map((g) => g.id));
  const groups = defined.map((g) => ({ ...g, qs: qs.filter((q) => q.group === g.id) }));
  const rest = qs.filter((q) => !ids.has(q.group));
  if (rest.length) groups.push({ id: '_other', title: 'Other', qs: rest });
  return groups.filter((g) => g.qs.length);
}

function pages() {
  const groups = groupsOf();
  if (groups) return groups;
  return view.questions.map((q, i) => ({ id: q.id, title: \`\${i + 1}. \${q.title.length > 28 ? q.title.slice(0, 27) + '\u2026' : q.title}\`, qs: [q] }));
}

function buildLayout() {
  closeModal();
  const root = $('board');
  root.replaceChildren();
  const type = view.layout.type;
  for (const q of view.questions) updateCard(q);
  if (type === 'tabs') buildTabs(root);
  else if (type === 'wizard') buildWizard(root);
  else if (type === 'columns') buildColumns(root);
  else if (type === 'custom') buildCustom(root);
  else buildList(root);
}

function buildList(root) {
  const groups = groupsOf();
  if (!groups) return root.append(...view.questions.map((q) => cards.get(q.id).el));
  for (const g of groups) root.append(el('div', { class: 'section' }, el('h2', { text: g.title }), g.qs.map((q) => cards.get(q.id).el)));
}

function buildTabs(root) {
  const ps = pages();
  if (!ps.length) return;
  if (!ps.some((p) => p.id === ui.tab)) ui.tab = ps[0].id;
  const bar = el('div', { class: 'tabs', role: 'tablist' });
  const panel = el('div', { class: 'section' });
  const show = (id) => {
    ui.tab = id;
    saveUi();
    for (const b of bar.children) b.setAttribute('aria-selected', String(b.dataset.id === id));
    panel.replaceChildren(...ps.find((p) => p.id === id).qs.map((q) => cards.get(q.id).el));
    queueMermaid();
  };
  for (const p of ps) bar.append(el('button', { type: 'button', class: 'tab', role: 'tab', 'data-id': p.id, onclick: () => show(p.id) }, el('span', { text: p.title }), el('span', { class: 'count', 'data-count': p.id })));
  root.append(bar, panel);
  show(ui.tab);
}

function buildWizard(root) {
  const ps = pages();
  if (!ps.length) return;
  ui.step = Math.min(Math.max(0, ui.step || 0), ps.length - 1);
  const bar = el('div', { class: 'wizard-bar' }, el('div'));
  const label = el('span', { class: 'muted' });
  const panel = el('div', { class: 'section' });
  const back = el('button', { type: 'button', class: 'btn ghost', text: 'Back' });
  const next = el('button', { type: 'button', class: 'btn', text: 'Next' });
  const show = (i) => {
    ui.step = i;
    saveUi();
    const p = ps[i];
    label.textContent = \`Step \${i + 1} of \${ps.length}\${view.layout.groups?.length ? \` \xB7 \${p.title}\` : ''}\`;
    bar.firstChild.style.width = \`\${((i + 1) / ps.length) * 100}%\`;
    panel.replaceChildren(...p.qs.map((q) => cards.get(q.id).el));
    back.disabled = i === 0;
    next.disabled = i === ps.length - 1;
    next.textContent = i === ps.length - 1 ? 'Last step' : 'Next';
    $('main').scrollTo({ top: 0, behavior: 'smooth' });
    queueMermaid();
  };
  back.onclick = () => show(ui.step - 1);
  next.onclick = () => show(ui.step + 1);
  root.append(bar, el('div', { class: 'wizard-nav' }, label), panel, el('div', { class: 'wizard-nav' }, back, next));
  show(ui.step);
}

function buildColumns(root) {
  root.append(el('div', { class: 'columns', id: 'columns' }));
  fillColumns();
}

function fillColumns() {
  const wrap = $('columns');
  if (!wrap) return;
  const byStatus = view.layout.columnsBy === 'status' || !view.layout.groups?.length;
  const cols = byStatus
    ? [0, 1, 2, 3, 4].map((g) => ({ id: g, title: GROUP_NAME[g], qs: view.questions.filter((q) => groupOf(q) === g) }))
    : groupsOf();
  wrap.replaceChildren(...cols.filter((c) => c.qs.length || c.id === 0).map((c) => {
    const shown = c.qs.filter(visible);
    return el('div', { class: 'column' },
      el('h2', {}, el('span', { text: c.title }), el('span', { text: String(shown.length) })),
      shown.map((q) => el('button', { type: 'button', class: 'mini', onclick: () => openModal(q.id) },
        el('span', { class: 'mini-title', text: q.title }),
        el('span', { class: 'card-meta' }, statusChip(q), isUnsent(q.id) ? el('span', { class: 'chip accent', text: 'unsent' }) : null),
      )),
    );
  }));
}

function buildCustom(root) {
  setRich(root, view.layout.html);
  const placed = new Set();
  for (const slot of root.querySelectorAll('[data-pl-question]')) {
    const card = cards.get(slot.getAttribute('data-pl-question'));
    if (card) {
      slot.replaceChildren(card.el);
      placed.add(slot.getAttribute('data-pl-question'));
    }
  }
  const rest = view.questions.filter((q) => !placed.has(q.id));
  if (rest.length) root.append(el('div', { class: 'section' }, el('h2', { text: 'More questions' }), rest.map((q) => cards.get(q.id).el)));
  if (view.layout.script) {
    try { new Function('punchList', view.layout.script)(api); } catch (err) { console.error('punch-list: layout script failed', err); toast('The custom layout script failed; see the console.'); }
  }
}

function refreshCards() {
  for (const q of view.questions) {
    const card = cards.get(q.id);
    if (card) refreshCardStatus(q, card);
  }
  for (const badge of document.querySelectorAll('[data-count]')) {
    const p = pages().find((x) => x.id === badge.dataset.count);
    const open = p ? p.qs.filter((q) => visible(q) && [0, 3].includes(groupOf(q))).length : 0;
    badge.textContent = open ? String(open) : '\u2713';
  }
  if (view.layout.type === 'columns' && !modal) fillColumns();
}

function openModal(qid) {
  closeModal();
  const card = cards.get(qid);
  if (!card) return;
  modal = { qid, parent: card.el.parentNode, next: card.el.nextSibling };
  $('modal-body').replaceChildren(card.el);
  card.el.hidden = false;
  $('modal').hidden = false;
  queueMermaid();
}

function closeModal() {
  if (!modal) return;
  const card = cards.get(modal.qid);
  if (card && modal.parent) modal.parent.insertBefore(card.el, modal.next);
  else card?.el.remove();
  modal = null;
  $('modal').hidden = true;
  if (view?.layout.type === 'columns') fillColumns();
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });

/** Shows a Question wherever the current layout keeps it. */
function reveal(qid) {
  $('app').classList.remove('mobile-open');
  if (isFocus()) return goTo(qid);
  const type = view.layout.type;
  if (type === 'columns') return openModal(qid);
  if (type === 'tabs' || type === 'wizard') {
    const ps = pages();
    const i = ps.findIndex((p) => p.qs.some((q) => q.id === qid));
    if (i === -1) return;
    if (type === 'tabs') ui.tab = ps[i].id; else ui.step = i;
    saveUi();
    buildLayout();
  }
  const node = cards.get(qid)?.el;
  if (node) {
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1200);
  }
}

/** Card layouts: Enter in a text box moves on to the next visible question card. */
function nextCardAfter(node) {
  const cardsInView = [...$('board').querySelectorAll('.card[data-qid]')].filter((c) => !c.hidden);
  const next = cardsInView[cardsInView.indexOf(node.closest('.card')) + 1];
  if (!next) return;
  next.scrollIntoView({ behavior: 'smooth', block: 'center' });
  next.classList.add('flash');
  setTimeout(() => next.classList.remove('flash'), 1200);
  next.querySelector('[data-edit=answer], .choice, [data-edit=note]')?.focus({ preventScroll: true });
}

// ---------- status bar actions ----------

$('copy-resume').addEventListener('click', async () => {
  const text = $('resume-prompt').textContent;
  try { await navigator.clipboard.writeText(text); toast('Copied. Paste it into your agent.'); }
  catch { const r = document.createRange(); r.selectNodeContents($('resume-prompt')); getSelection().removeAllRanges(); getSelection().addRange(r); }
});

async function sendAll() {
  await flushAll();
  const { sent } = await post('send');
  if (sent) focus.lastSentAt = new Date();
  toast(sent ? 'Sent to Claude.' : 'Nothing new to send.');
  if (isFocus()) renderFocus();
  renderProgress();
}
$('send').addEventListener('click', sendAll);

$('done').addEventListener('click', async () => {
  await flushAll();
  const shown = view.questions.filter((q) => visible(q) && groupOf(q) !== 4);
  const open = shown.filter((q) => groupOf(q) === 0).length;
  const skipped = shown.filter((q) => groupOf(q) === 3).length;
  if (open + skipped === 0) return finish();
  $('confirm-text').textContent = [open && \`\${open} not answered\`, skipped && \`\${skipped} skipped\`].filter(Boolean).join(', ') + '.';
  $('actions').hidden = true;
  $('confirm-done').hidden = false;
});
$('keep').addEventListener('click', () => { $('actions').hidden = false; $('confirm-done').hidden = true; });
$('done-anyway').addEventListener('click', finish);
async function finish() {
  $('actions').hidden = false;
  $('confirm-done').hidden = true;
  await flushAll();
  await post('done');
  toast('Marked done. Claude has your answers.');
}
$('reopen').addEventListener('click', () => post('reopen'));

// ---------- sidebar collapse (remembered per browser) ----------

function setCollapsed(c) {
  $('app').classList.toggle('collapsed', c);
  $('toggleSide').setAttribute('aria-expanded', String(!c));
  try { localStorage.setItem('pl-sidebar', c ? 'collapsed' : 'open'); } catch {}
}
function toggleSidebar() {
  if (matchMedia('(max-width: 760px)').matches) return $('app').classList.toggle('mobile-open');
  setCollapsed(!$('app').classList.contains('collapsed'));
}
$('toggleSide').addEventListener('click', toggleSidebar);
{
  let saved = null;
  try { saved = localStorage.getItem('pl-sidebar'); } catch {}
  setCollapsed(saved ? saved === 'collapsed' : innerWidth < 1100);
}
// ---------- explanation panel width (drag, arrow keys; remembered per browser) ----------

const INSP_DEFAULT = 380;
const inspMax = () => Math.max(300, Math.min(900, innerWidth - 640));
function setInspWidth(w, save = true) {
  const width = Math.round(Math.min(inspMax(), Math.max(280, w)));
  $('app').style.setProperty('--inspector', \`\${width}px\`);
  $('inspResizer').setAttribute('aria-valuenow', String(width));
  if (save) try { localStorage.setItem('pl-inspector', String(width)); } catch {}
  return width;
}
{
  const r = $('inspResizer');
  r.setAttribute('aria-valuemin', '280');
  r.setAttribute('aria-valuemax', String(inspMax()));
  let saved = null;
  try { saved = Number(localStorage.getItem('pl-inspector')); } catch {}
  setInspWidth(saved || INSP_DEFAULT, false);
  r.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { r.setPointerCapture(e.pointerId); } catch {}
    r.classList.add('dragging');
    document.body.classList.add('resizing');
    const right = $('inspector').getBoundingClientRect().right;
    const move = (ev) => setInspWidth(right - ev.clientX, false);
    const up = (ev) => {
      setInspWidth(right - ev.clientX);
      r.classList.remove('dragging');
      document.body.classList.remove('resizing');
      r.removeEventListener('pointermove', move);
      r.removeEventListener('pointerup', up);
    };
    r.addEventListener('pointermove', move);
    r.addEventListener('pointerup', up);
  });
  r.addEventListener('dblclick', () => setInspWidth(INSP_DEFAULT));
  r.addEventListener('keydown', (e) => {
    const cur = parseInt(getComputedStyle($('app')).getPropertyValue('--inspector'), 10) || INSP_DEFAULT;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setInspWidth(cur + 24); }
    if (e.key === 'ArrowRight') { e.preventDefault(); setInspWidth(cur - 24); }
  });
}
matchMedia('(min-width: 1400px)').addEventListener('change', () => { if (isFocus()) { focus.hardKey = null; renderFocus(); } });

// ---------- keyboard ----------

document.addEventListener('keydown', (e) => {
  const typing = e.target.matches?.('textarea, input, select, [contenteditable]');
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendAll(); return; }
  if ((e.key === 'b' || e.key === 'B') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); toggleSidebar(); return; }
  if (typing) {
    // In a text box: Shift+Enter is a new line (the browser default), Enter moves to the next question.
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing && e.target.matches('[data-edit]')) {
      e.preventDefault();
      e.target.blur();
      if (isFocus()) nextNeeding();
      else nextCardAfter(e.target);
      return;
    }
    if (e.key === 'Escape') {
      const ask = e.target.closest('[data-role=ask]');
      if (ask) ask.hidden = true;
      e.target.blur();
    }
    return;
  }
  if (e.key === 'Escape') return closeModal();
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'l' || e.key === 'L') return toggleSidebar();
  if (!view || !isFocus()) return;
  const ids = sortedIds();
  const i = ids.indexOf(focus.current);
  if (e.key === 'Enter' && !e.target.closest?.('button, a')) { e.preventDefault(); return focus.current ? nextNeeding() : primaryAction(); }
  if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); if (ids[i + 1]) goTo(ids[i + 1], 1); return; }
  if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); if (i > 0) goTo(ids[i - 1], -1); return; }
  const q = focus.current && qById(focus.current);
  if (!q) return;
  if (e.key === 'e') {
    e.preventDefault();
    const t = $('board').querySelector('[data-edit]');
    if (t) { t.focus(); if (t.type !== 'number') t.setSelectionRange(t.value.length, t.value.length); }
    return;
  }
  if (e.key === 's' || e.key === 'S') return skipCurrent();
  if (e.key === '?') { e.preventDefault(); return openAsk(); }
  if (/^[1-9]$/.test(e.key)) $('board').querySelectorAll('.f-card .choice')[Number(e.key) - 1]?.click();
});

// ---------- custom-layout API ----------

function emit(name, payload) {
  for (const fn of listeners[name] || []) {
    try { fn(payload); } catch (err) { console.error(err); }
  }
}

const api = {
  answer: (qid, value) => setAnswer(qid, { value }),
  note: (qid, note) => setAnswer(qid, { note }),
  explain: (qid, text = '') => post('explain', { qid, text }),
  skip: (qid, skipped = true) => post('skip', { qid, skipped }),
  send: () => sendAll(),
  done: () => $('done').click(),
  open: (qid) => reveal(qid),
  state: () => ({ ...view, answers: Object.fromEntries(view.questions.map((q) => [q.id, answerOf(q.id)])) }),
  on: (name, fn) => { (listeners[name] ||= []).push(fn); return () => { listeners[name] = listeners[name].filter((f) => f !== fn); }; },
  renderQuestion: (qid, node) => { const c = cards.get(qid); if (c) node.replaceChildren(c.el); },
};
window.punchList = api;

// ---------- live connection ----------

function render(next) {
  const wasExplaining = view ? new Set(view.questions.filter((q) => q.state?.explaining).map((q) => q.id)) : new Set();
  view = next;
  if (isFocus()) {
    if (layoutKey !== 'focus') { layoutKey = 'focus'; cards.clear(); focus.hardKey = null; }
    if (!focus.current || !view.questions.some((q) => q.id === focus.current)) focus.current = firstNeeding(null);
    renderFocus();
    renderChrome();
  } else {
    const lk = JSON.stringify([view.layout, view.questions.map((q) => [q.id, q.group])]);
    if (lk !== layoutKey) { layoutKey = lk; buildLayout(); }
    else for (const q of view.questions) updateCard(q);
    for (const id of [...cards.keys()]) if (!view.questions.some((q) => q.id === id)) cards.delete(id);
    renderChrome();
    refreshCards();
  }
  for (const q of view.questions) {
    if (wasExplaining.has(q.id) && !q.state?.explaining) {
      toast(\`New explanation on \u201C\${q.title}\u201D\`);
      announce(\`Claude explained \u201C\${q.title}\u201D.\`);
    }
  }
  emit('state', api.state());
}

function connect() {
  const es = new EventSource(\`/b/\${encodeURIComponent(boardId)}/stream?t=\${encodeURIComponent(token)}\`);
  let lostTimer;
  let lost = false;
  es.addEventListener('state', (e) => {
    clearTimeout(lostTimer);
    $('banner-conn').hidden = true;
    render(JSON.parse(e.data));
    if (lost) {
      lost = false;
      // Back online: save anything that failed while the server was away.
      flushAll().catch(() => {});
    }
  });
  es.onerror = () => {
    lost = true;
    clearTimeout(lostTimer);
    lostTimer = setTimeout(() => ($('banner-conn').hidden = false), 1500);
  };
}

window.addEventListener('beforeunload', () => { for (const qid of Object.keys(saveTimers)) flushOne(qid); });
connect();
`;

// raw:/Users/valeriimaslenykov/Projects/personal/sidekick/src/punch-list/page/styles.css
var styles_default = '/* punch-list page. Editor-style workspace: title bar, question sidebar, main area,\n   explanation panel (focus layout, wide screens), status bar. Dark syntax palette with\n   blue focus; light variant follows the OS. */\n:root {\n  --bg: #0D1117; --panel: #11161E; --surface: #161B24; --raised: #1C2230; --line: #252C3A; --line-strong: #353D4E;\n  --ink: #E6EDF3; --muted: #8B96A8; --faint: #6B7587;\n  --focus: #58A6FF; --btn: #2F6FEB; --btn-ink: #FFFFFF; --sel: #1A2740;\n  --need: #E3B341; --need-soft: #2E2510; --wait: #BC8CFF; --wait-soft: #261C3B; --ok: #3FB950; --ok-soft: #12291A; --skip: #8B949E; --skip-soft: #1C2128;\n  --font: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;\n  --mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;\n  --ease: cubic-bezier(.2, .7, .2, 1);\n  --sidebar: 300px; --rail: 52px; --inspector: 380px;\n  color-scheme: dark;\n}\n@media (prefers-color-scheme: light) {\n  :root { --bg: #F6F8FA; --panel: #FFFFFF; --surface: #FFFFFF; --raised: #F3F4F6; --line: #D8DEE4; --line-strong: #C3CBD3;\n    --ink: #1F2328; --muted: #59636E; --faint: #6E7781; --focus: #0969DA; --btn: #0969DA; --btn-ink: #FFFFFF; --sel: #DDF4FF;\n    --need: #9A6700; --need-soft: #FFF8C5; --wait: #8250DF; --wait-soft: #FBEFFF; --ok: #1A7F37; --ok-soft: #DAFBE1; --skip: #6E7781; --skip-soft: #EAEEF2;\n    color-scheme: light; }\n}\n\n* { box-sizing: border-box; }\nhtml, body { margin: 0; }\nbody { background: var(--bg); color: var(--ink); font: 16px/1.55 var(--font); -webkit-font-smoothing: antialiased; }\nbody.shell { height: 100vh; overflow: hidden; }\n[hidden] { display: none !important; }\nbutton { font: inherit; color: inherit; }\na { color: var(--focus); }\ncode { font-family: var(--mono); font-size: .88em; background: var(--raised); padding: 1px 5px; border-radius: 4px; overflow-wrap: anywhere; }\npre { overflow-x: auto; background: var(--raised); padding: 10px 12px; border-radius: 6px; font-size: 13px; }\npre code { background: none; padding: 0; }\nimg, svg, canvas, video { max-width: 100%; }\n:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 4px; }\n.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }\n.skip-link { position: absolute; left: 12px; top: -40px; background: var(--ink); color: var(--bg); padding: 6px 12px; border-radius: 6px; z-index: 30; }\n.skip-link:focus { top: 8px; }\n.muted { color: var(--muted); }\nsvg.g { width: 16px; height: 16px; flex: none; display: block; }\n.g.need { color: var(--need); } .g.wait { color: var(--wait); } .g.ok { color: var(--ok); } .g.skip { color: var(--skip); }\nkbd { font-family: var(--mono); font-size: 11px; border: 1px solid var(--line-strong); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; color: var(--muted); background: var(--surface); line-height: 1.5; }\n.rich { min-width: 0; overflow-wrap: anywhere; }\n.rich > :first-child { margin-top: 0; }\n.rich > :last-child { margin-bottom: 0; }\n.rich table { border-collapse: collapse; display: block; overflow-x: auto; font-size: 14px; }\n.rich th, .rich td { text-align: left; padding: 4px 12px 4px 0; border-bottom: 1px solid var(--line); }\n\n/* ---------- app grid ---------- */\n.app { height: 100vh; display: grid; grid-template-rows: 44px 1fr 30px; grid-template-columns: var(--sidebar) 1fr var(--inspector); grid-template-areas: "title title title" "side main insp" "status status status"; }\n.app.collapsed { grid-template-columns: var(--rail) 1fr var(--inspector); }\n.app.no-insp { grid-template-columns: var(--sidebar) 1fr; grid-template-areas: "title title" "side main" "status status"; }\n.app.no-insp.collapsed { grid-template-columns: var(--rail) 1fr; }\n.app.no-insp .inspector { display: none; }\n@media (max-width: 1399px) { .app { grid-template-columns: var(--sidebar) 1fr; grid-template-areas: "title title" "side main" "status status"; } .app.collapsed { grid-template-columns: var(--rail) 1fr; } .inspector { display: none; } }\n@media (max-width: 760px) {\n  .app, .app.collapsed, .app.no-insp, .app.no-insp.collapsed { grid-template-columns: 1fr; grid-template-areas: "title" "main" "status"; }\n  .sidebar { display: none; }\n  .app.mobile-open .sidebar { display: flex; position: fixed; inset: 44px 0 30px 0; z-index: 10; }\n  .proto, .statusbar .counts { display: none; }\n}\n\n/* ---------- title bar ---------- */\n.titlebar { grid-area: title; display: flex; align-items: center; gap: 10px; padding: 0 12px; border-bottom: 1px solid var(--line); background: var(--panel); min-width: 0; }\n.icon-btn { width: 32px; height: 32px; border-radius: 6px; border: none; background: transparent; color: var(--muted); display: grid; place-items: center; cursor: pointer; flex: none; }\n.icon-btn:hover { background: var(--raised); color: var(--ink); }\n.crumbs { font-family: var(--mono); font-size: 13px; color: var(--muted); display: flex; gap: 8px; align-items: center; min-width: 0; white-space: nowrap; overflow: hidden; }\n.crumbs b { color: var(--focus); font-weight: 600; }\n.crumbs .cur { color: var(--ink); overflow: hidden; text-overflow: ellipsis; }\n.crumbs .sep { color: var(--faint); }\n.proto { margin-left: auto; font-family: var(--mono); font-size: 12px; color: var(--faint); white-space: nowrap; }\n\n/* ---------- sidebar ---------- */\n.sidebar { grid-area: side; background: var(--panel); border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }\n.side-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px 6px 14px; font-family: var(--mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }\n.side-scroll { overflow-y: auto; flex: 1; padding: 0 6px 12px; }\n.sec-head { width: 100%; display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: none; background: none; cursor: pointer; font-family: var(--mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); border-radius: 4px; }\n.sec-head:hover { color: var(--ink); }\n.sec-head .chev { width: 10px; transition: transform .15s var(--ease); }\n.sec.closed .chev { transform: rotate(-90deg); }\n.sec.closed .items { display: none; }\n.sec-head .n { margin-left: auto; font-variant-numeric: tabular-nums; }\n.items { display: flex; flex-direction: column; gap: 1px; margin-bottom: 6px; }\n.item { display: grid; grid-template-columns: 16px 1fr auto; gap: 8px; align-items: center; width: 100%; text-align: left; padding: 6px 8px 6px 10px; min-height: 32px; border: none; background: none; border-radius: 4px; cursor: pointer; font-size: 14px; color: var(--ink); position: relative; }\n.item:hover { background: var(--raised); }\n.item.current { background: var(--sel); }\n.item.current::before { content: ""; position: absolute; left: 0; top: 6px; bottom: 6px; width: 2px; border-radius: 2px; background: var(--focus); }\n.item .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.item .a { font-family: var(--mono); font-size: 12px; color: var(--muted); max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.item.unsent .a::after { content: " \u2022"; color: var(--focus); }\n.item.fresh .t::after { content: " new"; font-family: var(--mono); font-size: 10px; color: var(--need); text-transform: uppercase; letter-spacing: .06em; }\n.item.withdrawn .t { text-decoration: line-through; color: var(--muted); }\n.app.collapsed .side-head span, .app.collapsed .sec-head, .app.collapsed .item .t, .app.collapsed .item .a { display: none; }\n.app.collapsed .sec.closed .items { display: flex; }\n.app.collapsed .side-head { justify-content: center; padding: 10px 0 6px; }\n.app.collapsed .items { align-items: center; margin: 0; padding: 4px 0; border-bottom: 1px solid var(--line); }\n.app.collapsed .item { grid-template-columns: 16px; width: 36px; justify-content: center; padding: 10px; }\n.app.collapsed .item.fresh::after { content: ""; position: absolute; top: 5px; right: 5px; width: 7px; height: 7px; border-radius: 50%; background: var(--need); }\n\n/* ---------- main ---------- */\n.main { grid-area: main; overflow-y: auto; min-width: 0; scroll-padding: 24px; }\n.main-in { max-width: 860px; margin: 0 auto; padding: 18px 28px 40px; display: flex; flex-direction: column; gap: 12px; }\n.main-in.wide { max-width: none; }\n.board-head { display: flex; flex-direction: column; gap: 2px; }\n.board-head h1 { margin: 0; font-size: 20px; line-height: 1.3; font-weight: 600; }\n.intro { color: var(--muted); max-width: 72ch; font-size: 15px; }\n.intro:empty { display: none; }\n\n.banner { border-radius: 6px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; font-size: 14px; border: 1px solid; }\n.banner.warn { background: var(--need-soft); color: var(--need); border-color: color-mix(in srgb, var(--need) 35%, transparent); }\n.banner.ok { background: var(--ok-soft); color: var(--ok); border-color: color-mix(in srgb, var(--ok) 35%, transparent); flex-direction: row; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }\n.copyrow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }\n.copyrow code { color: var(--ink); flex: 1 1 300px; padding: 6px 8px; }\n\n.progress { display: flex; flex-direction: column; gap: 6px; }\n.segments { display: flex; gap: 3px; height: 6px; }\n.segment { border: none; padding: 0; border-radius: 2px; cursor: pointer; transition: flex-grow .3s var(--ease); min-width: 0; }\n.segment.need { background: var(--need); } .segment.wait { background: var(--wait); } .segment.ok { background: var(--ok); } .segment.skip { background: var(--skip); }\n.segment:hover { filter: brightness(1.2); }\n.labels { display: flex; gap: 4px 16px; flex-wrap: wrap; font-family: var(--mono); font-size: 12px; color: var(--muted); }\n.labels button { display: flex; gap: 6px; align-items: center; background: none; border: none; padding: 3px 0; cursor: pointer; }\n.labels button:hover { color: var(--ink); }\n.labels b { color: var(--ink); font-weight: 600; }\n\n.chip { font-family: var(--mono); font-size: 11px; padding: 1px 7px; border-radius: 4px; background: var(--raised); color: var(--muted); white-space: nowrap; max-width: 200px; overflow: hidden; text-overflow: ellipsis; text-transform: none; letter-spacing: 0; }\n.chip.need, .chip.attn { background: var(--need-soft); color: var(--need); } .chip.wait, .chip.accent { background: var(--wait-soft); color: var(--wait); } .chip.ok { background: var(--ok-soft); color: var(--ok); } .chip.skip { background: var(--skip-soft); color: var(--skip); }\n.rec { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--need); border: 1px solid currentColor; padding: 0 5px; border-radius: 3px; margin-left: 8px; vertical-align: 2px; }\n\n/* ---------- buttons ---------- */\n.btn { font-weight: 600; font-size: 14px; border-radius: 6px; padding: 7px 14px; min-height: 36px; border: 1px solid var(--btn); background: var(--btn); color: var(--btn-ink); cursor: pointer; display: inline-flex; gap: 8px; align-items: center; justify-content: center; transition: filter .12s var(--ease); }\n.btn:hover { filter: brightness(1.1); }\n.btn kbd { background: transparent; color: inherit; border-color: color-mix(in srgb, currentColor 40%, transparent); }\n.btn.ghost { background: transparent; color: var(--ink); border-color: var(--line-strong); }\n.btn.ghost:hover { background: var(--raised); filter: none; }\n.btn.link { background: none; border-color: transparent; color: var(--muted); font-weight: 500; }\n.btn.link:hover { color: var(--ink); filter: none; }\n.btn.small { padding: 3px 10px; min-height: 28px; font-size: 13px; }\n.btn:disabled { opacity: .45; cursor: not-allowed; filter: none; }\n.actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }\n.spacer { flex: 1; }\n\n/* ---------- inputs shared by every layout ---------- */\n.field { display: flex; flex-direction: column; gap: 6px; }\n.field label { font-family: var(--mono); font-size: 12px; color: var(--muted); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }\ntextarea, input[type="number"] { width: 100%; font: inherit; font-size: 15px; color: var(--ink); background: var(--bg); border: 1px solid var(--line-strong); border-radius: 6px; padding: 9px 11px; }\ntextarea { min-height: 84px; resize: vertical; }\ntextarea.note { min-height: 44px; }\ninput[type="number"] { max-width: 200px; }\ntextarea:focus, input[type="number"]:focus { border-color: var(--focus); outline: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus) 25%, transparent); }\n.choices { display: grid; gap: 6px; }\n.choice { display: grid; grid-template-columns: 24px 1fr; gap: 12px; align-items: start; padding: 11px 14px; min-height: 48px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); cursor: pointer; text-align: left; color: var(--ink); width: 100%; transition: border-color .12s var(--ease), background .12s var(--ease); }\n.choice:hover { border-color: var(--line-strong); background: var(--raised); }\n.choice.on { border-color: var(--focus); background: var(--sel); }\n.key { font-family: var(--mono); font-size: 12px; width: 22px; height: 22px; border-radius: 4px; border: 1px solid var(--line-strong); display: grid; place-items: center; color: var(--muted); }\n.choice.on .key { background: var(--focus); border-color: var(--focus); color: var(--bg); }\n.choice b { font-weight: 600; }\n.choice small { display: block; color: var(--muted); font-size: 14px; }\n.choices.row { grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); }\n.choices.row .choice { grid-template-columns: 1fr; justify-items: center; text-align: center; }\n.choices.row .choice .key { display: none; }\n.rank { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; counter-reset: rank; }\n.rank li { display: flex; gap: 10px; align-items: center; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); }\n.rank li::before { counter-increment: rank; content: counter(rank); font-family: var(--mono); color: var(--muted); width: 1.5em; }\n.rank li span { flex: 1; min-width: 0; }\n\n.thread { display: flex; flex-direction: column; gap: 12px; }\n.thread:empty { display: none; }\n.expl { border-left: 2px solid var(--wait); padding: 2px 0 2px 12px; display: flex; flex-direction: column; gap: 6px; }\n.expl .asked { font-family: var(--mono); font-size: 12px; color: var(--muted); }\n.typing { color: var(--wait); font-family: var(--mono); font-size: 13px; }\n.typing::after { content: "\u2026"; animation: dots 1.2s steps(4, end) infinite; display: inline-block; width: 1.2em; overflow: hidden; vertical-align: bottom; }\n@keyframes dots { from { width: 0; } to { width: 1.2em; } }\n.ask { background: var(--raised); border-radius: 6px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }\n.ask textarea { min-height: 56px; }\n.notice { border-radius: 6px; padding: 8px 12px; font-size: 14px; display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }\n.notice.attn { background: var(--need-soft); color: var(--need); }\n.notice.muted-box { background: var(--raised); color: var(--muted); }\n\n/* ---------- focus layout ---------- */\n.peek { width: 100%; display: grid; grid-template-columns: 16px 1fr auto auto; gap: 10px; align-items: center; padding: 8px 12px; min-height: 40px; border: 1px dashed var(--line-strong); border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer; text-align: left; font-size: 14px; transition: color .15s var(--ease), border-color .15s var(--ease); }\n.peek:hover { color: var(--ink); border-style: solid; }\n.peek .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.peek .where { font-family: var(--mono); font-size: 11px; color: var(--faint); }\n.peek.empty { visibility: hidden; }\n.f-card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 22px 24px; display: flex; flex-direction: column; gap: 16px; position: relative; }\n.f-card::before { content: ""; position: absolute; left: -1px; top: -1px; bottom: -1px; width: 3px; border-radius: 8px 0 0 8px; background: var(--c, var(--line)); }\n.f-card.need-c { --c: var(--need); } .f-card.wait-c { --c: var(--wait); } .f-card.ok-c { --c: var(--ok); } .f-card.skip-c { --c: var(--skip); }\n.f-card.enter { animation: enter .2s var(--ease); }\n@keyframes enter { from { opacity: 0; transform: translateY(var(--from, 10px)); } to { opacity: 1; transform: none; } }\n.f-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; font-family: var(--mono); font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }\n.f-top span { display: flex; gap: 8px; align-items: center; }\n.f-card h2 { margin: 0; font-size: 24px; line-height: 1.3; font-weight: 600; letter-spacing: -.01em; text-wrap: balance; }\n.done-card .big { width: 40px; height: 40px; color: var(--ok); }\n.later { width: 100%; display: flex; flex-direction: column; gap: 6px; }\n.hint { font-family: var(--mono); font-size: 12px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 6px 16px; justify-content: center; padding-top: 4px; }\n\n/* ---------- other layouts: question cards ---------- */\n.board { display: flex; flex-direction: column; gap: 14px; }\n.section { display: flex; flex-direction: column; gap: 12px; }\n.section > h2 { margin: 8px 0 0; font-family: var(--mono); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); font-weight: 500; }\n.card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; min-width: 0; position: relative; }\n.card.is-answered::before, .card.is-changed::before, .card.is-explaining::before { content: ""; position: absolute; left: -1px; top: -1px; bottom: -1px; width: 3px; border-radius: 8px 0 0 8px; background: var(--ok); }\n.card.is-changed::before { background: var(--need); }\n.card.is-explaining::before { background: var(--wait); }\n.card.is-withdrawn { opacity: .55; }\n.card.flash { box-shadow: 0 0 0 2px var(--focus); }\n.card-head { display: flex; gap: 10px; align-items: flex-start; justify-content: space-between; }\n.card-title { margin: 0; font-size: 17px; line-height: 1.35; font-weight: 600; text-wrap: balance; min-width: 0; }\n.card-meta { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }\n.card-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }\n.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); overflow-x: auto; }\n.tab { font-weight: 600; font-size: 14px; background: none; border: none; border-bottom: 2px solid transparent; padding: 8px 12px; color: var(--muted); cursor: pointer; white-space: nowrap; display: flex; gap: 6px; align-items: center; }\n.tab[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--focus); }\n.tab .count { font-family: var(--mono); font-size: 11px; background: var(--raised); padding: 0 6px; border-radius: 999px; }\n.wizard-nav { display: flex; justify-content: space-between; align-items: center; gap: 10px; }\n.wizard-bar { height: 4px; background: var(--raised); border-radius: 999px; overflow: hidden; }\n.wizard-bar > div { height: 100%; background: var(--focus); transition: width .2s; }\n.columns { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(230px, 1fr); gap: 12px; overflow-x: auto; padding-bottom: 6px; }\n.column { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }\n.column > h2 { margin: 2px 4px 4px; font-family: var(--mono); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); display: flex; justify-content: space-between; font-weight: 500; }\n.mini { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 10px; text-align: left; color: var(--ink); cursor: pointer; display: flex; flex-direction: column; gap: 6px; }\n.mini:hover { border-color: var(--line-strong); }\n.mini-title { font-weight: 600; font-size: 14px; }\n\n/* ---------- inspector ---------- */\n.inspector { grid-area: insp; background: var(--panel); border-left: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; position: relative; }\n.resizer { position: absolute; left: -5px; top: 0; bottom: 0; width: 9px; cursor: col-resize; z-index: 5; touch-action: none; }\n.resizer::after { content: ""; position: absolute; left: 3px; top: 0; bottom: 0; width: 3px; background: transparent; transition: background .15s var(--ease); }\n.resizer:hover::after, .resizer.dragging::after, .resizer:focus-visible::after { background: var(--focus); }\n.resizer:focus-visible { outline: none; }\nbody.resizing { cursor: col-resize; user-select: none; }\n.insp-head { padding: 10px 16px 6px; font-family: var(--mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); display: flex; justify-content: space-between; }\n.insp-body { overflow-y: auto; padding: 4px 16px 16px; display: flex; flex-direction: column; gap: 14px; }\n.empty-state { color: var(--muted); font-size: 14px; border: 1px dashed var(--line-strong); border-radius: 6px; padding: 14px; }\n.insp-q { font-size: 14px; color: var(--muted); }\n.insp-q b { color: var(--ink); font-weight: 600; }\n\n/* ---------- status bar ---------- */\n.statusbar { grid-area: status; display: flex; align-items: center; gap: 14px; padding: 0 8px 0 12px; background: var(--panel); border-top: 1px solid var(--line); font-family: var(--mono); font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; }\n.statusbar .live { display: flex; gap: 6px; align-items: center; color: var(--ok); }\n.statusbar .live i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 22%, transparent); }\n.statusbar .live.off { color: var(--need); }\n.statusbar .counts { display: flex; gap: 12px; }\n.statusbar .counts span { display: flex; gap: 5px; align-items: center; }\n.statusbar .counts svg.g { width: 12px; height: 12px; }\n.statusbar .sb-btn { border: none; background: none; color: var(--muted); font: inherit; padding: 0 8px; height: 30px; cursor: pointer; display: flex; gap: 6px; align-items: center; }\n.statusbar .sb-btn:hover { background: var(--raised); color: var(--ink); }\n.statusbar .sb-btn.primary { background: var(--btn); color: var(--btn-ink); }\n.statusbar .sb-btn.primary:disabled { background: transparent; color: var(--faint); cursor: default; }\n.statusbar .confirm { display: flex; gap: 4px; align-items: center; color: var(--need); }\n\n/* ---------- modal, toast ---------- */\n.modal { position: fixed; inset: 0; display: grid; place-items: center; padding: 16px; z-index: 20; }\n.modal-back { position: absolute; inset: 0; background: rgb(0 0 0 / .55); }\n.modal-card { position: relative; width: min(760px, 100%); max-height: calc(100vh - 32px); overflow: auto; background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 44px 14px 14px; }\n.modal-x { position: absolute; top: 10px; right: 10px; }\n.toast { position: fixed; right: 16px; bottom: 42px; background: var(--raised); color: var(--ink); border: 1px solid var(--line-strong); padding: 8px 14px; border-radius: 6px; font-size: 14px; z-index: 30; box-shadow: 0 8px 24px rgb(0 0 0 / .25); }\n\n/* ---------- index page ---------- */\n.page { max-width: 820px; margin: 0 auto; padding: 28px 16px 60px; display: flex; flex-direction: column; gap: 16px; }\n.eyebrow { font-family: var(--mono); font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }\n.eyebrow .brand { color: var(--focus); font-weight: 600; }\n.page h1 { margin: 0; font-size: 24px; }\n.index-list { display: flex; flex-direction: column; gap: 6px; }\n.index-row { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; padding: 12px 14px; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; text-decoration: none; color: var(--ink); }\n.index-row:hover { border-color: var(--line-strong); }\n.index-title { font-weight: 600; }\n.index-date { font-size: 13px; grid-column: 1 / -1; color: var(--muted); font-family: var(--mono); }\n\n@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }\n.section > .btn { align-self: flex-start; }\n';

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
