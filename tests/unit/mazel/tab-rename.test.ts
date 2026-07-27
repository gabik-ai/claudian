/**
 * Mazel patch: rename a tab inline, on a plain double click.
 *
 * The gesture question, decided 2026-07-27
 * ----------------------------------------
 * Upstream 2.0.x binds `dblclick` on a tab badge to `toggleBadgeTitle()`
 * (expand ↔ collapse the title). Our fork wants the same gesture for renaming.
 * Two features on one gesture is a **semantic** collision: git rebases it
 * cleanly and reports nothing, the build succeeds, the tests pass, and one of
 * the two features quietly stops working. Only one of them can have it.
 *
 * The gesture goes to the rename, and `toggleBadgeTitle()` is removed outright
 * — method and binding. That is a deliberate sacrifice, not an oversight:
 * the toggle only arrived with upstream 2.x and was never part of how this
 * vault is used, while the muscle memory for "double click a tab, type a new
 * name" is older and far stronger. An earlier attempt put the rename on
 * Alt+dblclick to keep both; it worked, and nobody ever hit the modifier.
 *
 * Consequence for the upstream test suite: three of its tests describe the
 * toggle and are deleted rather than bent into shape. A test that is kept
 * green after its behaviour was removed on purpose is worse than no test.
 *
 * Why the marker hangs on the conversation, not on the tab
 * -------------------------------------------------------
 * A badge shows its NUMBER unless the user named it by hand; only then does it
 * show the name. The "named by hand" marker is a set of **conversation** ids
 * (`userNamedConversationIds`), never tab ids. Tab ids are handed out fresh
 * every time a conversation is reopened from history, so a tab-keyed marker
 * would drop the name at exactly the moment the user goes looking for it:
 * close the tab, reopen the conversation, and the name they chose is gone.
 * Upstream's `expandedTitleTabIds` stays tab-keyed on purpose — it holds a
 * view state that is allowed to die with the tab; ours holds an intent that
 * must not.
 *
 * Why a single click waits 220 ms
 * -------------------------------
 * The first half of a double click is a click. Without a delay, every rename
 * would first switch tabs. The switch is therefore held back briefly and
 * cancelled by the dblclick that follows.
 */
import { createMockEl } from '@test/helpers/mockElement';

import { TabBar, type TabBarCallbacks } from '@/features/chat/tabs/TabBar';
import type { TabBarItem } from '@/features/chat/tabs/types';

import { readUpstreamFile } from './upstreamRef';

/** Mirrors SINGLE_CLICK_DELAY_MS in TabBar.ts. */
const SINGLE_CLICK_DELAY_MS = 220;

function createCallbacks(overrides: Partial<TabBarCallbacks> = {}): TabBarCallbacks {
  return {
    onTabClick: jest.fn(),
    onTabClose: jest.fn(),
    onNewTab: jest.fn(),
    onTitleExpansionChanged: jest.fn(),
    onTabRename: jest.fn(),
    onUserNamedConversationsChanged: jest.fn(),
    ...overrides,
  };
}

function createItem(overrides: Partial<TabBarItem> = {}): TabBarItem {
  return {
    id: 'tab-1',
    index: 1,
    conversationId: 'conv-1',
    title: 'Test Tab',
    providerId: 'claude',
    isActive: false,
    isStreaming: false,
    needsAttention: false,
    canClose: true,
    ...overrides,
  };
}

interface Harness {
  bar: TabBar;
  containerEl: ReturnType<typeof createMockEl>;
  callbacks: TabBarCallbacks;
  item: TabBarItem;
}

function setup(itemOverrides: Partial<TabBarItem> = {}, userNamedConversationIds: string[] = []): Harness {
  const containerEl = createMockEl();
  const callbacks = createCallbacks();
  const bar = new TabBar(containerEl, callbacks);
  const item = createItem(itemOverrides);
  bar.setUserNamedConversationIds(userNamedConversationIds);
  bar.update([item]);
  return { bar, containerEl, callbacks, item };
}

function badge(h: Harness, index = 0) {
  return h.containerEl.children[index];
}

function fire(el: ReturnType<typeof createMockEl>, type: string, event: Record<string, unknown> = {}): void {
  const handlers = el._eventListeners.get(type) ?? [];
  for (const handler of handlers) {
    handler({
      type,
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
      ...event,
    });
  }
}

function click(h: Harness): void {
  fire(badge(h), 'click');
}

function dblclick(h: Harness, event: Record<string, unknown> = {}): void {
  fire(badge(h), 'dblclick', event);
}

