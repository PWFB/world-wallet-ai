import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(here, "../node_modules/@walletconnect/ethereum-provider/package.json");
const packageDir = dirname(packageJsonPath);
const publicDir = resolve(here, "../public/licenses");

if (!existsSync(packageJsonPath)) {
  throw new Error("WalletConnect Ethereum provider package is missing. Run npm install before building.");
}
const metadata = JSON.parse(readFileSync(packageJsonPath, "utf8"));
mkdirSync(publicDir, { recursive: true });

const licenseCandidates = ["LICENSE.md", "LICENSE", "LICENSE.txt"];
const licenseFile = licenseCandidates
  .map(name => resolve(packageDir, name))
  .find(path => existsSync(path));

if (licenseFile) {
  const extension = licenseFile.endsWith(".txt") ? ".txt" : ".md";
  const destination = resolve(publicDir, "walletconnect-ethereum-provider-LICENSE" + extension);
  copyFileSync(licenseFile, destination);
  console.log("Copied WalletConnect Ethereum provider license text.");
} else {
  const identifier = String(metadata.license || "SEE LICENSE IN PACKAGE");
  const packageName = String(metadata.name || "@walletconnect/ethereum-provider");
  const version = String(metadata.version || "unknown");
  const notice = [
    "Third-party package license notice",
    "Package: " + packageName,
    "Version: " + version,
    "Declared license: " + identifier,
    "",
    "The installed npm package does not contain a separate license text file.",
    identifier === "Apache-2.0"
      ? "Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0"
      : "Consult the package publisher's license terms before redistribution.",
    "",
    "This notice records package metadata only. It is not a replacement for a required license-text copy or a transitive dependency license review.",
    "",
  ].join("\n");
  writeFileSync(resolve(publicDir, "walletconnect-ethereum-provider-LICENSE-NOTICE.txt"), notice, "utf8");
  console.log("Wrote WalletConnect package license metadata notice (" + identifier + ").");
}
