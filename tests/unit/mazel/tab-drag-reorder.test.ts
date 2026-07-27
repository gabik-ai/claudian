/**
 * Mazel patch: Tab-Badges per Ziehen umsortieren, plus stabile Anzeige-Nummern.
 *
 * Was upstream fehlt
 * ------------------
 * Upstream 2.0.41 hat am Badge GAR KEIN Ziehen: kein `draggable`, keine
 * Drag-Handler, keine Reorder-Methode im TabManager. Die Reihenfolge der Tabs
 * ist dort ausschliesslich die Reihenfolge, in der sie angelegt wurden. Der
 * Patch baut das Verhalten von vor dem Fork nach.
 *
 * Drei Teile, drei Testbloecke
 * ----------------------------
 *   A) `TabBar` verdrahtet die HTML5-Drag-Events und meldet die Geste als
 *      `onTabReorder(fromTabId, toTabId)` nach oben. Die Leiste sortiert nichts
 *      selbst — sie kennt die Reihenfolge gar nicht, sie bekommt sie geliefert.
 *   B) `TabBar` friert die Anzeige-Nummer eines Tabs beim ersten Sehen ein.
 *      Ohne das waere die Nummer nur die Position in der Liste, und Umsortieren
 *      wuerde alles umnummerieren — der Sinn des Ziehens ("mein Tab 3 soll
 *      woanders stehen und weiter 3 heissen") waere weg.
 *   C) `TabManager.reorderTabs` baut die `tabs`-Map neu auf. Die Map-Reihenfolge
 *      IST die Tab-Reihenfolge und wird von `getPersistedState()` gelesen, also
 *      ueberlebt die neue Sortierung den Neustart ohne zusaetzliches Feld.
 *
 * Die zwei Fallen, die hier explizit getestet werden
 * --------------------------------------------------
 *   1. `preventDefault()` im `dragover`. Ohne den Aufruf verweigert der Browser
 *      den Drop komplett und der `drop`-Handler wird nie aufgerufen. Das Ziehen
 *      sieht dann aus, als funktioniere es, und nichts passiert.
 *   2. Der Off-by-one in `reorderTabs`. Die Zielposition wird erst NACH dem
 *      Herausnehmen der Quelle bestimmt. Bestimmt man sie vorher, landet der Tab
 *      eine Position zu weit rechts — aber nur beim Ziehen von links nach
 *      rechts. So eine Asymmetrie ueberlebt jeden schnellen Handtest.
 *
 * Testaufbau
 * ----------
 * Teil A und B nutzen den `createMockEl`-Harness aus `tab-rename.test.ts`.
 * Teil C nutzt die Mock-Umgebung aus
 * `tests/unit/features/chat/tabs/TabManager.test.ts`, so wie `tab-attention.test.ts`
 * es vormacht.
 */
import { createMockEl } from '@test/helpers/mockElement';

import { TabBar, type TabBarCallbacks } from '@/features/chat/tabs/TabBar';
import { TabManager } from '@/features/chat/tabs/TabManager';
import { DEFAULT_MAX_TABS, type TabBarItem, type TabManagerCallbacks } from '@/features/chat/tabs/types';

import { readUpstreamFile } from './upstreamRef';

/** Spiegelt SINGLE_CLICK_DELAY_MS in TabBar.ts. */
const SINGLE_CLICK_DELAY_MS = 220;

const DRAGGING_CLASS = 'claudian-tab-badge-dragging';
const DRAG_OVER_CLASS = 'claudian-tab-badge-drag-over';

// ============================================================
// Mocks fuer Teil C (Vorlage: tests/unit/features/chat/tabs/TabManager.test.ts)
// ============================================================

const mockCreateTab = jest.fn();
const mockDestroyTab = jest.fn().mockResolvedValue(undefined);
const mockActivateTab = jest.fn();
const mockDeactivateTab = jest.fn();
const mockInitializeTabUI = jest.fn();
const mockInitializeTabControllers = jest.fn();
const mockInitializeTabService = jest.fn().mockResolvedValue(undefined);
const mockOnProviderAvailabilityChanged = jest.fn().mockReturnValue(false);
const mockRefreshTabWorkspaceServices = jest.fn();
const mockSetupServiceCallbacks = jest.fn();
const mockRecycleTabRuntime = jest.fn().mockResolvedValue(undefined);
const mockWireTabInputEvents = jest.fn();
const mockGetTabTitle = jest.fn().mockReturnValue('Test Tab');

