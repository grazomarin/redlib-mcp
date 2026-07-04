import { homedir } from "node:os";
import { join } from "node:path";

// Per-OS data dir for the Redlib clone + build state (spec §14). env/platform are injectable so
// the resolver is testable off-host. Linux honors XDG_DATA_HOME.
export function dataDir(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  if (platform === "win32") {
    return join(env.LOCALAPPDATA || join(env.HOME || homedir(), "AppData", "Local"), "redlib-mcp");
  }
  if (platform === "darwin") {
    return join(env.HOME || homedir(), "Library", "Application Support", "redlib-mcp");
  }
  return join(env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"), "redlib-mcp");
}

export function cloneDir(env?: NodeJS.ProcessEnv, platform?: string): string {
  return join(dataDir(env, platform), "redlib-src");
}

// A build lock so concurrent agent retries can't stack parallel Rust compiles (spec §8).
export function buildLockPath(env?: NodeJS.ProcessEnv, platform?: string): string {
  return join(dataDir(env, platform), "build.lock");
}
