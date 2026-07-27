/**
 * Mazel patch: fork identity.
 *
 * The upstream plugin ships as `realclaudian`. Our fork keeps the historic id
 * `claudian` so the existing `.obsidian/plugins/claudian/data.json` (tab state)
 * and every hotkey bound to `claudian:*` survive the switch.
 *
 * These two ids must never converge:
 *  - if we were `realclaudian`, Obsidian's community-plugin updater would
 *    overwrite our build with upstream's on the next update check.
 *  - if upstream ever renamed itself back to `claudian`, this patch would be
 *    obsolete AND dangerous at the same time. The guard below goes red then.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = join(__dirname, '..', '..', '..');

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), 'utf8'));
}

describe('mazel patch: fork identity', () => {
  it('manifest id is `claudian`, not upstream `realclaudian`', () => {
    const manifest = readJson('manifest.json');
    expect(manifest.id).toBe('claudian');
  });

  it('manifest version matches package version (release guard stays satisfied)', () => {
    const manifest = readJson('manifest.json');
    const pkg = readJson('package.json');
    expect(manifest.version).toBe(pkg.version);
  });

  it('no source file hardcodes the upstream plugin id', () => {
    // A hardcoded `realclaudian` in src/ would resolve the wrong plugin at
    // runtime (app.plugins.getPlugin) and silently disable a feature.
    let hits: string;
    try {
      hits = execFileSync('git', ['grep', '-n', 'realclaudian', '--', 'src'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
    } catch {
      // git grep exits 1 when there is no match — that is the success case.
      hits = '';
    }
    expect(hits.trim()).toBe('');
  });
});

describe('obsolescence guard: fork identity', () => {
  it('upstream still uses a different id (patch still needed)', () => {
    // Read the pristine upstream manifest from git so this guard cannot be
    // fooled by our own working tree.
    let upstreamManifest: string;
    try {
      upstreamManifest = execFileSync('git', ['show', 'origin/main:manifest.json'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
    } catch {
      // origin/main not fetched (shallow or single-branch checkout) — skip
      // rather than fail; the assertions above still cover the patch itself.
      return;
    }
    const upstreamId = (JSON.parse(upstreamManifest) as { id: string }).id;
    expect(upstreamId).not.toBe('claudian');
  });
});