jest.mock('@/features/chat/tabs/Tab', () => ({
  createTab: (...args: any[]) => mockCreateTab(...args),
  destroyTab: (...args: any[]) => mockDestroyTab(...args),
  activateTab: (...args: any[]) => mockActivateTab(...args),
  deactivateTab: (...args: any[]) => mockDeactivateTab(...args),
  initializeTabUI: (...args: any[]) => mockInitializeTabUI(...args),
  initializeTabControllers: (...args: any[]) => mockInitializeTabControllers(...args),
  initializeTabService: (...args: any[]) => mockInitializeTabService(...args),
  onProviderAvailabilityChanged: (...args: any[]) => mockOnProviderAvailabilityChanged(...args),
  refreshTabWorkspaceServices: (...args: any[]) => mockRefreshTabWorkspaceServices(...args),
  setupServiceCallbacks: (...args: any[]) => mockSetupServiceCallbacks(...args),
  recycleTabRuntime: (...args: any[]) => mockRecycleTabRuntime(...args),
  wireTabInputEvents: (...args: any[]) => mockWireTabInputEvents(...args),
  getTabTitle: (...args: any[]) => mockGetTabTitle(...args),
}));

jest.mock('@/core/providers/ProviderRegistry', () => ({
  ProviderRegistry: {
    createChatRuntime: jest.fn(),
    getConversationHistoryService: () => ({ buildForkProviderState: jest.fn() }),
    getCapabilities: jest.fn().mockReturnValue({
      providerId: 'claude',
      supportsPersistentRuntime: true,
      supportsNativeHistory: true,
      supportsPlanMode: true,
      supportsRewind: true,
      supportsFork: true,
      supportsProviderCommands: true,
      supportsImageAttachments: true,
      supportsInstructionMode: true,
      supportsMcpTools: true,
      reasoningControl: 'effort',
    }),
    resolveProviderForModel: () => 'claude',
  },
}));

jest.mock('@/core/providers/ProviderWorkspaceRegistry', () => ({
  ProviderWorkspaceRegistry: {
    ensureInitialized: jest.fn().mockResolvedValue(undefined),
    getIfInitialized: () => ({}),
    getCommandCatalog: () => null,
    getRuntimeCommandLoader: () => null,
    getTabWarmupPolicy: () => null,
    setServices: jest.fn(),
  },
}));

jest.mock('@/core/providers/ProviderSettingsCoordinator', () => ({
  ProviderSettingsCoordinator: {
    getProviderSettingsSnapshot: () => ({}),
  },
}));

// ============================================================
// Harness Teil A + B: die Tab-Leiste
// ============================================================

function createCallbacks(overrides: Partial<TabBarCallbacks> = {}): TabBarCallbacks {
  return {
    onTabClick: jest.fn(),
    onTabClose: jest.fn(),
    onNewTab: jest.fn(),
    onTitleExpansionChanged: jest.fn(),
    onTabRename: jest.fn(),
    onUserNamedConversationsChanged: jest.fn(),
    onTabReorder: jest.fn(),
    ...overrides,
  };
}

function createItem(overrides: Partial<TabBarItem> = {}): TabBarItem {
  return {
    id: 'tab-a',
    index: 1,
    conversationId: 'conv-a',
    title: 'Test Tab',
    providerId: 'claude',
    isActive: false,
    isStreaming: false,
    needsAttention: false,
    canClose: true,
    ...overrides,
  };
}

/** Die drei Standard-Tabs A, B, C in genau dieser Reihenfolge. */
function threeItems(): TabBarItem[] {
  return [
    createItem({ id: 'tab-a', index: 1, conversationId: 'conv-a' }),
    createItem({ id: 'tab-b', index: 2, conversationId: 'conv-b' }),
    createItem({ id: 'tab-c', index: 3, conversationId: 'conv-c' }),
  ];
}

interface Harness {
  bar: TabBar;
  containerEl: ReturnType<typeof createMockEl>;
  callbacks: TabBarCallbacks;
}

function setup(items: TabBarItem[] = threeItems(), userNamedConversationIds: string[] = []): Harness {
  const containerEl = createMockEl();
  const callbacks = createCallbacks();
  const bar = new TabBar(containerEl, callbacks);
  bar.setUserNamedConversationIds(userNamedConversationIds);
  bar.update(items);
  return { bar, containerEl, callbacks };
}

function badge(h: Harness, index = 0) {
  return h.containerEl.children[index];
}

/** Die Beschriftungen aller Badges in Anzeige-Reihenfolge. */
function labels(h: Harness): string[] {
  return h.containerEl.children.map((el: ReturnType<typeof createMockEl>) => el.textContent);
}

/**
 * Feuert ein Event auf allen Handlern des Elements und gibt das Event-Objekt
 * zurueck, damit `preventDefault` danach geprueft werden kann. Das ist der
 * einzige Unterschied zum `fire()` aus `tab-rename.test.ts`.
 */
