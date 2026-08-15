import { scheduleAnimationFrame } from '../../../utils/animationFrame';
import type { TabBarItem, TabId } from './types';

const EXPANDED_TITLE_MAX_LENGTH = 32;
const TRUNCATED_TITLE_SUFFIX = '...';

/**
 * mazel: how long a single click waits to see whether it is really the first
 * half of a double click. Carried over unchanged from the pre-fork behaviour,
 * where it was tuned by use rather than guessed.
 */
const SINGLE_CLICK_DELAY_MS = 220;

/** Callbacks for TabBar interactions. */
export interface TabBarCallbacks {
  /** Called when a tab badge is clicked. */
  onTabClick: (tabId: TabId) => void;

  /** Called when the close button is clicked on a tab. */
  onTabClose: (tabId: TabId) => void;

  /** Called when the new tab button is clicked. */
  onNewTab: () => void;

  /** Called when badge title expansion state changes. */
  onTitleExpansionChanged?: (expandedTitleTabIds: TabId[]) => void;

  /**
   * mazel: called when the user renames a tab inline.
   *
   * The title lives on the conversation, so the host maps this onto
   * plugin.renameConversation() — or, on a tab that has no conversation yet,
   * parks it as the tab's pending name. Upstream's auto-title generator
   * already refuses to overwrite a manual rename, so nothing extra is needed
   * to protect the new name. Fired on every non-empty commit, including an
   * unchanged one: confirming the name you already see is the deliberate act
   * that pins it.
   */
  onTabRename?: (tabId: TabId, title: string) => void;

  /**
   * mazel: called when the user empties the field — "take the name away
   * again". The host clears the conversation's manuallyRenamed marker (or the
   * tab's pending name); the badge falls back to its number on the next
   * update.
   */
  onTabRenameCleared?: (tabId: TabId) => void;

  /**
   * mazel: called when a badge is dropped on another one. The dragged tab is
   * placed directly before the tab it was dropped on.
   */
  onTabReorder?: (fromTabId: TabId, toTabId: TabId) => void;
}

/**
 * TabBar renders minimal numbered badge navigation.
 */
export class TabBar {
  private containerEl: HTMLElement;
  private callbacks: TabBarCallbacks;
  private expandedTitleTabIds = new Set<TabId>();
  /** mazel: the tab currently being renamed inline, if any. */
  private renamingTabId: TabId | null = null;
  /** mazel: items that arrived while a rename was in progress. */
  private deferredItems: TabBarItem[] | null = null;
  /** mazel: a tab switch held back to see whether a dblclick follows. */
  private pendingClickTimer: number | null = null;
  /** mazel: the badge currently being dragged, if any. */
  private draggedTabId: TabId | null = null;
  /**
   * mazel: display numbers, frozen the first time a tab is seen.
   *
   * Without this, the number is just the position in the list, so dragging a
   * tab renumbers it and every tab it passed. The number would then be a
   * description of the current order rather than a name for the tab, and the
   * whole point of dragging (put my tab where I want it, keep calling it 3)
   * would be lost.
   */
  private stableTabNumbers = new Map<TabId, number>();
  private lastKnownScrollLeft = 0;
  private readonly handleScroll = (): void => {
    this.captureScrollPosition();
  };

  constructor(containerEl: HTMLElement, callbacks: TabBarCallbacks) {
    this.containerEl = containerEl;
    this.callbacks = callbacks;
    this.build();
  }

  /** Builds the tab bar UI. */
  private build(): void {
    this.containerEl.addClass('claudian-tab-badges');
    this.containerEl.addEventListener('scroll', this.handleScroll);
  }

  /**
   * Updates the tab bar with new tab data.
   * @param items Tab items to render.
   */
  update(items: TabBarItem[]): void {
    // mazel: update() rebuilds every badge from scratch, and it fires on any
    // streaming/attention change — i.e. constantly. Doing that mid-rename would
    // yank the editor out from under the cursor. Defer instead, and replay the
    // latest items once the rename settles.
    if (this.renamingTabId !== null) {
      this.deferredItems = items;
      return;
    }

    this.captureStableScrollPosition();
    this.pruneExpandedTitleState(items);
    // mazel: must run BEFORE the badges are rendered, otherwise a closed tab
    // keeps its number reserved for one more frame and a new tab is pushed to
    // a higher number than it needs.
    this.pruneStableNumbers(items);

    // Clear existing badges
    this.containerEl.empty();

    // Render badges
    for (const item of items) {
      this.renderBadge(item);
    }

    this.restoreScrollPosition();
  }

