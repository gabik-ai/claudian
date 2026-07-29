/**
 * Mazel patch M9: make the RUNNING plugin build observable from outside.
 *
 * Patch M8 discards a Stop-hook-blocked draft so the user never reads two
 * versions of the same answer. That protection lives in `main.js`, and Obsidian
 * reads `main.js` exactly once, at plugin load. `bin/deploy.sh --no-reload` is
 * mandatory when Claudian itself deploys, so the freshly built file can sit on
 * disk for hours while the old build keeps serving the chat.
 *
 * Measured on 2026-07-29: `main.js` carried M8 since 00:43, the Obsidian process
 * had started at 22:51 the evening before, and a blocked answer still appeared
 * twice in the chat at 17:29. Every file-level check was green, because every
 * file-level check reads the file, not the process.
 *
 * The beacon closes that gap: at load the plugin stamps the identity of the
 * `main.js` it actually executed into `.claudian/laufende-version.json`. A guard
 * outside Obsidian compares that stamp with the file on disk. Different stamp =
 * deployed but not loaded = M8 is not active, no matter what the file says.
 *
 * Identity is `size` plus `mtime` of `main.js`, not a hash: the stat is free,
 * the file is 3.3 MB, and every deploy rewrites it. Kept in sync with
 * `.claude/scripts/stil-block-marker-check.py --laufend`.
 */

import { CLAUDIAN_STORAGE_PATH } from './StoragePaths';

export const RUNTIME_BEACON_PATH = `${CLAUDIAN_STORAGE_PATH}/laufende-version.json`;

export interface RuntimeBeacon {
  /** Size in bytes of the `main.js` this process is running. */
  mainJsSize: number;
  /** Modification time in ms of that same file. */
  mainJsMtime: number;
  /** Plugin version from the manifest, for the human reading the file. */
  version: string;
  /** When this process loaded, ISO 8601. */
  loadedAt: string;
}

export interface BeaconStat {
  size: number;
  mtime: number;
}

export interface BeaconAdapter {
  stat(path: string): Promise<BeaconStat | null>;
  write(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export function buildRuntimeBeacon(
  stat: BeaconStat,
  version: string,
  loadedAt: string,
): RuntimeBeacon {
  return {
    mainJsSize: stat.size,
    mainJsMtime: stat.mtime,
    version,
    loadedAt,
  };
}

/**
 * Writes the beacon. Never throws: a plugin that fails to load because a
 * diagnostic file could not be written would be a worse bug than the one this
 * diagnoses. Returns the beacon on success, `null` when it was skipped.
 */
export async function writeRuntimeBeacon(
  adapter: BeaconAdapter,
  manifestDir: string,
  version: string,
  now: () => Date = () => new Date(),
): Promise<RuntimeBeacon | null> {
  try {
    const mainPath = `${manifestDir.replace(/\/$/, '')}/main.js`;
    const stat = await adapter.stat(mainPath);
    if (!stat) return null;

    if (!(await adapter.exists(CLAUDIAN_STORAGE_PATH))) {
      await adapter.mkdir(CLAUDIAN_STORAGE_PATH);
    }

    const beacon = buildRuntimeBeacon(stat, version, now().toISOString());
    await adapter.write(RUNTIME_BEACON_PATH, `${JSON.stringify(beacon, null, 2)}\n`);
    return beacon;
  } catch {
    return null;
  }
}