describe('mazel: the dblclick gesture belongs to the rename', () => {
  it('a plain dblclick starts the rename', () => {
    const h = setup();

    dblclick(h);

    expect(h.bar.isRenaming()).toBe(true);
    expect(badge(h).getAttribute('contenteditable')).toBe('plaintext-only');
    expect(badge(h).textContent).toBe('Test Tab');
  });

  it('a dblclick expands nothing — upstream toggleBadgeTitle is gone, not shadowed', () => {
    const h = setup({ index: 2, title: 'A long tab title' });

    dblclick(h);
    // Leave the editor without committing, so nothing but the toggle could
    // have changed the badge.
    fire(badge(h), 'keydown', { key: 'Escape' });

    expect(badge(h).getAttribute('data-title-expanded')).toBe('false');
    expect(badge(h).hasClass('claudian-tab-badge-expanded')).toBe(false);
    expect(h.callbacks.onTitleExpansionChanged).not.toHaveBeenCalled();
    expect(badge(h).textContent).toBe('2');
  });

  it('a second dblclick does not collapse anything, it just re-enters the editor', () => {
    const h = setup({ index: 2 });

    dblclick(h);
    fire(badge(h), 'keydown', { key: 'Escape' });
    dblclick(h);

    expect(h.bar.isRenaming()).toBe(true);
    expect(badge(h).getAttribute('data-title-expanded')).toBe('false');
  });
});

describe('mazel: a single click must not race the rename', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('a single click switches tabs only after the delay, and never renames', () => {
    const h = setup();

    click(h);

    expect(h.callbacks.onTabClick).not.toHaveBeenCalled();
    expect(h.bar.isRenaming()).toBe(false);

    jest.advanceTimersByTime(SINGLE_CLICK_DELAY_MS);

    expect(h.callbacks.onTabClick).toHaveBeenCalledWith('tab-1');
    expect(h.bar.isRenaming()).toBe(false);
    expect(badge(h).getAttribute('contenteditable')).toBeFalsy();
  });

  it('a dblclick cancels the pending tab switch, so renaming never switches tabs first', () => {
    // This is the whole point of the delay: the first half of a double click
    // is a click, and without the cancel every rename would jump tabs.
    const h = setup();

    click(h);
    dblclick(h);
    jest.advanceTimersByTime(SINGLE_CLICK_DELAY_MS * 4);

    expect(h.callbacks.onTabClick).not.toHaveBeenCalled();
    expect(h.bar.isRenaming()).toBe(true);
  });

  it('destroy() drops a pending switch instead of firing it into a dead view', () => {
    const h = setup();

    click(h);
    h.bar.destroy();
    jest.advanceTimersByTime(SINGLE_CLICK_DELAY_MS * 4);

    expect(h.callbacks.onTabClick).not.toHaveBeenCalled();
  });
});

describe('mazel: the badge shows a number unless the user named it', () => {
  it('an unnamed tab shows its number, a named one shows its name', () => {
    const unnamed = setup({ index: 3, title: 'Auto-generated title' });
    expect(badge(unnamed).textContent).toBe('3');

    const named = setup({ index: 3, title: 'Chosen by hand' }, ['conv-1']);
    expect(badge(named).textContent).toBe('Chosen by hand');
  });

  it('the name follows the CONVERSATION, so reopening it under a new tab id keeps it', () => {
    // The core of the design. A tab reopened from history gets a fresh tab id;
    // a tab-keyed marker would lose the name at exactly that moment.
    const h = setup({ id: 'tab-1', index: 1, title: 'Chosen by hand' }, ['conv-1']);
    expect(badge(h).textContent).toBe('Chosen by hand');

    h.bar.update([
      createItem({ id: 'tab-99', index: 7, conversationId: 'conv-1', title: 'Chosen by hand' }),
    ]);

    expect(badge(h).textContent).toBe('Chosen by hand');
  });

  it('a different conversation in the same session keeps its number', () => {
    const h = setup({ index: 1, title: 'Chosen by hand' }, ['conv-1']);

    h.bar.update([
      createItem({ id: 'tab-1', index: 1, conversationId: 'conv-1', title: 'Chosen by hand' }),
      createItem({ id: 'tab-2', index: 2, conversationId: 'conv-2', title: 'Auto title' }),
    ]);

    expect(badge(h, 0).textContent).toBe('Chosen by hand');
    expect(badge(h, 1).textContent).toBe('2');
  });

  it('a tab without a conversation falls back to its number and does not throw', () => {
    // A blank tab has no conversation to hang a name on. It must render, and
    // renaming it must not blow up on the null.
    const h = setup({ index: 4, conversationId: null, title: 'Blank tab' }, ['conv-1']);

    expect(badge(h).textContent).toBe('4');

    expect(() => {
      dblclick(h);
      badge(h).textContent = 'Named anyway';
      fire(badge(h), 'keydown', { key: 'Enter' });
    }).not.toThrow();

    expect(h.bar.getUserNamedConversationIds()).toEqual(['conv-1']);
    expect(badge(h).textContent).toBe('4');
  });

  it('round-trips the marker set for persistence', () => {
    // The host persists this between restarts. If it did not, the badge would
    // fall back to its number while the conversation kept the name.
    const h = setup();

    h.bar.setUserNamedConversationIds(['conv-a', 'conv-b']);

    expect(h.bar.getUserNamedConversationIds()).toEqual(['conv-a', 'conv-b']);
  });
});

