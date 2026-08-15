import type { AppTabManagerState } from '../providers/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeTabManagerState(data: unknown): AppTabManagerState | null {
  if (!isRecord(data) || !Array.isArray(data.openTabs)) {
    return null;
  }

  const openTabs: AppTabManagerState['openTabs'] = [];
  const openTabIds = new Set<string>();
  for (const tab of data.openTabs) {
    if (!isRecord(tab) || typeof tab.tabId !== 'string') {
      continue;
    }

    openTabs.push({
      tabId: tab.tabId,
      conversationId: typeof tab.conversationId === 'string' ? tab.conversationId : null,
      ...(typeof tab.draftModel === 'string'
        ? { draftModel: tab.draftModel }
        : {}),
      // mazel: a user-given name still waiting for its conversation.
      ...(typeof tab.pendingTitle === 'string' && tab.pendingTitle.length > 0
        ? { pendingTitle: tab.pendingTitle }
        : {}),
    });
    openTabIds.add(tab.tabId);
  }

  const expandedTitleTabIds: string[] = [];
  const seenExpandedTabIds = new Set<string>();
  if (Array.isArray(data.expandedTitleTabIds)) {
    for (const tabId of data.expandedTitleTabIds) {
      if (
        typeof tabId !== 'string'
        || !openTabIds.has(tabId)
        || seenExpandedTabIds.has(tabId)
      ) {
        continue;
      }

      expandedTitleTabIds.push(tabId);
      seenExpandedTabIds.add(tabId);
    }
  }

  // mazel: userNamedConversationIds used to be parsed here. The marker now
  // lives on each conversation (manuallyRenamed) — one truth instead of a
  // parallel set that could drift. Old entries in data.json are simply
  // ignored.

  return {
    openTabs,
    activeTabId: typeof data.activeTabId === 'string' ? data.activeTabId : null,
    ...(expandedTitleTabIds.length > 0 ? { expandedTitleTabIds } : {}),
  };
}
