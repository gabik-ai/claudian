/**
 * Mazel patch M9: the running build must be observable from outside Obsidian.
 *
 * Why it exists: patch M8 lives in `main.js`, Obsidian reads `main.js` once at
 * plugin load, and `bin/deploy.sh --no-reload` is mandatory when Claudian
 * deploys itself. On 2026-07-29 the file carried M8 since 00:43 while the
 * process had loaded the pre-M8 build at 22:51 the night before, and a blocked
 * answer still appeared twice at 17:29. Every file-level check was green.
 *
 * The beacon records WHICH main.js the process executed.
 * `.claude/scripts/stil-block-marker-check.py --laufend` compares it with disk.
 */
import {
  type BeaconAdapter,
  buildRuntimeBeacon,
  RUNTIME_BEACON_PATH,
  writeRuntimeBeacon,
} from '@/core/bootstrap/runtimeBeacon';

function createAdapter(overrides: Partial<BeaconAdapter> = {}): {
  adapter: BeaconAdapter;
  written: Array<[string, string]>;
  mkdirs: string[];
} {
  const written: Array<[string, string]> = [];
  const mkdirs: string[] = [];
  const adapter: BeaconAdapter = {
    stat: async () => ({ size: 3294901, mtime: 1785282237000 }),
    write: async (path, data) => {
      written.push([path, data]);
    },
    mkdir: async (path) => {
      mkdirs.push(path);
    },
    exists: async () => true,
    ...overrides,
  };
  return { adapter, written, mkdirs };
}

describe('mazel patch M9: runtime beacon', () => {
  it('stamps size and mtime of the main.js it actually loaded', async () => {
    const { adapter, written } = createAdapter();

    const beacon = await writeRuntimeBeacon(
      adapter,
      '.obsidian/plugins/claudian',
      '2.0.41',
      () => new Date('2026-07-29T16:00:00.000Z'),
    );

    expect(beacon).toEqual({
      mainJsSize: 3294901,
      mainJsMtime: 1785282237000,
      version: '2.0.41',
      loadedAt: '2026-07-29T16:00:00.000Z',
    });
    expect(written).toHaveLength(1);
    expect(written[0][0]).toBe(RUNTIME_BEACON_PATH);
    expect(JSON.parse(written[0][1])).toEqual(beacon);
  });

  it('reads main.js from the manifest directory, trailing slash or not', async () => {
    const seen: string[] = [];
    const { adapter } = createAdapter({
      stat: async (path) => {
        seen.push(path);
        return { size: 1, mtime: 2 };
      },
    });

    await writeRuntimeBeacon(adapter, '.obsidian/plugins/claudian/', '2.0.41');
    expect(seen).toEqual(['.obsidian/plugins/claudian/main.js']);
  });

  it('creates .claudian when it does not exist yet', async () => {
    const { adapter, mkdirs } = createAdapter({ exists: async () => false });
    await writeRuntimeBeacon(adapter, '.obsidian/plugins/claudian', '2.0.41');
    expect(mkdirs).toEqual(['.claudian']);
  });

  it('never throws when the adapter fails: a diagnostic must not break the load', async () => {
    const { adapter } = createAdapter({
      write: async () => {
        throw new Error('read-only volume');
      },
    });
    await expect(writeRuntimeBeacon(adapter, '.obsidian/plugins/claudian', '2.0.41'))
      .resolves.toBeNull();
  });

  it('writes nothing when main.js cannot be stat-ed', async () => {
    const { adapter, written } = createAdapter({ stat: async () => null });
    expect(await writeRuntimeBeacon(adapter, '.obsidian/plugins/claudian', '2.0.41')).toBeNull();
    expect(written).toHaveLength(0);
  });

  it('changes its stamp when main.js changes: that is the whole signal', () => {
    const alt = buildRuntimeBeacon({ size: 100, mtime: 1 }, '2.0.41', 'x');
    const neu = buildRuntimeBeacon({ size: 100, mtime: 2 }, '2.0.41', 'x');
    expect(alt).not.toEqual(neu);
  });
});
