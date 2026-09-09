/**
 * Minimal, sendable InputController dependency set for mazel patch tests.
 *
 * A compact copy of upstream's `createSendableDeps` in
 * `tests/unit/features/chat/controllers/InputController.test.ts`. Kept here so
 * the mazel tests do not import from an upstream test file (which would turn
 * every upstream fixture change into a conflict in our tree).
 */
import { createMockEl } from '@test/helpers/mockElement';

import type { InputControllerDeps } from '@/features/chat/controllers/InputController';
import { ChatState } from '@/features/chat/state/ChatState';
import { encodeClaudeTurn } from '@/providers/claude/prompt/ClaudeTurnEncoder';

export interface MazelControllerDeps extends InputControllerDeps {
  query: jest.Mock;
  appendText: jest.Mock;
  handleStreamChunk: jest.Mock;
  appendInterruptIndicator: jest.Mock;
}

export function createControllerDeps(): MazelControllerDeps {
  const state = new ChatState();
  state.currentConversationId = 'conv-1';
  const queueIndicatorEl = createMockEl();
  queueIndicatorEl.style.display = 'none';
  state.queueIndicatorEl = queueIndicatorEl as never;

  const query = jest.fn();
  const appendText = jest.fn();
  const handleStreamChunk = jest.fn();
  const appendInterruptIndicator = jest.fn();
  const mcp = {
    extractMentions: jest.fn().mockReturnValue(new Set<string>()),
    transformMentions: jest.fn().mockImplementation((text: string) => text),
  };
  const agentService = {
    providerId: 'claude',
    getCapabilities: jest.fn().mockReturnValue({
      providerId: 'claude',
      supportsPersistentRuntime: true,
      supportsNativeHistory: true,
      supportsPlanMode: true,
      supportsRewind: true,
      supportsFork: true,
      supportsProviderCommands: true,
      supportsTurnSteer: false,
      reasoningControl: 'effort',
    }),
    prepareTurn: jest.fn().mockImplementation((request: unknown) => encodeClaudeTurn(request as never, mcp as never)),
    query,
    steer: jest.fn().mockResolvedValue(true),
    cancel: jest.fn(),
    resetSession: jest.fn(),
    setResumeCheckpoint: jest.fn(),
    setApprovedPlanContent: jest.fn(),
    setCurrentPlanFilePath: jest.fn(),
    getApprovedPlanContent: jest.fn().mockReturnValue(null),
    clearApprovedPlanContent: jest.fn(),
    ensureReady: jest.fn().mockResolvedValue(true),
    getSessionId: jest.fn().mockReturnValue(null),
    getAuxiliaryModel: jest.fn().mockReturnValue(null),
    consumeTurnMetadata: jest.fn().mockReturnValue({}),
  };
  const pluginSettings = { permissionMode: 'yolo', enableAutoTitleGeneration: true };
  const saveSettings = jest.fn();
  const inputEl = { dispatchEvent: jest.fn().mockReturnValue(true), value: '', focus: jest.fn() } as unknown as HTMLTextAreaElement;

  const deps = {
    plugin: {
      saveSettings,
      mutateSettings: jest.fn(async (mutation: (s: unknown) => unknown) => {
        await mutation(pluginSettings);
        await saveSettings();
      }),
      settings: pluginSettings,
      mcpManager: mcp,
      renameConversation: jest.fn(),
      updateConversation: jest.fn(),
      getConversationSync: jest.fn().mockReturnValue(null),
      getConversationById: jest.fn().mockResolvedValue(null),
      createConversation: jest.fn().mockResolvedValue({ id: 'conv-1' }),
      deleteConversation: jest.fn().mockResolvedValue(undefined),
      handleMissingProviderSession: jest.fn().mockResolvedValue('deleted'),
    },
    state,
    renderer: {
      addMessage: jest.fn().mockReturnValue({ querySelector: jest.fn().mockReturnValue(createMockEl()) }),
      refreshActionButtons: jest.fn(),
      removeMessage: jest.fn(),
      updateLiveUserMessage: jest.fn(),
      appendInterruptIndicator,
    },
    streamController: {
      showThinkingIndicator: jest.fn(),
      hideThinkingIndicator: jest.fn(),
      handleStreamChunk,
      finalizeCurrentTextBlock: jest.fn(),
      finalizeCurrentThinkingBlock: jest.fn(),
      appendText,
    },
    selectionController: { getContext: jest.fn().mockReturnValue(null) },
    canvasSelectionController: { getContext: jest.fn().mockReturnValue(null) },
    conversationController: {
      save: jest.fn(),
      generateFallbackTitle: jest.fn().mockReturnValue('Test Title'),
      updateHistoryDropdown: jest.fn(),
      clearTerminalSubagentsFromMessages: jest.fn(),
    },
    getInputEl: () => inputEl,
    getInputContainerEl: () => createMockEl(),
    getWelcomeEl: () => createMockEl(),
    getMessagesEl: () => createMockEl(),
    getFileContextManager: () => ({
      startSession: jest.fn(),
      getCurrentNotePath: jest.fn().mockReturnValue(null),
      shouldSendCurrentNote: jest.fn().mockReturnValue(false),
      markCurrentNoteSent: jest.fn(),
      transformContextMentions: jest.fn().mockImplementation((text: string) => text),
    }),
    getImageContextManager: () => ({
      hasImages: jest.fn().mockReturnValue(false),
      getAttachedImages: jest.fn().mockReturnValue([]),
      clearImages: jest.fn(),
      setImages: jest.fn(),
    }),
    getMcpServerSelector: () => null,
    getExternalContextSelector: () => null,
    getInstructionModeManager: () => null,
    getInstructionRefineService: () => null,
    getTitleGenerationService: () => null,
    getStatusPanel: () => null,
    generateId: () => `msg-${Math.random().toString(36).slice(2, 11)}`,
    resetInputHeight: jest.fn(),
    getAgentService: () => agentService,
    getSubagentManager: () => ({ resetSpawnedCount: jest.fn(), resetStreamingState: jest.fn() }),
  } as unknown as InputControllerDeps;

  return Object.assign(deps, { query, appendText, handleStreamChunk, appendInterruptIndicator });
}
