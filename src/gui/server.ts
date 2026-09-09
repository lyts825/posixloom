/** Standalone static server for the PosixLoom browser GUI. */
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PosixLoomError } from "../core/errors.js";

export interface GuiServerOptions {
  host?: string;
  port?: number;
  apiBaseUrl: string;
}

export interface GuiServer {
  host: string;
  port: number;
  origin: string;
  closed: Promise<void>;
  close(): Promise<void>;
}

interface GuiAsset {
  contentType: string;
  bytes: Buffer;
}

/** Start the GUI asset server. It has no reference to the HTTP control implementation. */
export async function startGuiServer(options: GuiServerOptions): Promise<GuiServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 7330;
  if (!host.trim()) throw new PosixLoomError("GUI_OPTIONS_INVALID", "GUI host must be non-empty");
  if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) throw new PosixLoomError("GUI_OPTIONS_INVALID", "GUI port must be an integer between 0 and 65535");
  let apiUrl: URL;
  try {
    apiUrl = new URL(options.apiBaseUrl);
  } catch {
    throw new PosixLoomError("GUI_OPTIONS_INVALID", "GUI apiBaseUrl must be an absolute URL");
  }
  if (apiUrl.protocol !== "http:" && apiUrl.protocol !== "https:") throw new PosixLoomError("GUI_OPTIONS_INVALID", "GUI apiBaseUrl must use HTTP or HTTPS");

  const publicRoot = join(dirname(fileURLToPath(import.meta.url)), "public");
  const definitions: Array<[string, string, string]> = [
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/index.html", "index.html", "text/html; charset=utf-8"],
    ["/app.css", "app.css", "text/css; charset=utf-8"],
    ["/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/console-output.js", "console-output.js", "text/javascript; charset=utf-8"],
    ["/favicon.svg", "favicon.svg", "image/svg+xml"],
  ];
  const assets = new Map<string, GuiAsset>();
  await Promise.all(definitions.map(async ([route, filename, contentType]) => {
    assets.set(route, { contentType, bytes: await readFile(join(publicRoot, filename)) });
  }));
  const configuration = Buffer.from(`${JSON.stringify({ apiVersion: 1, apiBaseUrl: apiUrl.origin, product: "PosixLoom" })}\n`);
  const connectSource = apiUrl.origin === "null" ? "" : ` ${apiUrl.origin}`;
  const contentSecurityPolicy = `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'${connectSource}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;

  const server: Server = createServer((request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("content-security-policy", contentSecurityPolicy);
    response.setHeader("cross-origin-opener-policy", "same-origin");
    response.setHeader("cross-origin-resource-policy", "same-origin");
    response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD", "content-type": "application/json; charset=utf-8" });
      response.end('{"error":{"code":"GUI_METHOD_NOT_ALLOWED","message":"Only GET and HEAD are supported"}}\n');
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://gui.local").pathname;
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    if (pathname === "/config.json") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": configuration.length });
      if (method === "HEAD") response.end();
      else response.end(configuration);
      return;
    }
    const asset = assets.get(pathname);
    if (!asset) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end(method === "HEAD" ? undefined : "Not found\n");
      return;
    }
    response.writeHead(200, { "content-type": asset.contentType, "cache-control": "no-cache", "content-length": asset.bytes.length });
    if (method === "HEAD") response.end();
    else response.end(asset.bytes);
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => { server.off("listening", onListening); reject(error); };
    const onListening = (): void => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(requestedPort, host);
  });
  const address = server.address() as AddressInfo;
  const displayHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  server.once("close", resolveClosed);
  let closePromise: Promise<void> | undefined;
  return {
    host: address.address,
    port: address.port,
    origin: `http://${displayHost}:${address.port}`,
    closed,
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closePromise = new Promise<void>((resolve, reject) => {
        if (!server.listening) { resolve(); return; }
        server.close((error) => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
      return closePromise;
    },
  };
}
