// Builds atpe-mobile.html: ATPE.jsx compiled with TypeScript (classic JSX → React.createElement),
// Tailwind compiled to only the classes used, both inlined; libraries load from jsDelivr
// (exact npm versions, UMD builds).
// Usage: node build.mjs   (run from this folder; uses ../frontend/node_modules)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const nm = join(here, "../frontend/node_modules");
const require = createRequire(join(nm, "noop.js"));
const ts = require("typescript");

const src = readFileSync(join(here, "ATPE.jsx"), "utf8");
const out = ts.transpileModule(src, {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.None, removeComments: true },
  reportDiagnostics: true,
  fileName: "ATPE.jsx",
});
if (out.diagnostics?.length) {
  for (const d of out.diagnostics) console.error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  process.exit(1);
}
const js = out.outputText.replace(/^"use strict";\s*/, "").replace(/<\/script/gi, "<\\/script");

const tmp = mkdtempSync(join(tmpdir(), "atpe-tw-"));
const config = join(tmp, "tailwind.config.cjs");
const color = (v) => `rgb(var(--${v}) / <alpha-value>)`;
writeFileSync(config, `module.exports = {
  content: [${JSON.stringify(join(here, "ATPE.jsx"))}],
  theme: { extend: {
    colors: { ink: "${color("ink")}", panel: "${color("panel")}", line: "${color("line")}", fg: "${color("fg")}", muted: "${color("muted")}",
      emerald: "${color("emerald")}", amber: "${color("amber")}", risk: "${color("risk")}", sky: "${color("sky")}" },
    fontFamily: { display: "var(--font-display)", data: "var(--font-data)", body: "var(--font-body)" },
  } },
  corePlugins: { preflight: true },
};`);
const cssOut = join(tmp, "out.css");
execFileSync(process.execPath, [join(nm, "tailwindcss/lib/cli.js"), "-c", config, "-i", join(here, "styles.css"), "-o", cssOut, "--minify"], { stdio: "inherit" });
const css = readFileSync(cssOut, "utf8");

const v = (p) => require(`${p}/package.json`).version;
const cdn = (pkg, file) => `https://cdn.jsdelivr.net/npm/${pkg}@${v(pkg)}/${file}`;

const html = `<title>ATPE Mobile</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>${css}</style>
<div id="root"><p style="padding:48px 0;text-align:center;color:rgb(139 151 169);font:14px system-ui">Loading ATPE…</p></div>
<script src="${cdn("react", "umd/react.production.min.js")}"></script>
<script src="${cdn("react-dom", "umd/react-dom.production.min.js")}"></script>
<script src="${cdn("prop-types", "prop-types.min.js")}"></script>
<script src="${cdn("recharts", "umd/Recharts.js")}"></script>
<script>window.react = window.React; /* lucide-react's UMD build reads a lowercase global */</script>
<script src="${cdn("lucide-react", "dist/umd/lucide-react.min.js")}"></script>
<script>
if (!window.React || !window.ReactDOM || !window.Recharts || !window.LucideReact) {
  document.getElementById("root").innerHTML = '<p style="padding:48px 0;text-align:center;color:rgb(255 92 122);font:14px system-ui">The chart and UI libraries didn\\'t load. Check your connection and reopen the page.</p>';
} else {
${js}
}
</script>
`;
writeFileSync(join(here, "atpe-mobile.html"), html);
console.log(`atpe-mobile.html ${(html.length / 1024).toFixed(0)} KB (css ${(css.length / 1024).toFixed(0)} KB, js ${(js.length / 1024).toFixed(0)} KB)`);