function fire(
  el: ReturnType<typeof createMockEl>,
  type: string,
  event: Record<string, unknown> = {},
): { preventDefault: jest.Mock; stopPropagation: jest.Mock; [key: string]: unknown } {
  const dispatched = {
    type,
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
    ...event,
  };
  const handlers = el._eventListeners.get(type) ?? [];
  for (const handler of handlers) {
    handler(dispatched);
  }
  return dispatched as { preventDefault: jest.Mock; stopPropagation: jest.Mock; [key: string]: unknown };
}

/** Ein DataTransfer-Doppel, das nur kann, was die Handler anfassen. */
function makeDataTransfer() {
  return { setData: jest.fn(), effectAllowed: '', dropEffect: '' };
}

function dragstart(h: Harness, index: number) {
  return fire(badge(h, index), 'dragstart', { dataTransfer: makeDataTransfer() });
}

function dragover(h: Harness, index: number) {
  return fire(badge(h, index), 'dragover', { dataTransfer: makeDataTransfer() });
}

function drop(h: Harness, index: number) {
  return fire(badge(h, index), 'drop', { dataTransfer: makeDataTransfer() });
}

// ============================================================
// A) Die Geste: HTML5-Drag auf dem Badge
// ============================================================

describe('mazel: a tab badge can be dragged', () => {
  it('marks every badge as draggable', () => {
    // Ohne dieses Attribut startet der Browser gar keinen Drag, und keiner der
    // Handler unten wuerde je aufgerufen.
    const h = setup();

    expect(h.containerEl.children).toHaveLength(3);
    for (const el of h.containerEl.children) {
      expect(el.getAttribute('draggable')).toBe('true');
    }
  });

  it('dragstart marks the dragged badge and only that one', () => {
    const h = setup();

    dragstart(h, 2);

    expect(badge(h, 2).hasClass(DRAGGING_CLASS)).toBe(true);
    expect(badge(h, 0).hasClass(DRAGGING_CLASS)).toBe(false);
    expect(badge(h, 1).hasClass(DRAGGING_CLASS)).toBe(false);
  });

  it('dragstart hands the tab id to the DataTransfer and asks for a move', () => {
    const h = setup();

    const event = dragstart(h, 1);

    expect((event.dataTransfer as ReturnType<typeof makeDataTransfer>).setData)
      .toHaveBeenCalledWith('text/plain', 'tab-b');
    expect((event.dataTransfer as ReturnType<typeof makeDataTransfer>).effectAllowed).toBe('move');
  });

  it('dragover on ANOTHER badge marks it as the drop target', () => {
    const h = setup();

    dragstart(h, 2);
    dragover(h, 0);

    expect(badge(h, 0).hasClass(DRAG_OVER_CLASS)).toBe(true);
  });

  it('dragover calls preventDefault — without it the browser refuses the drop outright', () => {
    // Die klassische Falle bei HTML5-Drag. Ein `dragover` ohne
    // `preventDefault()` heisst fuer den Browser "hier darf nichts abgelegt
    // werden": der `drop`-Handler wird dann NIE aufgerufen. Nichts an der
    // Oberflaeche verraet das, das Ziehen sieht bloss wirkungslos aus.
    const h = setup();

    dragstart(h, 2);
    const event = dragover(h, 0);

    expect(event.preventDefault).toHaveBeenCalled();
    expect((event.dataTransfer as ReturnType<typeof makeDataTransfer>).dropEffect).toBe('move');
  });

  it('dragover on the DRAGGED badge itself marks nothing and allows nothing', () => {
    // Ein Tab auf sich selbst zu ziehen ist keine Umsortierung. Er darf weder
    // als Ziel aufleuchten noch einen Drop erlauben.
    const h = setup();

    dragstart(h, 2);
    const event = dragover(h, 2);

    expect(badge(h, 2).hasClass(DRAG_OVER_CLASS)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('dragover without a preceding dragstart does nothing', () => {
    // Etwas anderes wird ueber die Leiste gezogen (eine Datei, ein Link). Die
    // Badges duerfen darauf nicht reagieren.
    const h = setup();

    const event = dragover(h, 1);

    expect(badge(h, 1).hasClass(DRAG_OVER_CLASS)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('dragleave takes the drop-target mark off again', () => {
    const h = setup();

    dragstart(h, 2);
    dragover(h, 0);
    expect(badge(h, 0).hasClass(DRAG_OVER_CLASS)).toBe(true);

    fire(badge(h, 0), 'dragleave');

    expect(badge(h, 0).hasClass(DRAG_OVER_CLASS)).toBe(false);
  });

  it('drop on another badge reports the reorder exactly once', () => {
    const h = setup();

    dragstart(h, 2);
    dragover(h, 0);
    const event = drop(h, 0);

    expect(h.callbacks.onTabReorder).toHaveBeenCalledTimes(1);
    expect(h.callbacks.onTabReorder).toHaveBeenCalledWith('tab-c', 'tab-a');
    // Ohne preventDefault im drop navigiert der Browser bei manchen Nutzlasten
    // die Ansicht weg.
    expect(event.preventDefault).toHaveBeenCalled();
    expect(badge(h, 0).hasClass(DRAG_OVER_CLASS)).toBe(false);
  });

  it('drop on the DRAGGED badge itself reports nothing', () => {
    const h = setup();

    dragstart(h, 1);
    drop(h, 1);

    expect(h.callbacks.onTabReorder).not.toHaveBeenCalled();
  });

  it('a second drop without a new dragstart reports nothing', () => {
    // Der Drop setzt den Zustand zurueck. Bliebe er stehen, wuerde ein Drop,
    // der zu einem laengst beendeten Zug gehoert, eine zweite Umsortierung
    // ausloesen.
    const h = setup();

    dragstart(h, 2);
    drop(h, 0);
    drop(h, 1);

    expect(h.callbacks.onTabReorder).toHaveBeenCalledTimes(1);
  });

  it('dragend clears both marks and resets the state, even without any drop', () => {
    // Ein abgebrochener Zug (Escape, Loslassen neben der Leiste) feuert nur
    // `dragend`. Ohne das Aufraeumen dort bliebe das Badge dauerhaft auf 40 %
    // Deckkraft stehen.
    const h = setup();

    dragstart(h, 2);
    dragover(h, 1);
    fire(badge(h, 2), 'dragend');

    expect(badge(h, 2).hasClass(DRAGGING_CLASS)).toBe(false);

    // Der Zustand ist wirklich zurueckgesetzt und nicht bloss die Klasse weg:
    // ein dragover danach findet keine Quelle mehr vor.
    const afterwards = dragover(h, 0);
    expect(badge(h, 0).hasClass(DRAG_OVER_CLASS)).toBe(false);
    expect(afterwards.preventDefault).not.toHaveBeenCalled();

    // Und ein Drop nach dem Abbruch sortiert nichts um.
    drop(h, 0);
    expect(h.callbacks.onTabReorder).not.toHaveBeenCalled();
  });

  it('dragend also clears a drop-target mark left on the badge it fires at', () => {
    // Badge B war eben noch Drop-Ziel (Zug abgebrochen, kein dragleave). Wird
    // es danach selbst gezogen, muss sein dragend BEIDE Klassen abraeumen —
    // sonst behaelt es den Akzentrahmen fuer den Rest der Sitzung.
    const h = setup();

    dragstart(h, 0);
    dragover(h, 1);
    fire(badge(h, 0), 'dragend');
    expect(badge(h, 1).hasClass(DRAG_OVER_CLASS)).toBe(true);

    dragstart(h, 1);
    fire(badge(h, 1), 'dragend');

    expect(badge(h, 1).hasClass(DRAGGING_CLASS)).toBe(false);
    expect(badge(h, 1).hasClass(DRAG_OVER_CLASS)).toBe(false);
  });
});

describe('mazel: dragging must not trigger the tab switch it started as', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('dragstart cancels the pending tab switch from the mousedown-click', () => {
    // Jeder Zug beginnt mit einem Klick auf das Badge, und der Klick haelt seit
    // dem Rename-Patch einen 220-ms-Timer fuer den Tabwechsel bereit. Ohne den
    // Abbruch hier wuerde jedes Umsortieren zuerst den Tab wechseln.
    const h = setup();

    fire(badge(h, 2), 'click');
    dragstart(h, 2);
    jest.advanceTimersByTime(SINGLE_CLICK_DELAY_MS * 4);

    expect(h.callbacks.onTabClick).not.toHaveBeenCalled();
  });

  it('a click without a drag still switches after the delay', () => {
    // Negativ-Kontrolle zum Test darueber: der Abbruch darf nicht den normalen
    // Klick mit erschlagen.
    const h = setup();

    fire(badge(h, 2), 'click');
    jest.advanceTimersByTime(SINGLE_CLICK_DELAY_MS);

    expect(h.callbacks.onTabClick).toHaveBeenCalledWith('tab-c');
  });
});

// ============================================================
// B) Stabile Anzeige-Nummern
// ============================================================

describe('mazel: a tab keeps its number while it is open', () => {
  it('three tabs show 1, 2, 3', () => {
    const h = setup();

    expect(labels(h)).toEqual(['1', '2', '3']);
  });

  it('reordering moves the badges but leaves every number where it was', () => {
    // Der Kern-Test. Nach dem Ziehen stehen die Badges in neuer Reihenfolge,
    // tragen aber ihre alten Nummern. Waere die Nummer bloss die Position,
    // wuerde jedes Ziehen den gezogenen Tab UND alle ueberholten umbenennen —
    // und "mein Tab 3" waere ein Name, auf den man sich nicht verlassen kann.
    const h = setup();
    expect(labels(h)).toEqual(['1', '2', '3']);

    // C nach ganz vorne: neue Reihenfolge C, A, B.
    h.bar.update([
      createItem({ id: 'tab-c', index: 1, conversationId: 'conv-c' }),
      createItem({ id: 'tab-a', index: 2, conversationId: 'conv-a' }),
      createItem({ id: 'tab-b', index: 3, conversationId: 'conv-b' }),
    ]);

    expect(labels(h)).toEqual(['3', '1', '2']);
  });

  it('survives repeated reorders without drifting', () => {
    const h = setup();

    for (let round = 0; round < 3; round++) {
      h.bar.update([
        createItem({ id: 'tab-b', index: 1, conversationId: 'conv-b' }),
        createItem({ id: 'tab-c', index: 2, conversationId: 'conv-c' }),
        createItem({ id: 'tab-a', index: 3, conversationId: 'conv-a' }),
      ]);
      expect(labels(h)).toEqual(['2', '3', '1']);

      h.bar.update(threeItems());
      expect(labels(h)).toEqual(['1', '2', '3']);
    }
  });

  it('a new tab takes the number the closed middle tab freed up', () => {
    // Bewusste Abweichung vom Alt-Verhalten. Frueher bekam ein neuer Tab seine
    // POSITION als Nummer: nach dem Schliessen der 2 von dreien hiess der neue
    // Tab 3 — genau wie der, der schon 3 hiess. Zwei Badges mit derselben
    // Nummer sind kein Verhalten, das man erhaelt, sondern ein Fehler.
    const h = setup();
    expect(labels(h)).toEqual(['1', '2', '3']);

    // B schliessen. A und C behalten 1 und 3, es gibt jetzt eine Luecke.
    h.bar.update([
      createItem({ id: 'tab-a', index: 1, conversationId: 'conv-a' }),
      createItem({ id: 'tab-c', index: 2, conversationId: 'conv-c' }),
    ]);
    expect(labels(h)).toEqual(['1', '3']);

    // Neuer Tab D. Seine Position waere 3, frei ist aber die 2.
    h.bar.update([
      createItem({ id: 'tab-a', index: 1, conversationId: 'conv-a' }),
      createItem({ id: 'tab-c', index: 2, conversationId: 'conv-c' }),
      createItem({ id: 'tab-d', index: 3, conversationId: 'conv-d' }),
    ]);

    expect(labels(h)).toEqual(['1', '3', '2']);
    expect(new Set(labels(h)).size).toBe(3); // keine doppelte Nummer
  });

  it('hands out fresh numbers after every tab was closed', () => {
    const h = setup();

    h.bar.update([]);
    h.bar.update([createItem({ id: 'tab-z', index: 1, conversationId: 'conv-z' })]);

    expect(labels(h)).toEqual(['1']);
  });

  it('a tab the user named keeps showing its name, not a number', () => {
    const h = setup(threeItems(), ['conv-b']);

    expect(labels(h)).toEqual(['1', 'Test Tab', '3']);

    // Auch nach dem Umsortieren bleibt der Name ein Name.
    h.bar.update([
      createItem({ id: 'tab-b', index: 1, conversationId: 'conv-b' }),
      createItem({ id: 'tab-a', index: 2, conversationId: 'conv-a' }),
      createItem({ id: 'tab-c', index: 3, conversationId: 'conv-c' }),
    ]);

    expect(labels(h)).toEqual(['Test Tab', '1', '3']);
  });

  it('destroy() forgets the frozen numbers', () => {
    const h = setup();
    h.bar.destroy();

    h.bar.update([
      createItem({ id: 'tab-c', index: 1, conversationId: 'conv-c' }),
      createItem({ id: 'tab-a', index: 2, conversationId: 'conv-a' }),
    ]);

    expect(labels(h)).toEqual(['1', '2']);
  });
});

// ============================================================
// Harness Teil C: der TabManager
// ============================================================

function createMockTabData(id: string): any {
  const raw = {
    isStreaming: false,
    hasPendingConversationSave: false,
    isSwitchingConversation: false,
    isRewinding: false,
    needsAttention: false,
    messages: [] as unknown[],
    currentConversationId: null as string | null,
  };

  return {
    id,
    lifecycleState: 'blank',
    hydrationState: 'ready',
    providerId: 'claude',
    conversationId: null,
    service: null,
    serviceInitialized: false,
    state: { ...raw },
    runtimeSupervisor: {
      isInvalidated: false,
      invalidate: jest.fn(),
      cleanup: jest.fn(),
    },
    controllers: {
      conversationController: {
        save: jest.fn().mockResolvedValue(undefined),
        switchTo: jest.fn().mockResolvedValue(undefined),
        initializeWelcome: jest.fn(),
      },
      inputController: { handleApprovalRequest: jest.fn() },
    },
    dom: {
      contentEl: createMockEl(),
      messagesEl: createMockEl(),
    },
    ui: {
      externalContextSelector: null,
      slashCommandDropdown: null,
    },
  };
}

function createMockPlugin(): any {
  return {
    app: { workspace: { setActiveLeaf: jest.fn(), revealLeaf: jest.fn() } },
    settings: { maxTabs: DEFAULT_MAX_TABS },
    providerHost: {},
    getAgentSkillResourceGeneration: jest.fn().mockReturnValue(0),
    getConversationById: jest.fn().mockResolvedValue(null),
    getCachedConversation: jest.fn().mockReturnValue(null),
    getConversationSync: jest.fn().mockReturnValue(null),
    getConversationList: jest.fn().mockReturnValue([]),
    findConversationAcrossViews: jest.fn().mockReturnValue(null),
  };
}

function createMockView(): any {
  return { leaf: { id: 'leaf-1' }, getTabManager: jest.fn().mockReturnValue(null) };
}

function makeManagerCallbacks(): TabManagerCallbacks {
  return {
    onTabCreated: jest.fn(),
    onTabSwitched: jest.fn(),
    onTabClosed: jest.fn(),
    onPersistedStateChanged: jest.fn(),
    onTabStreamingChanged: jest.fn(),
    onTabTitleChanged: jest.fn(),
    onTabAttentionChanged: jest.fn(),
    onActiveTabChanged: jest.fn(),
  };
}

/**
 * Legt drei Tabs an: `tab-1`, `tab-2`, `tab-3` — in dieser Reihenfolge in der
 * Map, also A, B, C in der Leiste.
 */
async function setupManager(count = 3): Promise<{
  manager: TabManager;
  callbacks: TabManagerCallbacks;
}> {
  const callbacks = makeManagerCallbacks();
  jest.clearAllMocks();
  let counter = 0;
  mockCreateTab.mockImplementation(() => {
    counter += 1;
    return createMockTabData(`tab-${counter}`);
  });

  const manager = new TabManager(
    createMockPlugin(),
    {},
    createMockEl(),
    createMockView(),
    callbacks,
  );

  for (let i = 0; i < count; i++) {
    await manager.createTab();
  }
  // Alles zuruecksetzen, was das Anlegen selbst schon gefeuert hat.
  (callbacks.onPersistedStateChanged as jest.Mock).mockClear();
  return { manager, callbacks };
}

/** Die Tab-Reihenfolge, so wie die Map sie haelt. */
function order(manager: TabManager): string[] {
  return manager.getAllTabs().map(tab => tab.id);
}

// ============================================================
// C) TabManager.reorderTabs
// ============================================================

/*
 * Der Vertrag wurde am 2026-07-27 KORRIGIERT, nicht erweitert.
 *
 * Vorher stand hier "der gezogene Tab landet direkt VOR dem Ziel", samt einem
 * Test, der das Ziehen auf den rechten Nachbarn als No-op festnagelte. Dieser
 * Vertrag ist nicht umkehrbar: er kann einen Tab nur nach links bewegen. Wer
 * Tab 2 auf Position 1 zieht, bekommt ihn nie wieder auf 2 — er muss statt
 * dessen den anderen Tab nach links ziehen. Genau das hat Gabriel gemeldet.
 *
 * Der richtige Vertrag, und zugleich der der Vorfassung: der gezogene Tab
 * uebernimmt die POSITION des Ziels. Nach links heisst das vor dem Ziel, nach
 * rechts hinter dem Ziel, und jeder Zug ist durch den Gegenzug ruecknehmbar.
 * Belegt, nicht bevorzugt: `projects/claudian/ui-fixes.js` Zeile 478-487 im
 * Vault bestimmt `ti` VOR dem Splice und fuegt an `ti` ein — Zeile fuer Zeile
 * das, was `reorderTabs` jetzt tut.
 *
 * Lehre fuers Protokoll: die alten Tests waren nicht schlampig, sie waren
 * ausfuehrlich begruendet und trotzdem falsch. Ein Test kann eine Regression
 * genauso sorgfaeltig zementieren wie ein Verhalten. Der Kommentar erklaerte
 * den Off-by-one korrekt und uebersah, dass die Anforderung darueber schon
 * nicht stimmte.
 */
describe('mazel: reorderTabs moves the dragged tab to the target position', () => {
  it('dragging C onto A: [A,B,C] becomes [C,A,B]', async () => {
    const { manager } = await setupManager();
    expect(order(manager)).toEqual(['tab-1', 'tab-2', 'tab-3']);

    manager.reorderTabs('tab-3', 'tab-1');

    expect(order(manager)).toEqual(['tab-3', 'tab-1', 'tab-2']);
  });

  it('dragging A onto C: [A,B,C] becomes [B,C,A] — rightward lands after the target', async () => {
    // Nach rechts gezogen uebernimmt A die Position von C, also den letzten
    // Platz. Wer ein Element nach rechts zieht, will es dort haben, wo das Ziel
    // war — nicht davor, sonst waere der Zug ueber einen einzelnen Nachbarn
    // wirkungslos.
    const { manager } = await setupManager();

    manager.reorderTabs('tab-1', 'tab-3');

    expect(order(manager)).toEqual(['tab-2', 'tab-3', 'tab-1']);
  });

  it('dragging a tab onto its immediate right neighbour swaps the two', async () => {
    // Der kleinstmoegliche Rechts-Zug, und der Kern des gemeldeten Fehlers:
    // vorher war das ein No-op, der Tab liess sich also nur nach links bewegen.
    const { manager } = await setupManager();

    manager.reorderTabs('tab-1', 'tab-2');

    expect(order(manager)).toEqual(['tab-2', 'tab-1', 'tab-3']);
  });

  it('every drag is undone by dragging back — the reversibility Gabriel reported', async () => {
    // Gabriels Fall in Testform: Tab 2 nach vorn holen, dann wieder
    // zurueckschieben. Mit dem alten Vertrag scheiterte der zweite Zug still.
    const { manager } = await setupManager();

    manager.reorderTabs('tab-2', 'tab-1');
    expect(order(manager)).toEqual(['tab-2', 'tab-1', 'tab-3']);

    manager.reorderTabs('tab-2', 'tab-1');
    expect(order(manager)).toEqual(['tab-1', 'tab-2', 'tab-3']);
  });

  it('a full lap around three tabs returns to the start', async () => {
    // Schaerfer als der Test darueber: nicht nur eine Bewegung und zurueck,
    // sondern jede Position einmal. Ein Vertrag, der irgendwo unterwegs einen
    // Zug verschluckt, kommt hier nicht heraus, wo er hineinging.
    const { manager } = await setupManager();

    manager.reorderTabs('tab-1', 'tab-2');
    manager.reorderTabs('tab-1', 'tab-3');
    expect(order(manager)).toEqual(['tab-2', 'tab-3', 'tab-1']);

    manager.reorderTabs('tab-1', 'tab-3');
    manager.reorderTabs('tab-1', 'tab-2');
    expect(order(manager)).toEqual(['tab-1', 'tab-2', 'tab-3']);
  });

  it('dropping a tab on itself changes nothing and notifies nobody', async () => {
    const { manager, callbacks } = await setupManager();

    manager.reorderTabs('tab-2', 'tab-2');

    expect(order(manager)).toEqual(['tab-1', 'tab-2', 'tab-3']);
    expect(callbacks.onPersistedStateChanged).not.toHaveBeenCalled();
  });

  it('an unknown source id changes nothing and does not throw', async () => {
    const { manager, callbacks } = await setupManager();

    expect(() => manager.reorderTabs('tab-does-not-exist', 'tab-1')).not.toThrow();

    expect(order(manager)).toEqual(['tab-1', 'tab-2', 'tab-3']);
    expect(callbacks.onPersistedStateChanged).not.toHaveBeenCalled();
  });

  it('an unknown target id changes nothing and does not throw', async () => {
    // Wichtiger als er aussieht: ohne die Existenzpruefung liefert
    // findIndex(-1) und splice(-1, 0, …) fuegt VOR dem letzten Element ein.
    // Der Tab wuerde also klaglos an einer willkuerlichen Stelle landen.
    const { manager, callbacks } = await setupManager();

    expect(() => manager.reorderTabs('tab-1', 'tab-does-not-exist')).not.toThrow();

    expect(order(manager)).toEqual(['tab-1', 'tab-2', 'tab-3']);
    expect(callbacks.onPersistedStateChanged).not.toHaveBeenCalled();
  });

  it('keeps the tab objects themselves intact, it only re-seats them', async () => {
    const { manager } = await setupManager();
    const before = new Map(manager.getAllTabs().map(tab => [tab.id, tab]));

    manager.reorderTabs('tab-3', 'tab-1');

    for (const tab of manager.getAllTabs()) {
      expect(tab).toBe(before.get(tab.id));
    }
    expect(manager.getTabCount()).toBe(3);
  });

  it('does not change which tab is active', async () => {
    const { manager } = await setupManager();
    const activeBefore = manager.getActiveTabId();

    manager.reorderTabs('tab-3', 'tab-1');

    expect(manager.getActiveTabId()).toBe(activeBefore);
  });
});

describe('mazel: the new order is the one that gets persisted and rendered', () => {
  it('getPersistedState().openTabs carries the new order, so it survives a restart', async () => {
    // Es gibt kein zweites Feld fuer die Reihenfolge: die Map-Reihenfolge IST
    // die Wahrheit, und getPersistedState() liest genau sie. Waere das nicht
    // so, waere die Sortierung nach dem naechsten Obsidian-Start wieder weg.
    const { manager } = await setupManager();

    manager.reorderTabs('tab-3', 'tab-1');

    expect(manager.getPersistedState().openTabs.map(tab => tab.tabId))
      .toEqual(['tab-3', 'tab-1', 'tab-2']);
  });

  it('getTabBarItems() returns the tabs in the new order and renumbers the index', async () => {
    const { manager } = await setupManager();

    manager.reorderTabs('tab-3', 'tab-1');

    const items = manager.getTabBarItems();
    expect(items.map(item => item.id)).toEqual(['tab-3', 'tab-1', 'tab-2']);
    // `index` ist die POSITION und darf sich aendern. Was der Nutzer sieht,
    // ist die eingefrorene Nummer aus der TabBar (Teil B oben), nicht dieser
    // Wert.
    expect(items.map(item => item.index)).toEqual([1, 2, 3]);
  });

  it('reordering asks the host to write the state out', async () => {
    const { manager, callbacks } = await setupManager();

    manager.reorderTabs('tab-3', 'tab-1');

    expect(callbacks.onPersistedStateChanged).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// Obsoleszenz-Waechter
// ============================================================

describe('obsolescence guard: tab drag reorder', () => {
  /**
   * Dieser Patch fuellt eine Luecke: upstream 2.0.41 kennt das Ziehen von
   * Badges ueberhaupt nicht. Baut upstream es selbst ein, ist unsere Fassung
   * ueberfluessig und gehoert geloescht statt weitergeschleppt — sonst haengen
   * am Ende zwei Drag-Verdrahtungen an denselben Badges und die Reihenfolge
   * wird zweimal umgestellt.
   *
   * Rot heisst hier nicht "kaputt", sondern: "der Boden unter dem Patch hat
   * sich bewegt, lies den Diff neu".
   */
  it('upstream still has no drag wiring on the badge at all', () => {
    const upstream = readUpstreamFile('src/features/chat/tabs/TabBar.ts');
    if (upstream === null) return;

    // Kein draggable-Attribut, also startet upstream nie einen Drag.
    expect(upstream).not.toContain('draggable');
    // Und keiner der Handler, die wir ergaenzen.
    expect(upstream).not.toContain('dragstart');
    expect(upstream).not.toMatch(/dragover|dragleave|dragend/);
    // Die Meldung nach oben gibt es dort ebenfalls nicht.
    expect(upstream).not.toContain('onTabReorder');
  });

  it('upstream still numbers badges by their position, with no stable-number map', () => {
    const upstream = readUpstreamFile('src/features/chat/tabs/TabBar.ts');
    if (upstream === null) return;

    // Genau die Zeile, die unser Patch ersetzt. Rot = der Anker ist weg.
    expect(upstream).toContain('return String(item.index);');
    expect(upstream).not.toContain('stableTabNumbers');

    // Der Wiederaufbau-Punkt, an den sich pruneStableNumbers haengt.
    expect(upstream).toContain('this.containerEl.empty();');
    expect(upstream).toContain('for (const item of items) {');
  });

  it('upstream still has no reorder on the TabManager', () => {
    const upstream = readUpstreamFile('src/features/chat/tabs/TabManager.ts');
    if (upstream === null) return;

    // Absichtlich unscharf und case-insensitiv: `reorderTabs`, `reorder`,
    // `moveTab`-artige Umbenennungen mit "reorder" im Namen treffen alle.
    expect(upstream).not.toMatch(/reorder/i);

    // Unsere Methode setzt darauf, dass die Map-Reihenfolge die Tab-Reihenfolge
    // ist und dass die Persistenz sie ebenso liest. Rot = es gibt jetzt ein
    // eigenes Ordnungsfeld, und der Neuaufbau der Map reicht nicht mehr.
    expect(upstream).toContain('for (const tab of this.tabs.values()) {');
    expect(upstream).toContain('this.tabs.set(tab.id, tab);');
  });
});
