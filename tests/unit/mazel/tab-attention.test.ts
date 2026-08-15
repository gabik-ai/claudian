/**
 * Mazel patch: der orange Rahmen an einem Tab, der fertig geworden ist.
 *
 * Was upstream fehlt
 * ------------------
 * Upstream 2.0.41 liefert den kompletten Apparat: das Feld `needsAttention` im
 * ChatState, den Setter, der `onAttentionChanged` feuert, die Callback-Kette
 * bis `onTabAttentionChanged`, und die CSS-Regel
 * `.claudian-tab-badge-attention`. Es fehlt genau der Moment, der ihn setzt:
 * `needsAttention = true` steht upstream nirgends im Quellcode. Toter Apparat,
 * seit das Feld existiert — deshalb ging nie etwas orange.
 *
 * Der Patch ergaenzt zwei Stellen in `TabManager.ts`:
 *   1. `onStreamingChanged`: endet der Stream auf einem Tab, den der Nutzer
 *      gerade NICHT ansieht, wird der Merker gesetzt.
 *   2. `switchToTab`: der Blick auf den Tab loescht den Merker wieder.
 *
 * Warum das Loeschen VOR dem Nebenlaeufigkeits-Guard steht
 * -------------------------------------------------------
 * `switchToTab` reiht einen Wechsel nur ein, solange ein anderer laeuft
 * (`isSwitchingTab`). Der Merker wird trotzdem sofort geloescht, denn der
 * Nutzer HAT diesen Tab bereits angefordert. Stuende das Loeschen hinter dem
 * Guard, bliebe der Rahmen bei einem eingereihten Wechsel stehen und saehe aus,
 * als haenge er fest. Das ist eine bewusste Reihenfolge-Entscheidung und wird
 * unten explizit getestet.
 *
 * Testaufbau
 * ----------
 * Die Mock-Umgebung ist der aus `tests/unit/features/chat/tabs/TabManager.test.ts`
 * nachgebaut, mit einem entscheidenden Zusatz: `tab.state.needsAttention` ist
 * hier ein echter Getter/Setter, der wie `ChatState` (src/features/chat/state/
 * ChatState.ts, Zeile 327-334) beim Schreiben `onAttentionChanged` feuert.
 * Ohne diesen Nachbau wuerde man an der Sache vorbeitesten: der Patch schreibt
 * in das Feld, und die ganze sichtbare Wirkung haengt an dem Callback, den der
 * Setter ausloest.
 */
import { createMockEl } from '@test/helpers/mockElement';

import { TabManager } from '@/features/chat/tabs/TabManager';
import { DEFAULT_MAX_TABS, type TabManagerCallbacks } from '@/features/chat/tabs/types';

import { readUpstreamFile } from './upstreamRef';

// ============================================================
// Mocks (Vorlage: tests/unit/features/chat/tabs/TabManager.test.ts)
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
  setTabPendingTitle: (tab: any, title: string | null) => {
    tab.pendingTitle = title;
  },
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
    // Nicht-null: dann ueberspringt ensureTabWorkspaceServices die Initialisierung.
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
// Harness
// ============================================================

/** Ein Mock-Tab, dessen `state.needsAttention` sich wie ChatState verhaelt. */
interface MockTab {
  id: string;
  state: { needsAttention: boolean; isStreaming: boolean; [key: string]: unknown };
  /** Der `onStreamingChanged`-Callback, den TabManager beim Anlegen mitgibt. */
  fireStreamingChanged: (isStreaming: boolean) => void;
  [key: string]: unknown;
}

