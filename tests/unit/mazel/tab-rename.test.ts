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
 * Where the "named by hand" truth lives, re-decided 2026-08-15
 * -----------------------------------------------------------
 * A badge shows its NUMBER unless the user named it by hand; only then does it
 * show the name. The marker used to be a set of conversation ids inside the
 * bar (`userNamedConversationIds`), persisted separately — a second truth next
 * to the conversation's own `manuallyRenamed` flag, and the two drifted: after
 * /clear the inherited rename set `manuallyRenamed` on the NEW conversation,
 * the set still held the OLD id, and the badge fell back to its number even
 * though the name had been carried over correctly.
 *
 * Now the bar holds no name state at all. `TabBarItem.userNamed` is computed
 * by the TabManager from the conversation's `manuallyRenamed` flag (plus the
 * tab's pendingTitle while no conversation exists), and the bar merely
 * displays it. One truth, no drift. The bar reports intent upward via
 * onTabRename / onTabRenameCleared and patches its local item only for the
 * immediate repaint.
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
    onTabRenameCleared: jest.fn(),
    ...overrides,
  };
}

function createItem(overrides: Partial<TabBarItem> = {}): TabBarItem {
  return {
    id: 'tab-1',
    index: 1,
    userNamed: false,
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

function setup(itemOverrides: Partial<TabBarItem> = {}): Harness {
  const containerEl = createMockEl();
  const callbacks = createCallbacks();
  const bar = new TabBar(containerEl, callbacks);
  const item = createItem(itemOverrides);
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
  it('a plain dblclick starts the rename with an EMPTY field on an unnamed tab', () => {
    // Geändert am 2026-07-27. Vorher öffnete das Feld mit `item.title`, und
    // das ist bei einem unbenannten Tab der Auto-Titel des Modells, also ein
    // ganzer Satz ("Implement Vault Context Diet Phase A"). Ein Doppelklick auf
    // eine Ziffer erzeugte damit einen langen Namen, den niemand verlangt hat,
    // und die erste Taste musste ihn erst weglöschen.
    // Die Vorfassung im Vault füllte `currentLabel || ''` (ui-fixes.js Fix 5,
    // `input.value` in Zeile 407) — leer, wenn es keinen eigenen Namen gab.
    const h = setup();

    dblclick(h);

    expect(h.bar.isRenaming()).toBe(true);
    expect(badge(h).getAttribute('contenteditable')).toBe('plaintext-only');
    expect(badge(h).textContent).toBe('');
  });

  it('a dblclick on a tab the user DID name opens with that name, ready to edit', () => {
    // Gegenstück zum Test darüber, sonst beweist "leer" nichts: die
    // Vorbelegung darf nicht generell weg sein, sie darf nur den Auto-Titel
    // nicht mehr einsetzen. Einen selbst gegebenen Namen zu korrigieren, ohne
    // ihn neu tippen zu müssen, ist der Normalfall.
    const h = setup({ userNamed: true });

    dblclick(h);

    expect(h.bar.isRenaming()).toBe(true);
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

    const named = setup({ index: 3, title: 'Chosen by hand', userNamed: true });
    expect(badge(named).textContent).toBe('Chosen by hand');
  });

  it('the bar holds no name state — userNamed on the item is the whole truth', () => {
    // The core of the redesign. The old bar kept its own set of "named"
    // conversation ids; after /clear the set still held the OLD conversation
    // id while the name had moved to the NEW one, and the badge fell back to
    // its number. Now the item says userNamed and the badge follows, whoever
    // computed it and whatever conversation is behind it.
    const h = setup({ id: 'tab-1', index: 1, title: 'Chosen by hand', userNamed: true });
    expect(badge(h).textContent).toBe('Chosen by hand');

    // Same tab, new conversation behind it (as after /clear + first message):
    // the manager recomputes userNamed from the new conversation, the bar
    // simply renders what it is told.
    h.bar.update([
      createItem({ id: 'tab-1', index: 1, title: 'Chosen by hand', userNamed: true }),
    ]);
    expect(badge(h).textContent).toBe('Chosen by hand');

    // And when the truth says the name is gone, the number comes back.
    h.bar.update([
      createItem({ id: 'tab-1', index: 1, title: 'Auto title', userNamed: false }),
    ]);
    expect(badge(h).textContent).toBe('1');
  });

  it('a named tab does not infect its neighbours', () => {
    const h = setup({ index: 1, title: 'Chosen by hand', userNamed: true });

    h.bar.update([
      createItem({ id: 'tab-1', index: 1, title: 'Chosen by hand', userNamed: true }),
      createItem({ id: 'tab-2', index: 2, title: 'Auto title' }),
    ]);

    expect(badge(h, 0).textContent).toBe('Chosen by hand');
    expect(badge(h, 1).textContent).toBe('2');
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

  it('a commit shows the name immediately, before the host refresh arrives', () => {
    // The truth lives with the host (manuallyRenamed / pendingTitle), but the
    // repaint must not wait for the round trip: the bar patches its local item
    // and the badge shows the name in the same tick.
    const h = setup();
    startRename(h);

    badge(h).textContent = 'Renamed tab';
    fire(badge(h), 'keydown', { key: 'Enter' });

    expect(badge(h).textContent).toBe('Renamed tab');
    expect(h.item.userNamed).toBe(true);
  });

  it('renaming a tab WITHOUT a conversation works the same way', () => {
    // The old design silently dropped this rename (`if (!conversationId)
    // return`) — the user typed a name, hit Enter, and the number came back.
    // Now the bar reports it like any other rename and the host parks it as
    // the tab's pending name until the conversation exists.
    const h = setup({ index: 4, title: 'New Chat' });

    dblclick(h);
    badge(h).textContent = 'Named before first message';
    fire(badge(h), 'keydown', { key: 'Enter' });

    expect(h.callbacks.onTabRename).toHaveBeenCalledWith('tab-1', 'Named before first message');
    expect(badge(h).textContent).toBe('Named before first message');
  });

  it('Escape reverts and reports nothing', () => {
    const h = setup();
    startRename(h);

    badge(h).textContent = 'Half-typed nonsense';
    fire(badge(h), 'keydown', { key: 'Escape' });

    expect(h.callbacks.onTabRename).not.toHaveBeenCalled();
    expect(h.callbacks.onTabRenameCleared).not.toHaveBeenCalled();
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

  it('an empty name drops the user-given name and tells the host', () => {
    // Emptying the field means "take the name away again", not "cancel".
    // The badge goes back to its number; the host clears the marker
    // (manuallyRenamed / pendingTitle). The CONVERSATION title stays as it
    // was, otherwise the history list would be left with a nameless entry,
    // which is the opposite of what a name is for — that restraint lives in
    // clearManualRename, which never touches the title.
    const h = setup({ title: 'Chosen by hand', userNamed: true });
    startRename(h);

    badge(h).textContent = '   ';
    fire(badge(h), 'keydown', { key: 'Enter' });

    expect(h.callbacks.onTabRename).not.toHaveBeenCalled();
    expect(h.callbacks.onTabRenameCleared).toHaveBeenCalledWith('tab-1');
    expect(badge(h).textContent).toBe('1');
    expect(h.item.title).toBe('Chosen by hand');
  });

  it('confirming the empty field on a never-named tab pins nothing and clears nothing', () => {
    // Umgeschrieben am 2026-07-27, zusammen mit der leeren Vorbelegung.
    //
    // Vorher hieß dieser Test "pinnt trotzdem den Namen": das Feld öffnete
    // mit dem Auto-Titel, Enter bestätigte ihn, und der Tab trug ab da einen
    // Satz als Namen. Das war der letzte Weg, auf dem ein Auto-Titel dauerhaft
    // ins Badge kam — und damit genau das, was am 2026-07-27 weg sollte.
    // Jetzt ist Enter auf dem leeren Feld ein Nicht-Ereignis: die Ziffer
    // bleibt, und der Host wird nicht mit einem Clear behelligt, das nichts
    // zu tun hätte.
    const h = setup();
    startRename(h);

    fire(badge(h), 'keydown', { key: 'Enter' });

    expect(h.callbacks.onTabRename).not.toHaveBeenCalled();
    expect(h.callbacks.onTabRenameCleared).not.toHaveBeenCalled();
    expect(badge(h).textContent).toBe('1');
  });

  it('confirming an unchanged name on a NAMED tab re-reports it — pinning is a commit', () => {
    // Geändert am 2026-08-15. Vorher wurde ein unveränderter Name NICHT
    // gemeldet; das Pinnen lief über die bar-eigene Set. Die Set ist weg,
    // also ist der Report der einzige Weg, die Absicht beim Host ankommen zu
    // lassen — renameConversation mit unverändertem Titel ist idempotent.
    const h = setup({ userNamed: true });
    dblclick(h);

    fire(badge(h), 'keydown', { key: 'Enter' });

    expect(h.callbacks.onTabRename).toHaveBeenCalledWith('tab-1', 'Test Tab');
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

  it('upstream still ships a TabBarItem that knows nothing about user naming', () => {
    const upstreamTypes = readUpstreamFile('src/features/chat/tabs/types.ts');
    if (upstreamTypes === null) return;

    // Scoped to the interface on purpose: only TabBarItem carries our field.
    const tabBarItem = upstreamTypes.match(/export interface TabBarItem \{[\s\S]*?\n\}/)?.[0];

    // Red = the interface was renamed or restructured; our added field has to
    // be re-placed by hand.
    expect(tabBarItem).toBeDefined();

    // The field is ours. If upstream adds one of the same name with different
    // semantics, the two merge silently and the badge starts keying on
    // somebody else's value.
    expect(tabBarItem).not.toContain('userNamed');

    // And upstream's TabData knows no pendingTitle — ours parks a user-given
    // name there while the tab has no conversation.
    expect(upstreamTypes).not.toContain('pendingTitle');
  });
});
