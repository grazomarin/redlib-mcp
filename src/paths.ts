import { homedir } from "node:os";
import { win32, posix } from "node:path";

// Join with the TARGET platform's path flavor, not the host's — so a linux path computed on a
// Windows CI runner still uses "/". env/platform are injectable so the resolver is testable off-host.
const flavor = (platform: string) => (platform === "win32" ? win32 : posix);

// Per-OS data dir for the Redlib clone + build state. Linux honors XDG_DATA_HOME.
export function dataDir(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  const p = flavor(platform);
  if (platform === "win32") {
    return p.join(env.LOCALAPPDATA || p.join(env.HOME || homedir(), "AppData", "Local"), "redlib-mcp");
  }
  if (platform === "darwin") {
    return p.join(env.HOME || homedir(), "Library", "Application Support", "redlib-mcp");
  }
  return p.join(env.XDG_DATA_HOME || p.join(env.HOME || homedir(), ".local", "share"), "redlib-mcp");
}

export function cloneDir(env?: NodeJS.ProcessEnv, platform: string = process.platform): string {
  return flavor(platform).join(dataDir(env, platform), "redlib-src");
}

// A build lock so concurrent agent retries can't stack parallel Rust compiles.
export function buildLockPath(env?: NodeJS.ProcessEnv, platform: string = process.platform): string {
  return flavor(platform).join(dataDir(env, platform), "build.lock");
}
