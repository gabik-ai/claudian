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

  // mazel: conversations the user named by hand.
  //
  // Deliberately NOT filtered against the open tabs, unlike expandedTitleTabIds
  // above. That filter is right for a view state that dies with its tab; it
  // would be wrong here, because the whole point of the name is to find a
  // CLOSED conversation again in the history list. Filtering would delete the
  // name of every conversation the moment its tab is closed.
  const userNamedConversationIds: string[] = [];
  const seenNamedConversationIds = new Set<string>();
  if (Array.isArray(data.userNamedConversationIds)) {
    for (const conversationId of data.userNamedConversationIds) {
      if (
        typeof conversationId !== 'string'
        || conversationId.length === 0
        || seenNamedConversationIds.has(conversationId)
      ) {
        continue;
      }

      userNamedConversationIds.push(conversationId);
      seenNamedConversationIds.add(conversationId);
    }
  }

  return {
    openTabs,
    activeTabId: typeof data.activeTabId === 'string' ? data.activeTabId : null,
    ...(expandedTitleTabIds.length > 0 ? { expandedTitleTabIds } : {}),
    ...(userNamedConversationIds.length > 0 ? { userNamedConversationIds } : {}),
  };
}
