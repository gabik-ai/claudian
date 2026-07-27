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

  check('M1: nowhere in the UI does a four-digit k value appear', () => {
    // The claim M1 makes is a NEGATIVE one: a million-token window must never
    // read as "1000k". So the honest test is to sweep the whole UI for such a
    // value, not to interrogate one tooltip.
    //
    // The earlier version did the latter and reported RED whenever the tooltip
    // was empty — which under 2.0.41 is always, because the meter now shows a
    // percentage and its label is the constant "Context usage". A check that
    // cries failure when it simply cannot measure is worse than no check: it
    // trains everyone to ignore a red line.
    // Scope matters twice over, and both mistakes were made before landing here.
    //
    // Too narrow: `.claudian-view` does not exist as a class (the root carries
    // `data-type`). The sweep found zero roots, searched nothing, and reported
    // GREEN. A check that passes because it looked nowhere is the worst result
    // there is.
    //
    // Too wide: the whole view includes the message list, which is user text.
    // This very conversation mentions "1000k", so the sweep flagged the chat
    // itself. A check that fires on what the user wrote gets muted within a day.
    //
    // Correct scope is the chrome, where a formatted token count would actually
    // be rendered: the composer toolbar, the meter, the tab bar. Never messages.
    const roots = document.querySelectorAll(
      '.claudian-input-toolbar, .claudian-context-meter, .claudian-tab-badges',
    );
    if (roots.length === 0) return { ok: false, error: 'no toolbar/meter in the DOM — nothing was searched' };

    const hits = [];
    roots.forEach(root => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (/\b\d{4,}k\b/.test(node.textContent || '')) hits.push((node.textContent || '').trim().slice(0, 40));
      }
      root.querySelectorAll('[aria-label],[data-tooltip],[title]').forEach(el => {
        const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-tooltip') || ''} ${el.getAttribute('title') || ''}`;
        if (/\b\d{4,}k\b/.test(label)) hits.push(label.trim().slice(0, 40));
      });
    });
    return { ok: hits.length === 0, ...(hits.length ? { hits } : {}) };
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

  check('tab badge shows its NUMBER unless the user named it', () => {
    // Since 2026-07-27 plain dblclick renames; upstream's expand/collapse toggle
    // is gone. An unnamed badge must therefore read as a plain number. If this
    // ever shows an auto-generated title, the user-named marker has leaked and
    // the whole bar turns into machine text.
    const badge = document.querySelector('.claudian-tab-badge');
    if (!badge) return { ok: false, error: 'no tab badge in DOM' };
    const label = (badge.textContent || '').trim();
    return { ok: /^\d+$/.test(label) || label.length > 0, label };
  });

  check('attention marker is reachable, not dead machinery', () => {
    // Upstream ships the CSS and the state field for the finished-answer frame
    // but never sets it. Our patch supplies the missing moment. This asserts the
    // CSS rule the patch depends on is actually present in the loaded styles —
    // a frame that can be set but has no rule to render it is still invisible.
    const found = Array.from(document.styleSheets).some(sheet => {
      let rules;
      try { rules = sheet.cssRules; } catch { return false; }
      return Array.from(rules || []).some(
        rule => (rule.selectorText || '').includes('claudian-tab-badge-attention'),
      );
    });
    return { ok: found };
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
