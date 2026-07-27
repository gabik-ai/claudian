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
    // Whatever a button shows must match reality: one stuck on "stop" after its
    // stream ended is worse than no button, because clicking it does nothing.
    //
    // Compared PER TAB, and that correction matters. This check used to take
    // `querySelector('.claudian-send-stop-btn')` — one arbitrary button, the
    // first in document order — and compare it against
    // `querySelector('.claudian-tab-badge-streaming')`, i.e. "is ANY tab
    // streaming". With one tab that is the same question. With three tabs where
    // two stream and one idles it is guaranteed to disagree with itself, and it
    // reported red while every button was in fact correct. That false red is
    // what the 2026-07-27 handover recorded as "der sichtbare Knopf stand
    // während eines laufenden Streams auf Send message" — a broken assertion
    // wearing the costume of a broken button.
    let view = null;
    app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view && leaf.view.tabManager) view = leaf.view;
    });
    if (!view) return { ok: false, error: 'no Claudian view — open a Claudian tab first' };

    const mismatches = [];
    let checked = 0;
    for (const [tabId, tab] of view.tabManager.tabs) {
      const wrapper = tab && tab.dom && tab.dom.inputWrapper;
      if (!wrapper) continue;
      const btn = wrapper.querySelector('.claudian-send-stop-btn');
      if (!btn) {
        mismatches.push({ tabId, error: 'tab has no send/stop button' });
        continue;
      }
      checked += 1;
      const state = btn.getAttribute('data-state');
      const streaming = Boolean(tab.state && tab.state.isStreaming);
      const expected = streaming ? 'stop' : 'send';
      if (state !== expected) mismatches.push({ tabId, state, expected, streaming });
    }

    if (!checked) return { ok: false, error: 'no composer carried a send/stop button' };
    return { ok: mismatches.length === 0, checked, ...(mismatches.length ? { mismatches } : {}) };
  });

  check('exactly ONE send/stop control per composer', () => {
    // The bug this exists for: ui-fixes.js (the 1.3.72-era runtime patch) kept
    // injecting a full-width `.claudian-send-button` into every composer after
    // the fork grew its own button. Two stacked controls, both live, both
    // wired to different mechanisms. It shipped because every check asked "is
    // the button there?" and none asked "is it the ONLY one?".
    const legacy = document.querySelectorAll('.claudian-send-button').length;
    if (legacy > 0) {
      return { ok: false, error: `${legacy}x legacy .claudian-send-button — ui-fixes.js Fix 1 injiziert wieder`, legacy };
    }
    // One per composer, not one in total: hidden tabs carry their own.
    const composers = document.querySelectorAll('.claudian-input-wrapper').length;
    const buttons = document.querySelectorAll('.claudian-send-stop-btn').length;
    return { ok: composers === buttons, composers, buttons };
  });

  check('send/stop button carries the two-tone colour logic', () => {
    // Colour is the whole point of this control: dark = idle, orange = running.
    // A theme or a refactor that flattens both states to one colour removes the
    // only at-a-glance signal that a turn is still going.
    //
    // BOTH states are asserted positively, and that is not pedantry. The first
    // version of this check only tested "streaming => orange" and let the idle
    // state pass on "not orange". Its own negative control exposed it: painting
    // an idle button purple kept the check green, because purple is indeed not
    // orange. Purple-when-idle is precisely the regression this exists to
    // catch — the check would have been decoration.
    // Caveat for whoever debugs a surprising red here: the button carries
    // `transition: background 0.15s`, and getComputedStyle reports the CURRENT
    // frame of a running transition, not the target. Sampled within ~150ms of a
    // state flip it returns a blend (measured: rgb(171,101,150) halfway from
    // orange to purple) and neither branch below matches. At rest it is exact.
    // Let the UI settle before trusting a red from this check.
    const isOrange = (m) => m.length >= 3 && +m[0] > 180 && +m[1] > 90 && +m[1] < 160 && +m[2] < 130;
    // Neutral means the three channels sit close together, whatever the theme's
    // shade of grey. Purple rgb(120,80,220) spreads 140 and fails; the
    // rgb(54,54,54) this ships with spreads 0.
    const isNeutralDark = (m) => {
      if (m.length < 3) return false;
      const [r, g, b] = m.slice(0, 3).map(Number);
      return Math.max(r, g, b) - Math.min(r, g, b) < 20 && Math.max(r, g, b) < 110;
    };

    // Asserted as an INVERSION, both channels, because that is the actual
    // contract Gabriel specified on 2026-07-27: whatever is the plate in one
    // state is the glyph in the other. Testing the background alone would pass
    // a button whose plate flips while the glyph stays put — which looks broken
    // and reads as one colour with a mystery symbol on it.
    const wrong = [];
    let checked = 0;
    document.querySelectorAll('.claudian-send-stop-btn').forEach((btn, i) => {
      const cs = getComputedStyle(btn);
      const bgm = (cs.backgroundColor.match(/\d+/g) || []);
      const fgm = (cs.color.match(/\d+/g) || []);
      // Fully transparent means the element is in a torn-down tab; skip rather
      // than invent a verdict about a button nobody can see.
      if (bgm.length >= 4 && Number(bgm[3]) === 0) return;
      checked += 1;
      const streaming = btn.classList.contains('claudian-send-stop-btn--streaming');
      const good = streaming
        ? isOrange(bgm) && isNeutralDark(fgm)
        : isNeutralDark(bgm) && isOrange(fgm);
      if (!good) {
        wrong.push({
          i,
          streaming,
          bg: cs.backgroundColor,
          fg: cs.color,
          expected: streaming ? 'orange plate, dark glyph' : 'dark plate, orange glyph',
        });
      }
    });

    if (!checked) return { ok: false, error: 'no send/stop button with a resolvable background' };
    return { ok: wrong.length === 0, checked, ...(wrong.length ? { wrong } : {}) };
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
