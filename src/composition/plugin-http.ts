/** Explicit composition adapter between the generic HTTP extension port and plugins. */
import { PosixLoomError } from "../core/errors.js";
import type { RemoteHttpExtension } from "../http/server.js";
import type { PluginMarketplace } from "../plugins/marketplace.js";

function pluginId(segment: string): string {
  let value: string;
  try {
    value = decodeURIComponent(segment);
  } catch {
    throw new PosixLoomError("PLUGIN_ID_INVALID", "Plugin id is not valid URL encoding");
  }
  if (!value || value.length > 128 || value.includes("/") || value.includes("\\")) throw new PosixLoomError("PLUGIN_ID_INVALID", "Plugin id is invalid", { pluginId: value });
  return value;
}

/** Create optional plugin API routes without introducing dependencies into either component. */
export function createPluginMarketplaceHttpExtension(marketplace: PluginMarketplace): RemoteHttpExtension {
  return {
    capabilities: ["plugins"],
    async handle(request) {
      if (request.pathname === "/api/v1/plugins/catalog") {
        if (request.method !== "GET") throw new PosixLoomError("HTTP_METHOD_NOT_ALLOWED", "Plugin catalog only supports GET");
        return { body: { plugins: await marketplace.catalog(request.searchParams.get("q") ?? "") } };
      }
      if (request.pathname === "/api/v1/plugins/installed") {
        if (request.method !== "GET") throw new PosixLoomError("HTTP_METHOD_NOT_ALLOWED", "Installed plugins only support GET");
        return { body: { plugins: await marketplace.installed() } };
      }
      const match = request.pathname.match(/^\/api\/v1\/plugins\/([^/]+)$/);
      if (!match) return undefined;
      const id = pluginId(match[1]);
      if (request.method === "POST") return { body: { plugin: await marketplace.install(id) } };
      if (request.method === "DELETE") {
        await marketplace.uninstall(id);
        return { body: { removed: true, pluginId: id } };
      }
      throw new PosixLoomError("HTTP_METHOD_NOT_ALLOWED", "Plugin endpoint only supports POST and DELETE");
    },
  };
}