describe('mazel: inline rename', () => {
  function startRename(h: Harness): void {
    dblclick(h);
  }

  it('Enter commits and reports the new title', () => {
    const h = setup();
    startRename(h);

    badge(h).textContent = 'Renamed tab';
    fire(badge(h), 'keydown', { key: 'Enter' });

    expect(h.callbacks.onTabRename).toHaveBeenCalledWith('tab-1', 'Renamed tab');
    expect(h.bar.isRenaming()).toBe(false);
    expect(badge(h).getAttribute('contenteditable')).toBeFalsy();
    expect(badge(h).getAttribute('aria-label')).toBe('Renamed tab');
  });

  it('a commit marks the conversation as user-named, so the badge keeps showing it', () => {
    const h = setup();
    startRename(h);

    badge(h).textContent = 'Renamed tab';
    fire(badge(h), 'keydown', { key: 'Enter' });

    expect(h.callbacks.onUserNamedConversationsChanged).toHaveBeenCalledWith(['conv-1']);
    expect(h.bar.getUserNamedConversationIds()).toEqual(['conv-1']);
    expect(badge(h).textContent).toBe('Renamed tab');
  });

  it('Escape reverts and reports nothing', () => {
    const h = setup();
    startRename(h);

    badge(h).textContent = 'Half-typed nonsense';
    fire(badge(h), 'keydown', { key: 'Escape' });

    expect(h.callbacks.onTabRename).not.toHaveBeenCalled();
    expect(h.callbacks.onUserNamedConversationsChanged).not.toHaveBeenCalled();
    expect(h.bar.isRenaming()).toBe(false);
    // A tab that was never named goes back to its NUMBER, not to its title.
    // Reverting has to undo the editor completely, including the widened label.
    expect(badge(h).textContent).toBe('1');
  });

  it('blur commits, so clicking away does not silently lose the edit', () => {
    const h = setup();
    startRename(h);

    badge(h).textContent = 'Committed on blur';
    fire(badge(h), 'blur');

    expect(h.callbacks.onTabRename).toHaveBeenCalledWith('tab-1', 'Committed on blur');
  });

  it('an empty name drops the user-given name without touching the conversation title', () => {
    // Emptying the field means "take the name away again", not "cancel".
    // The badge goes back to its number and the marker is cleared — but the
    // CONVERSATION title stays as it was, otherwise the history list would be
    // left with a nameless entry, which is the opposite of what a name is for.
    const h = setup({ title: 'Chosen by hand' }, ['conv-1']);
    startRename(h);

    badge(h).textContent = '   ';
    fire(badge(h), 'keydown', { key: 'Enter' });

    expect(h.callbacks.onTabRename).not.toHaveBeenCalled();
    expect(badge(h).textContent).toBe('1');
    expect(h.callbacks.onUserNamedConversationsChanged).toHaveBeenCalledWith([]);
    expect(h.bar.getUserNamedConversationIds()).not.toContain('conv-1');
    expect(h.item.title).toBe('Chosen by hand');
  });

  it('an unchanged name does not fire a pointless rename, but still pins the name', () => {
    // Confirming the name you already see is a deliberate act: on a tab that
    // was never named it is the only way to pin the current auto-title.
    const h = setup();
    startRename(h);

    fire(badge(h), 'keydown', { key: 'Enter' });

    expect(h.callbacks.onTabRename).not.toHaveBeenCalled();
    expect(h.callbacks.onUserNamedConversationsChanged).toHaveBeenCalledWith(['conv-1']);
    expect(badge(h).textContent).toBe('Test Tab');
  });

  it('collapses whitespace instead of storing a ragged title', () => {
    const h = setup();
    startRename(h);

    badge(h).textContent = '  Lots   of\n  space  ';
    fire(badge(h), 'keydown', { key: 'Enter' });

    expect(h.callbacks.onTabRename).toHaveBeenCalledWith('tab-1', 'Lots of space');
  });

  it('ignores keystrokes while an IME is composing', () => {
    // Without the isComposing guard, confirming a Japanese/Chinese candidate
    // with Enter would end the rename instead of inserting the text.
    const h = setup();
    startRename(h);

    badge(h).textContent = 'にほんご';
    fire(badge(h), 'keydown', { key: 'Enter', isComposing: true });

    expect(h.bar.isRenaming()).toBe(true);
    expect(h.callbacks.onTabRename).not.toHaveBeenCalled();
  });

  it('commits only once, no matter how many times the editor settles', () => {
    const h = setup();
    startRename(h);

    badge(h).textContent = 'Once';
    fire(badge(h), 'keydown', { key: 'Enter' });
    fire(badge(h), 'blur');

    expect(h.callbacks.onTabRename).toHaveBeenCalledTimes(1);
  });
});