function createMockTabData(id: string): MockTab {
  // Der Rohspeicher hinter dem Accessor — das Gegenstueck zu ChatState.state.
  const raw = {
    isStreaming: false,
    hasPendingConversationSave: false,
    isSwitchingConversation: false,
    isRewinding: false,
    needsAttention: false,
    messages: [] as unknown[],
    currentConversationId: null as string | null,
  };

  const tab: any = {
    id,
    lifecycleState: 'blank',
    hydrationState: 'ready',
    providerId: 'claude',
    conversationId: null,
    service: null,
    serviceInitialized: false,
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
    // Wird in mockCreateTab mit den echten Callbacks des TabManagers befuellt.
    fireStreamingChanged: () => {
      throw new Error('onStreamingChanged wurde nie verdrahtet');
    },
    _onAttentionChanged: undefined as undefined | ((needsAttention: boolean) => void),
  };

  const state: any = { ...raw };
  // Nachbau von ChatState.ts:331-334 — schreiben feuert IMMER, ohne
  // Aenderungs-Vergleich. Genau darauf verlaesst sich der Patch.
  Object.defineProperty(state, 'needsAttention', {
    get: () => raw.needsAttention,
    set: (value: boolean) => {
      raw.needsAttention = value;
      tab._onAttentionChanged?.(value);
    },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(state, 'isStreaming', {
    get: () => raw.isStreaming,
    set: (value: boolean) => {
      raw.isStreaming = value;
    },
    enumerable: true,
    configurable: true,
  });
  tab.state = state;

  return tab as MockTab;
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

function createManager(callbacks: TabManagerCallbacks): TabManager {
  jest.clearAllMocks();
  let counter = 0;
  mockCreateTab.mockImplementation((createOptions: any) => {
    counter += 1;
    const tab = createMockTabData(`tab-${counter}`) as any;
    // Die zwei Kanaele, um die es hier geht: der Ausloeser (Streaming-Ende)
    // und die Wirkung (Attention-Callback).
    tab.fireStreamingChanged = createOptions.onStreamingChanged;
    tab._onAttentionChanged = createOptions.onAttentionChanged;
    tab.onRuntimeInstalled = createOptions.onRuntimeInstalled;
    return tab;
  });

  return new TabManager(
    createMockPlugin(),
    {},
    createMockEl(),
    createMockView(),
    callbacks,
  );
}

function makeCallbacks(): TabManagerCallbacks {
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
 * Legt `count` Tabs an. Der ZULETZT angelegte ist danach der aktive — alle
 * anderen sind die "der Nutzer sieht gerade woanders hin"-Faelle.
 */
async function setup(count = 2): Promise<{
  manager: TabManager;
  callbacks: TabManagerCallbacks;
  tabs: MockTab[];
}> {
  const callbacks = makeCallbacks();
  const manager = createManager(callbacks);
  const tabs: MockTab[] = [];
  for (let i = 0; i < count; i++) {
    tabs.push((await manager.createTab()) as unknown as MockTab);
  }
  // Alles zuruecksetzen, was das Anlegen selbst schon gefeuert hat.
  (callbacks.onTabAttentionChanged as jest.Mock).mockClear();
  (callbacks.onTabStreamingChanged as jest.Mock).mockClear();
  return { manager, callbacks, tabs };
}

// ============================================================
// Der Ausloeser: ein Stream, der auf einem unbeobachteten Tab endet
// ============================================================

describe('mazel: a finished answer raises the attention marker', () => {
  it('sets needsAttention when a stream ends on an INACTIVE tab', async () => {
    const { manager, callbacks, tabs } = await setup(2);
    const [background, foreground] = tabs;
    expect(manager.getActiveTabId()).toBe(foreground.id);
    expect(background.state.needsAttention).toBe(false);

    background.fireStreamingChanged(false);

    expect(background.state.needsAttention).toBe(true);
    expect(callbacks.onTabAttentionChanged).toHaveBeenCalledWith(background.id, true);
  });

  it('leaves the ACTIVE tab alone — the user is already looking at it', async () => {
    const { manager, callbacks, tabs } = await setup(2);
    const foreground = tabs[1];
    expect(manager.getActiveTabId()).toBe(foreground.id);

    foreground.fireStreamingChanged(false);

    expect(foreground.state.needsAttention).toBe(false);
    expect(callbacks.onTabAttentionChanged).not.toHaveBeenCalled();
  });

  it('marks nothing when a stream BEGINS on an inactive tab', async () => {
    // Der Rahmen bedeutet "hier liegt eine fertige Antwort", nicht "hier
    // passiert etwas". Der Anfang eines Streams darf ihn nicht setzen.
    const { callbacks, tabs } = await setup(2);
    const background = tabs[0];

    background.fireStreamingChanged(true);

    expect(background.state.needsAttention).toBe(false);
    expect(callbacks.onTabAttentionChanged).not.toHaveBeenCalled();
  });

  it('still forwards the streaming callback upstream expects', async () => {
    // Der Patch haengt sich VOR den bestehenden Aufruf. Verschluckt er ihn,
    // waere die Tab-Leiste blind fuer den Streaming-Zustand.
    const { callbacks, tabs } = await setup(2);
    const background = tabs[0];

    background.fireStreamingChanged(true);
    background.fireStreamingChanged(false);

    expect(callbacks.onTabStreamingChanged).toHaveBeenNthCalledWith(1, background.id, true);
    expect(callbacks.onTabStreamingChanged).toHaveBeenNthCalledWith(2, background.id, false);
  });
});

// ============================================================
// Das Loeschen: der Blick auf den Tab
// ============================================================

describe('mazel: looking at the tab clears the marker', () => {
  it('switchToTab clears needsAttention on the target tab', async () => {
    const { manager, callbacks, tabs } = await setup(2);
    const background = tabs[0];
    background.fireStreamingChanged(false);
    (callbacks.onTabAttentionChanged as jest.Mock).mockClear();

    await manager.switchToTab(background.id);

    expect(background.state.needsAttention).toBe(false);
    expect(callbacks.onTabAttentionChanged).toHaveBeenCalledWith(background.id, false);
  });

  it('switching to a DIFFERENT tab leaves the marked one marked', async () => {
    const { manager, callbacks, tabs } = await setup(3);
    const [marked, other] = tabs;
    marked.fireStreamingChanged(false);
    (callbacks.onTabAttentionChanged as jest.Mock).mockClear();

    await manager.switchToTab(other.id);

    expect(marked.state.needsAttention).toBe(true);
    expect(callbacks.onTabAttentionChanged).not.toHaveBeenCalled();
  });

  it('does not fire the callback for a tab that was never marked', async () => {
    // Der ChatState-Setter feuert ohne Aenderungs-Vergleich. Ohne den
    // `if (tab.state.needsAttention)`-Guard im Patch wuerde JEDER Tabwechsel
    // ein `false` in die Callback-Kette schieben.
    const { manager, callbacks, tabs } = await setup(2);
    const background = tabs[0];

    await manager.switchToTab(background.id);

    expect(callbacks.onTabAttentionChanged).not.toHaveBeenCalled();
  });

  it('clears the marker even when the switch is merely QUEUED', async () => {
    // Die bewusste Reihenfolge-Entscheidung: das Loeschen steht VOR dem
    // Nebenlaeufigkeits-Guard. Ein eingereihter Wechsel ist trotzdem eine
    // Willensbekundung des Nutzers — der Rahmen darf nicht stehenbleiben,
    // bis der laufende Wechsel irgendwann fertig wird.
    const { manager, callbacks, tabs } = await setup(3);
    const [marked, slow] = tabs;

    marked.fireStreamingChanged(false);
    expect(marked.state.needsAttention).toBe(true);
    (callbacks.onTabAttentionChanged as jest.Mock).mockClear();

    // `slow` haengt mitten im Wechsel fest, also bleibt isSwitchingTab true.
    let releaseSlowSwitch!: () => void;
    const hangingSwitch = new Promise<void>((resolve) => {
      releaseSlowSwitch = resolve;
    });
    (slow as any).conversationId = 'conv-slow';
    (slow as any).hydrationState = 'idle';
    (slow as any).controllers.conversationController.switchTo = jest
      .fn()
      .mockReturnValue(hangingSwitch);

    const pendingSlowSwitch = manager.switchToTab(slow.id);

    // Dieser Wechsel wird nur eingereiht, nicht ausgefuehrt.
    await manager.switchToTab(marked.id);

    expect(manager.getActiveTabId()).toBe(slow.id); // wirklich nur eingereiht
    expect(marked.state.needsAttention).toBe(false);
    expect(callbacks.onTabAttentionChanged).toHaveBeenCalledWith(marked.id, false);

    releaseSlowSwitch();
    await pendingSlowSwitch;
  });

  it('does not throw on an unknown tab id', async () => {
    const { manager, callbacks } = await setup(2);

    await expect(manager.switchToTab('tab-does-not-exist')).resolves.toBeUndefined();
    expect(callbacks.onTabAttentionChanged).not.toHaveBeenCalled();
  });
});

// ============================================================
// Obsoleszenz-Waechter
// ============================================================

describe('obsolescence guard: needsAttention trigger', () => {
  /**
   * Dieser Patch ist eine Luecken-Fuellung, kein Feature. Sobald upstream den
   * Ausloeser selbst nachruestet, ist unsere Ergaenzung ueberfluessig und
   * gehoert geloescht statt weitergeschleppt — im schlimmsten Fall setzen dann
   * zwei Stellen denselben Merker und der Rahmen verhaelt sich doppelt.
   *
   * Ein rotes Ergebnis hier heisst also nicht "kaputt", sondern: "der Boden
   * unter dem Patch hat sich bewegt, lies den Diff neu".
   */
  it('upstream still never sets needsAttention to true', () => {
    const upstream = readUpstreamFile('src/features/chat/tabs/TabManager.ts');
    if (upstream === null) return;

    // Leerzeichen-tolerant: `needsAttention = true`, `needsAttention=true`,
    // `needsAttention   =  true` treffen alle. Die Lesezugriffe
    // (`needsAttention: tab.state.needsAttention`) treffen bewusst nicht.
    expect(upstream).not.toMatch(/needsAttention\s*=\s*true/);

    // Auch das Loeschen gibt es upstream nicht. Rot = upstream raeumt den
    // Merker jetzt selbst ab, unser zweiter Hunk waere dann doppelt gemoppelt.
    expect(upstream).not.toMatch(/needsAttention\s*=\s*false/);
  });

  it('upstream still ships the dead apparatus our two lines hook into', () => {
    const upstream = readUpstreamFile('src/features/chat/tabs/TabManager.ts');
    if (upstream === null) return;

    // Die Callback-Kette, an der die sichtbare Wirkung haengt. Rot = die Kette
    // wurde umgebaut, der Patch feuert womoeglich ins Leere.
    expect(upstream).toContain('onAttentionChanged:');
    expect(upstream).toContain('this.callbacks.onTabAttentionChanged?.(tab.id, needsAttention);');

    // Unser erster Hunk haengt sich in genau diesen Callback ein.
    expect(upstream).toContain('onStreamingChanged: (isStreaming) => {');

    // Unser zweiter Hunk steht direkt VOR diesem Guard. Rot = der Anker ist
    // weg und die Reihenfolge-Entscheidung muss neu getroffen werden.
    expect(upstream).toContain('if (this.isSwitchingTab) {');
  });

  it('upstream still fires onAttentionChanged from the ChatState setter', () => {
    const upstreamState = readUpstreamFile('src/features/chat/state/ChatState.ts');
    if (upstreamState === null) return;

    // Der Patch schreibt nur in das Feld. Ohne diesen Setter passiert nichts
    // Sichtbares — und der Mock in dieser Datei bildet ihn nach.
    const setter = upstreamState.match(/set needsAttention\(value: boolean\) \{[\s\S]*?\n {2}\}/)?.[0];
    expect(setter).toBeDefined();
    expect(setter).toContain('this._callbacks.onAttentionChanged?.(value);');

    // Kein Aenderungs-Vergleich im Setter: deshalb braucht der Patch in
    // switchToTab seinen eigenen `if`-Guard, sonst feuert jeder Tabwechsel.
    expect(setter).not.toContain('changed');
  });
});
