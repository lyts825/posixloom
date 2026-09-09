import { spawn } from "node:child_process";
import type { RemoteHttpServer } from "../http/server.js";
import type { GuiServer } from "../gui/server.js";

interface HttpCliOptions {
  mode: "stdio" | "http";
  host: string;
  port: number;
  token?: string;
  corsOrigins: string[];
  marketplaceUrl?: string;
  plugins: boolean;
}

interface GuiCliOptions {
  host: string;
  port: number;
  apiUrl?: string;
  apiHost: string;
  apiPort: number;
  token?: string;
  marketplaceUrl?: string;
  open: boolean;
  plugins: boolean;
}

export function requiredOptionValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function cliPort(value: string | undefined, fallback: number, name: string): number {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw new Error(`${name} must be an integer between 1 and 65535`);
  return port;
}

export function parseServeOptions(args: string[]): HttpCliOptions {
  let mode: "stdio" | "http" | undefined;
  let host = process.env.POSIXLOOM_HTTP_HOST ?? "127.0.0.1";
  let portValue = process.env.POSIXLOOM_HTTP_PORT;
  let token = process.env.POSIXLOOM_HTTP_TOKEN;
  let marketplaceUrl = process.env.POSIXLOOM_MARKETPLACE_URL;
  let plugins = true;
  const corsOrigins: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--stdio") { if (mode) throw new Error("Choose exactly one serve transport"); mode = "stdio"; continue; }
    if (argument === "--http") { if (mode) throw new Error("Choose exactly one serve transport"); mode = "http"; continue; }
    if (argument === "--host") { host = requiredOptionValue(args, index, argument); index += 1; continue; }
    if (argument === "--port") { portValue = requiredOptionValue(args, index, argument); index += 1; continue; }
    if (argument === "--token") { token = requiredOptionValue(args, index, argument); index += 1; continue; }
    if (argument === "--cors-origin") { corsOrigins.push(requiredOptionValue(args, index, argument)); index += 1; continue; }
    if (argument === "--marketplace") { marketplaceUrl = requiredOptionValue(args, index, argument); index += 1; continue; }
    if (argument === "--no-plugins") { plugins = false; continue; }
    throw new Error(`Unknown serve option: ${argument}`);
  }
  if (!mode) throw new Error("serve requires --stdio or --http");
  if (mode === "stdio" && (args.length !== 1 || args[0] !== "--stdio")) throw new Error("serve --stdio cannot be combined with HTTP options");
  return { mode, host, port: cliPort(portValue, 7331, "--port"), token, corsOrigins, marketplaceUrl, plugins };
}

export function parseGuiOptions(args: string[]): GuiCliOptions {
  let host = process.env.POSIXLOOM_GUI_HOST ?? "127.0.0.1";
  let portValue = process.env.POSIXLOOM_GUI_PORT;
  let apiUrl: string | undefined;
  let apiHost = process.env.POSIXLOOM_HTTP_HOST ?? "127.0.0.1";
  let apiPortValue = process.env.POSIXLOOM_HTTP_PORT;
  let token = process.env.POSIXLOOM_HTTP_TOKEN;
  let marketplaceUrl = process.env.POSIXLOOM_MARKETPLACE_URL;
  let open = true;
  let plugins = true;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--host") { host = requiredOptionValue(args, index, argument); index += 1; continue; }
    if (argument === "--port") { portValue = requiredOptionValue(args, index, argument); index += 1; continue; }
    if (argument === "--api-url") { apiUrl = requiredOptionValue(args, index, argument); index += 1; continue; }
    if (argument === "--api-host") { apiHost = requiredOptionValue(args, index, argument); index += 1; continue; }
    if (argument === "--api-port") { apiPortValue = requiredOptionValue(args, index, argument); index += 1; continue; }
    if (argument === "--token") { token = requiredOptionValue(args, index, argument); index += 1; continue; }
    if (argument === "--marketplace") { marketplaceUrl = requiredOptionValue(args, index, argument); index += 1; continue; }
    if (argument === "--no-open") { open = false; continue; }
    if (argument === "--no-plugins") { plugins = false; continue; }
    throw new Error(`Unknown gui option: ${argument}`);
  }
  if (apiUrl && (args.includes("--api-host") || args.includes("--api-port") || args.includes("--token") || args.includes("--marketplace") || args.includes("--no-plugins"))) {
    throw new Error("--api-url connects to an existing service and cannot be combined with embedded API options");
  }
  return {
    host,
    port: cliPort(portValue, 7330, "--port"),
    apiUrl,
    apiHost,
    apiPort: cliPort(apiPortValue, 7331, "--api-port"),
    token,
    marketplaceUrl,
    open,
    plugins,
  };
}

export function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function openBrowser(url: string): void {
  const target = process.platform === "win32"
    ? { program: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }
    : process.platform === "darwin"
      ? { program: "open", args: [url] }
      : { program: "xdg-open", args: [url] };
  try {
    const child = spawn(target.program, target.args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", (error) => console.error(`[GUI OPEN WARN] ${error.message}`));
    child.unref();
  } catch (error) {
    console.error(`[GUI OPEN WARN] ${String(error)}`);
  }
}

export async function waitForNetworkServices(services: Array<RemoteHttpServer | GuiServer>): Promise<void> {
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void Promise.allSettled(services.map((service) => service.close()));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await Promise.race(services.map((service) => service.closed));
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await Promise.allSettled(services.map((service) => service.close()));
  }
}
