// Stage the HTML the daemon serves next to the compiled JS in build/src/.
// Fails loud: a missing artifact must break the build, not surface at runtime
// as a daemon that 500s on its own dashboard.
import { copyFileSync, existsSync } from "node:fs";

const copies = [
  ["src/dashboard.html", "build/src/dashboard.html"],
  ["dashboard-ui/dist/index.html", "build/src/dashboard-next.html"],
];

for (const [from, to] of copies) {
  if (!existsSync(from)) {
    console.error(`copy-html: ${from} is missing — run the full build (npm run build), not tsc alone`);
    process.exit(1);
  }
  copyFileSync(from, to);
}