describe('mazel: rename survives the constant tab-bar churn', () => {
  it('update() does not rebuild the badge mid-rename', () => {
    // update() fires on every streaming and attention change, i.e. constantly
    // while a tab is working. A rebuild would yank the editor out from under
    // the cursor.
    const h = setup();
    dblclick(h);
    const editingBadge = badge(h);

    h.bar.update([createItem({ isStreaming: true }), createItem({ id: 'tab-2', index: 2 })]);

    expect(badge(h)).toBe(editingBadge);
    expect(h.bar.isRenaming()).toBe(true);
    expect(h.containerEl.children).toHaveLength(1);
  });

  it('replays the deferred update once the rename settles', () => {
    const h = setup();
    dblclick(h);

    h.bar.update([createItem(), createItem({ id: 'tab-2', index: 2, title: 'Second' })]);
    fire(badge(h), 'keydown', { key: 'Escape' });

    // The tab that appeared during the rename must not be lost.
    expect(h.containerEl.children).toHaveLength(2);
  });
});

describe('obsolescence guard: tab rename', () => {
  /**
   * What this watches, and why it has to be watched by hand.
   *
   * Our patch does two things to upstream's badge event wiring:
   *   1. it takes `dblclick` away from `toggleBadgeTitle()` and gives it to the
   *      inline rename, deleting the method;
   *   2. it puts upstream's direct `onTabClick(item.id)` behind a 220 ms timer
   *      so the dblclick can cancel it.
   *
   * Both are edits to lines upstream owns. If upstream reworks that wiring —
   * moves the rename in itself, drops the toggle, or introduces its own click
   * timing — git will still rebase our hunks or report a conflict we resolve by
   * reflex, and the result compiles either way. Nothing but this guard notices.
   *
   * Each assertion below therefore names the upstream fact our patch depends
   * on. A red line here is not a broken test: it is "upstream changed the
   * ground under the patch, go re-read the diff".
   */
  it('upstream still has no rename, still owns dblclick, and still clicks without a delay', () => {
    const upstream = readUpstreamFile('src/features/chat/tabs/TabBar.ts');
    if (upstream === null) return;

    // Upstream has not implemented renaming itself, so the patch still earns
    // its keep. Red = check whether ours can simply be dropped.
    expect(upstream).not.toContain('onTabRename');

    // The dblclick binding is the line we overwrite. Red = the anchor moved.
    expect(upstream).toContain("addEventListener('dblclick'");

    // The behaviour we deliberately sacrificed. Red = upstream dropped it too,
    // so the sacrifice note above is stale and the conflict is gone.
    expect(upstream).toContain('toggleBadgeTitle');

    // Upstream switches tabs straight out of the click handler, with no timer
    // of its own. Red = upstream added click timing and our 220 ms delay has
    // to be re-reconciled instead of simply wrapping their call.
    expect(upstream).toContain('this.callbacks.onTabClick(item.id);');
    expect(upstream).not.toContain('setTimeout');
  });

  it('upstream still ships a TabBarItem that knows nothing about its conversation', () => {
    const upstreamTypes = readUpstreamFile('src/features/chat/tabs/types.ts');
    if (upstreamTypes === null) return;

    // Scoped to the interface on purpose: `conversationId` appears all over
    // this file (TabData, PersistedTabState, callbacks). Only its absence on
    // TabBarItem is the fact we depend on.
    const tabBarItem = upstreamTypes.match(/export interface TabBarItem \{[\s\S]*?\n\}/)?.[0];

    // Red = the interface was renamed or restructured; our added field has to
    // be re-placed by hand.
    expect(tabBarItem).toBeDefined();

    // The field is ours. If upstream adds one of the same name with different
    // semantics, the two merge silently and the badge starts keying on
    // somebody else's value.
    expect(tabBarItem).not.toContain('conversationId');
  });
});
