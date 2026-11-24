import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../node_modules/@walletconnect/ethereum-provider/LICENSE.md");
const destination = resolve(here, "../public/licenses/walletconnect-ethereum-provider-LICENSE.md");

if (!existsSync(source)) {
  throw new Error("WalletConnect provider license file is missing. Run npm install before building.");
}
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
console.log("Copied WalletConnect provider license into the public build.");
