/*
 * Runtime DOM assertions, executed inside a running Obsidian via
 *   obsidian eval --json "$(cat bin/runtime-assertions.js)"
 *
 * A clean rebase proves the patch text still applied. Only this file proves the
 * patch still *does* anything. Every check returns either `true` or an object
 * explaining what it saw, so a failure is readable without a second round trip.
 *
 * Deliberately DOM-assertions, not screenshots: ~0.3k tokens instead of ~12k,
 * and deterministic instead of interpretable.
 */
(() => {
  const results = {};
  const check = (name, fn) => {
    try {
      results[name] = fn();
    } catch (error) {
      results[name] = { ok: false, error: String(error && error.message ? error.message : error) };
    }
  };

  check('plugin loaded under id `claudian`', () => {
    const plugin = app.plugins.getPlugin('claudian');
    if (!plugin) {
      return { ok: false, loaded: Object.keys(app.plugins.plugins || {}).filter((id) => /claudian/i.test(id)) };
    }
    return { ok: true, version: plugin.manifest && plugin.manifest.version };
  });

  check('view type `claudian-view` registered', () => {
    // The release build is minified, so the class name is gone. The view type
    // string is the only stable handle.
    const leaves = app.workspace.getLeavesOfType('claudian-view');
    return { ok: leaves.length > 0, leaves: leaves.length };
  });

  const toolbar = document.querySelector('.claudian-input-toolbar');

  check('input toolbar present', () => ({ ok: Boolean(toolbar) }));

  check('M2: MCP selector left of external-context selector', () => {
    if (!toolbar) return { ok: false, error: 'no toolbar in DOM — open a Claudian tab first' };
    const children = Array.from(toolbar.children);
    const mcp = children.findIndex((el) => el.classList.contains('claudian-mcp-selector'));
    const ext = children.findIndex((el) => el.classList.contains('claudian-external-context-selector'));
    return { ok: mcp >= 0 && ext >= 0 && mcp < ext, mcpIndex: mcp, externalIndex: ext };
  });

  check('M1: context meter never prints a four-digit k value', () => {
    const meter = document.querySelector('.claudian-context-meter');
    if (!meter) return { ok: false, error: 'context meter not rendered — send one message first' };
    const tooltip = meter.getAttribute('data-tooltip') || '';
    if (!tooltip) return { ok: false, error: 'meter has no tooltip yet (no usage data)' };
    return { ok: !/\b\d{4,}k\b/.test(tooltip), tooltip };
  });

  check('send/stop button present and in a sane state', () => {
    const btn = document.querySelector('.claudian-send-stop-btn');
    if (!btn) return { ok: false, error: 'no send/stop button — open a Claudian tab first' };
    const state = btn.getAttribute('data-state');
    // Whatever it shows must match reality: a button stuck on "stop" after the
    // stream ended is worse than no button, because clicking it does nothing.
    const streaming = Boolean(document.querySelector('.claudian-tab-badge-streaming'));
    return { ok: state === (streaming ? 'stop' : 'send'), state, streaming };
  });

  check('tab badges still respond to plain dblclick (upstream toggle intact)', () => {
    // Our rename sits on Alt+dblclick precisely so this stays upstream's.
    const badge = document.querySelector('.claudian-tab-badge');
    if (!badge) return { ok: false, error: 'no tab badge in DOM' };
    return { ok: badge.hasAttribute('data-title-expanded') };
  });

  check('composer footer mount point exists (companion plugin target)', () => {
    // Upstream 2.0.x moved the header actions into the composer footer. The
    // usage-bar companion plugin mounts here; if this class ever disappears
    // again, the bar silently mounts into nothing.
    const mount = document.querySelector('.claudian-input-nav-actions');
    return { ok: Boolean(mount) };
  });

  return results;
})();
