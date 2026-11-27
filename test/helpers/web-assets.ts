import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";

// The page's own static files other than the page itself, for test servers that serve src/web/index.html without the real
// server: the vendored component library (src/web/vendor/pico/README.md) at the address the page imports it from, and the
// appearance settings script the page loads in <head> (docs/appearance.md).
export const PICO_CSS_PATH = "/vendor/pico.orbit.min.css";
const picoCss = readFileSync(new URL("../../src/web/vendor/pico/pico.orbit.min.css", import.meta.url), "utf8");
const appearanceJs = readFileSync(new URL("../../src/web/appearance.js", import.meta.url), "utf8");

// Serves the file and returns true when `pathname` is one of them; false otherwise (the caller handles the request).
export function serveWebAsset(pathname: string, res: ServerResponse): boolean {
  if (pathname === "/appearance.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    res.end(appearanceJs);
    return true;
  }
  if (pathname !== PICO_CSS_PATH) return false;
  res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
  res.end(picoCss);
  return true;
}