  getExpandedTitleTabIds(): TabId[] {
    return Array.from(this.expandedTitleTabIds);
  }

  setExpandedTitleTabIds(tabIds: readonly TabId[]): void {
    this.expandedTitleTabIds = new Set(tabIds);
  }

  /** Renders a single tab badge. */
  private renderBadge(item: TabBarItem): void {
    // Determine state class (priority: active > attention > streaming > idle)
    let stateClass = 'claudian-tab-badge-idle';
    if (item.isActive) {
      stateClass = 'claudian-tab-badge-active';
    } else if (item.needsAttention) {
      stateClass = 'claudian-tab-badge-attention';
    } else if (item.isStreaming) {
      stateClass = 'claudian-tab-badge-streaming';
    }

    const isTitleExpanded = this.expandedTitleTabIds.has(item.id);
    const badgeEl = this.containerEl.createDiv({
      cls: [
        'claudian-tab-badge',
        stateClass,
        isTitleExpanded ? 'claudian-tab-badge-expanded' : '',
      ].filter(Boolean).join(' '),
      text: this.getBadgeLabel(item),
    });

    // Obsidian uses aria-label for hover tooltips here; adding title causes duplicate tooltip text.
    badgeEl.setAttribute('aria-label', item.title);
    badgeEl.setAttribute('data-provider', item.providerId);
    badgeEl.setAttribute('data-title-expanded', isTitleExpanded ? 'true' : 'false');

    // Click handler to switch tab.
    //
    // mazel: a single click must not fire when the user is on their way to a
    // double click, otherwise every rename first switches tabs. The switch is
    // therefore held back briefly and cancelled by the dblclick that follows.
    // The delay is the one the fork has always used; it is long enough for a
    // deliberate double click and short enough to feel immediate.
    badgeEl.addEventListener('click', () => {
      if (this.renamingTabId === item.id) return;
      this.clearPendingClick();
      this.pendingClickTimer = window.setTimeout(() => {
        this.pendingClickTimer = null;
        this.captureScrollPosition();
        this.callbacks.onTabClick(item.id);
      }, SINGLE_CLICK_DELAY_MS);
    });

    badgeEl.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();

      // mazel: plain dblclick renames. Upstream binds toggleBadgeTitle here
      // (expand ↔ collapse the title); that binding and the method are gone on
      // purpose, decided 2026-07-27. It arrived with 2.x, was never used here,
      // and the muscle memory for renaming is older and stronger. Two features
      // on one gesture is a semantic collision: git rebases it cleanly, the
      // build passes, the tests pass, and one of the two silently stops
      // working. Only one of them gets the gesture.
      this.clearPendingClick();
      this.beginRename(item, badgeEl);
    });

    // mazel: reordering by dragging a badge onto another one.
    //
    // Native HTML5 drag rather than pointer maths, because the badges sit in a
    // horizontally scrolling strip: the browser handles autoscroll at the edges
    // and the drag image for free, and both are fiddly to reproduce by hand.
    badgeEl.setAttribute('draggable', 'true');

    badgeEl.addEventListener('dragstart', (e: DragEvent) => {
      this.draggedTabId = item.id;
      // A drag that starts from a click must not also switch tabs when it ends.
      this.clearPendingClick();
      badgeEl.addClass('claudian-tab-badge-dragging');
      e.dataTransfer?.setData('text/plain', item.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });

    badgeEl.addEventListener('dragover', (e: DragEvent) => {
      if (this.draggedTabId === null || this.draggedTabId === item.id) return;
      // Without preventDefault the browser refuses the drop outright, and the
      // drop handler below is simply never called.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      badgeEl.addClass('claudian-tab-badge-drag-over');
    });

    badgeEl.addEventListener('dragleave', () => {
      badgeEl.removeClass('claudian-tab-badge-drag-over');
    });

    badgeEl.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      badgeEl.removeClass('claudian-tab-badge-drag-over');
      const fromTabId = this.draggedTabId;
      this.draggedTabId = null;
      if (fromTabId === null || fromTabId === item.id) return;
      this.callbacks.onTabReorder?.(fromTabId, item.id);
    });

    badgeEl.addEventListener('dragend', () => {
      // Runs even when the drop happened outside any badge, so this is the one
      // place guaranteed to clear the drag state. Without it a cancelled drag
      // leaves the badge at 40 % opacity for good.
      badgeEl.removeClass('claudian-tab-badge-dragging');
      badgeEl.removeClass('claudian-tab-badge-drag-over');
      this.draggedTabId = null;
    });

    // Right-click to close (if allowed)
    if (item.canClose) {
      badgeEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.callbacks.onTabClose(item.id);
      });
    }
  }

  /** Destroys the tab bar. */
  destroy(): void {
    this.containerEl.empty();
    this.containerEl.removeClass('claudian-tab-badges');
    this.containerEl.removeEventListener('scroll', this.handleScroll);
    this.expandedTitleTabIds.clear();
    this.renamingTabId = null;
    this.deferredItems = null;
    this.clearPendingClick();
    this.stableTabNumbers.clear();
    this.draggedTabId = null;
    this.lastKnownScrollLeft = 0;
  }

  captureScrollPosition(): void {
    this.lastKnownScrollLeft = this.containerEl.scrollLeft;
  }

  restoreScrollPosition(): void {
    const scrollLeft = this.lastKnownScrollLeft;
    this.containerEl.scrollLeft = scrollLeft;
    if (scrollLeft <= 0) return;

    scheduleAnimationFrame(() => {
      if (this.containerEl.scrollLeft !== 0) return;
      this.containerEl.scrollLeft = scrollLeft;
    }, this.containerEl.ownerDocument.defaultView ?? null);
  }

  private captureStableScrollPosition(): void {
    const currentScrollLeft = this.containerEl.scrollLeft;
    if (currentScrollLeft > 0 || this.lastKnownScrollLeft === 0) {
      this.lastKnownScrollLeft = currentScrollLeft;
    }
  }

  private pruneExpandedTitleState(items: TabBarItem[]): void {
    const visibleTabIds = new Set(items.map(item => item.id));
    for (const tabId of this.expandedTitleTabIds) {
      if (!visibleTabIds.has(tabId)) {
        this.expandedTitleTabIds.delete(tabId);
      }
    }
  }

  /**
   * mazel: cancels a click that is still waiting to see whether a second one
   * follows. Called by dblclick, by destroy(), and before an inline rename.
   */
  private clearPendingClick(): void {
    if (this.pendingClickTimer === null) return;
    window.clearTimeout(this.pendingClickTimer);
    this.pendingClickTimer = null;
  }

  /**
   * mazel: turns the badge into an inline editor.
   *
   * contenteditable rather than a modal, because the badge is already showing
   * the title at this point and a modal would move the user's eye away from it.
   */
  private beginRename(item: TabBarItem, badgeEl: HTMLElement): void {
    if (this.renamingTabId !== null) return;
    this.renamingTabId = item.id;

    const originalTitle = item.title;

    // What the field starts with: the name the USER gave this tab, or nothing.
    // Never the auto-generated conversation title.
    //
    // It used to open prefilled with `item.title`, which for an unnamed tab is
    // the model's own summary — "Implement Vault Context Diet Phase A". So a
    // double click on a numbered badge produced a long sentence the user never
    // asked for, and the first keystroke had to clear it. This matches the
    // pre-fork behaviour exactly, which seeded the field with
    // `customLabel || ''` (ui-fixes.js Fix 5). Gabriel's words on 2026-07-27:
    // the auto name is not needed, and if it is kept it has to fit.
    const seedTitle = this.isUserNamed(item) ? originalTitle : '';

    // The badge normally shows a number, so widen it to hold text while the
    // editor is open. Purely visual: no tab-keyed state is touched here, since
    // the name that comes out of this belongs to the conversation.
    badgeEl.addClass('claudian-tab-badge-renaming');
    badgeEl.setAttribute('contenteditable', 'plaintext-only');
    badgeEl.setAttribute('role', 'textbox');
    badgeEl.textContent = seedTitle;

    this.selectAll(badgeEl);
    badgeEl.focus();

    let settled = false;
    const finish = (commit: boolean): void => {
      if (settled) return;
      settled = true;

      const nextTitle = (badgeEl.textContent ?? '').replace(/\s+/g, ' ').trim();

      badgeEl.removeAttribute('contenteditable');
      badgeEl.removeAttribute('role');
      badgeEl.removeClass('claudian-tab-badge-renaming');
      this.renamingTabId = null;
      const replay = this.deferredItems;
      this.deferredItems = null;

      if (!commit) {
        badgeEl.textContent = this.getBadgeLabel(item);
        if (replay) this.update(replay);
        return;
      }

      // mazel: an empty field is not a cancel, it is "drop the name I gave
      // this". The badge goes back to its number. The CONVERSATION title stays
      // exactly as it was — clearing it too would leave a nameless entry in the
      // history list, which is the opposite of what the name was for. The host
      // owns the marker (manuallyRenamed / pending name), so it is told and
      // the item is only adjusted for the immediate repaint.
      if (nextTitle.length === 0) {
        const hadName = item.userNamed;
        item.userNamed = false;
        badgeEl.textContent = this.getBadgeLabel(item);
        if (hadName) this.callbacks.onTabRenameCleared?.(item.id);
        if (replay) this.update(replay);
        return;
      }

      // mazel: every non-empty commit is reported, including an unchanged one.
      // Confirming the name you already see is a deliberate act, and on a tab
      // that was never named it is the only way to pin the current auto-title.
      // The item is patched locally so the badge is right before the host's
      // refresh arrives; the truth itself lives with the host.
      item.userNamed = true;
      item.title = nextTitle;
      badgeEl.setAttribute('aria-label', nextTitle);
      badgeEl.textContent = this.getBadgeLabel(item);
      this.callbacks.onTabRename?.(item.id, nextTitle);
      if (replay) this.update(replay);
    };

    badgeEl.addEventListener('keydown', (event: KeyboardEvent) => {
      // isComposing guards IME input (Chinese, Japanese, Korean).
      if (event.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    });

    badgeEl.addEventListener('blur', () => finish(true));
    // Clicking inside the editor must not switch tabs.
    badgeEl.addEventListener('click', (event: MouseEvent) => {
      if (this.renamingTabId === item.id) event.stopPropagation();
    });
  }

  private selectAll(el: HTMLElement): void {
    const view = el.ownerDocument?.defaultView;
    const selection = view?.getSelection?.();
    if (!selection || typeof el.ownerDocument.createRange !== 'function') return;
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /** mazel: true while an inline rename is in progress. */
  isRenaming(): boolean {
    return this.renamingTabId !== null;
  }

  private getBadgeLabel(item: TabBarItem): string {
    // mazel: a tab the user named shows that name. Everything else shows its
    // number — deliberately, because the alternative is every badge showing an
    // auto-generated title and the numbering becoming useless.
    if (this.isUserNamed(item)) {
      return this.truncateExpandedTitle(item.title);
    }

    if (!this.expandedTitleTabIds.has(item.id)) {
      return String(this.getStableNumber(item));
    }

    return this.truncateExpandedTitle(item.title);
  }

  /**
   * mazel: the number a tab keeps for as long as it is open.
   *
   * Assigned on first sight and never recalculated, so reordering leaves every
   * number where it was. A new tab takes its current position, exactly as
   * before the fork — and only if that number is already taken does it fall
   * back to the lowest free one.
   *
   * That fallback is the one deliberate departure. The pre-fork version took
   * the position unconditionally, so closing the middle of three tabs and
   * opening a new one handed out a number that was still in use: two badges
   * labelled 3. Keeping a defect is not the same as keeping behaviour.
   *
   * The fallback is a collision escape, NOT a compaction pass: with tabs 1 and
   * 2 closed and 3 still open, a new tab becomes 2 and the free 1 stays free.
   * Renumbering to close that gap would move a number the user is already
   * reading, which is the very thing this map exists to prevent.
   */
  private getStableNumber(item: TabBarItem): number {
    const existing = this.stableTabNumbers.get(item.id);
    if (existing !== undefined) return existing;

    const taken = new Set(this.stableTabNumbers.values());
    let candidate = item.index;
    if (taken.has(candidate)) {
      candidate = 1;
      while (taken.has(candidate)) candidate += 1;
    }

    this.stableTabNumbers.set(item.id, candidate);
    return candidate;
  }

  /** mazel: forgets the numbers of tabs that are gone, so they can be reused. */
  private pruneStableNumbers(items: TabBarItem[]): void {
    const visible = new Set(items.map(item => item.id));
    for (const tabId of this.stableTabNumbers.keys()) {
      if (!visible.has(tabId)) this.stableTabNumbers.delete(tabId);
    }
  }

  /** mazel: true if the user gave this tab a name by hand. Computed upstream
   * of the bar (TabManager reads the conversation's manuallyRenamed flag), so
   * the bar holds no name state of its own. */
  private isUserNamed(item: TabBarItem): boolean {
    return item.userNamed;
  }

  private truncateExpandedTitle(title: string): string {
    const chars = Array.from(title);
    if (chars.length <= EXPANDED_TITLE_MAX_LENGTH) {
      return title;
    }

    return `${chars.slice(0, EXPANDED_TITLE_MAX_LENGTH - TRUNCATED_TITLE_SUFFIX.length).join('')}${TRUNCATED_TITLE_SUFFIX}`;
  }
}
