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
   * plugin.renameConversation(). Upstream's auto-title generator already
   * refuses to overwrite a manual rename, so nothing extra is needed to
   * protect the new name.
   */
  onTabRename?: (tabId: TabId, title: string) => void;

  /**
   * mazel: called when the set of user-named conversations changes, so the host
   * can persist it. Without persistence the badge falls back to its number
   * after a restart while the conversation keeps the name — the two would
   * disagree, and the name would look lost.
   */
  onUserNamedConversationsChanged?: (conversationIds: string[]) => void;
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
  /** mazel: conversations the user named by hand. Keyed on the conversation, not the tab. */
  private userNamedConversationIds = new Set<string>();
  /** mazel: a tab switch held back to see whether a dblclick follows. */
  private pendingClickTimer: number | null = null;
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
    this.userNamedConversationIds.clear();
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
   * mazel: the conversations the user has named by hand.
   *
   * Kept separate from upstream's expandedTitleTabIds on purpose. That set is
   * keyed on the tab and holds a view state; this one is keyed on the
   * conversation and holds an intent that has to outlive the tab.
   */
  getUserNamedConversationIds(): string[] {
    return Array.from(this.userNamedConversationIds);
  }

  setUserNamedConversationIds(conversationIds: readonly string[]): void {
    this.userNamedConversationIds = new Set(conversationIds);
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

    // The badge normally shows a number, so widen it to hold text while the
    // editor is open. Purely visual: no tab-keyed state is touched here, since
    // the name that comes out of this belongs to the conversation.
    badgeEl.addClass('claudian-tab-badge-renaming');
    badgeEl.setAttribute('contenteditable', 'plaintext-only');
    badgeEl.setAttribute('role', 'textbox');
    badgeEl.textContent = originalTitle;

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
      // history list, which is the opposite of what the name was for.
      if (nextTitle.length === 0) {
        if (item.conversationId !== null) {
          this.userNamedConversationIds.delete(item.conversationId);
        }
        badgeEl.textContent = this.getBadgeLabel(item);
        this.callbacks.onUserNamedConversationsChanged?.(this.getUserNamedConversationIds());
        if (replay) this.update(replay);
        return;
      }

      // mazel: an unchanged name still marks the tab as user-named. Confirming
      // the name you already see is a deliberate act, and on a tab that was
      // never named it is the only way to pin the current auto-title.
      if (item.conversationId !== null) {
        this.userNamedConversationIds.add(item.conversationId);
      }

      item.title = nextTitle;
      badgeEl.setAttribute('aria-label', nextTitle);
      badgeEl.textContent = this.getBadgeLabel(item);
      this.callbacks.onUserNamedConversationsChanged?.(this.getUserNamedConversationIds());
      if (nextTitle !== originalTitle) {
        this.callbacks.onTabRename?.(item.id, nextTitle);
      }
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
      return String(item.index);
    }

    return this.truncateExpandedTitle(item.title);
  }

  /** mazel: true if the user gave this tab's conversation a name by hand. */
  private isUserNamed(item: TabBarItem): boolean {
    return item.conversationId !== null
      && this.userNamedConversationIds.has(item.conversationId);
  }

  private truncateExpandedTitle(title: string): string {
    const chars = Array.from(title);
    if (chars.length <= EXPANDED_TITLE_MAX_LENGTH) {
      return title;
    }

    return `${chars.slice(0, EXPANDED_TITLE_MAX_LENGTH - TRUNCATED_TITLE_SUFFIX.length).join('')}${TRUNCATED_TITLE_SUFFIX}`;
  }
}
