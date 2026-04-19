import fs from "node:fs/promises";
import path from "node:path";

const root = new URL(".", import.meta.url);
const distDir = new URL("./dist/", root);
const vendorDir = new URL("./dist/vendor/", root);

const sourceFiles = [
  "index.html",
  "app.js",
  "styles.css",
];

async function main() {
  await fs.rm(distDir, { recursive: true, force: true });
  await fs.mkdir(distDir, { recursive: true });
  await fs.mkdir(vendorDir, { recursive: true });

  for (const file of sourceFiles) {
    let content = await fs.readFile(new URL(`./${file}`, root), "utf8");

    if (file === "app.js") {
      content = content.replace(
        './node_modules/@heroiclabs/nakama-js/dist/nakama-js.esm.mjs',
        "./vendor/nakama-js.esm.mjs",
      );
    }

    await fs.writeFile(new URL(`./${file}`, distDir), content, "utf8");
  }

  const appConfig = `window.__APP_CONFIG__ = ${JSON.stringify({
    nakamaHost: process.env.NAKAMA_HOST || "127.0.0.1",
    nakamaPort: process.env.NAKAMA_PORT || "7350",
    nakamaUseSSL: String(process.env.NAKAMA_SSL || "false").toLowerCase() === "true",
  }, null, 2)};\n`;

  await fs.writeFile(new URL("./app-config.js", distDir), appConfig, "utf8");

  const vendorSource = new URL("./node_modules/@heroiclabs/nakama-js/dist/nakama-js.esm.mjs", root);
  const vendorTarget = new URL("./nakama-js.esm.mjs", vendorDir);
  await fs.copyFile(vendorSource, vendorTarget);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
