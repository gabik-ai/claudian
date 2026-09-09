/**
 * Mazel patch 18, part A: an interrupt says where it came from, and the CLI's
 * interrupt diagnostic no longer shows up as a red error.
 *
 * Measured 2026-09-09: after Escape (ClaudianView scope handler, Tab keydown)
 * or the Stop button, Claudian showed
 *
 *   Interrupted · What should Claudian do instead?
 *   ❌ Error: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use(background task completed)
 *
 * The second line is the CLI closing the interrupted turn with a `result`
 * whose `errors` carry a diagnostic. It is produced in
 * `transformClaudeMessage.ts` (`case 'result'`, `isResultError`) and reaches
 * the chat through `ClaudeChatRuntime.routeMessage`, either via the live
 * response handler or, once the handler is gone, as an auto-triggered turn.
 * In the second path `ChatState.cancelRequested` is already reset, so the drop
 * has to live in the runtime with a flag that survives the cancelled turn.
 * The StreamController keeps a second, cheaper gate for the handler path.
 */
import '@/providers';

import { createMockEl } from '@test/helpers/mockElement';
import { readFileSync } from 'fs';
import { join } from 'path';

import type { ChatMessage, StreamChunk } from '@/core/types';
import { InputController } from '@/features/chat/controllers/InputController';
import { StreamController } from '@/features/chat/controllers/StreamController';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { ChatState } from '@/features/chat/state/ChatState';
import { ClaudianService } from '@/providers/claude/runtime/ClaudeChatRuntime';
import { createResponseHandler } from '@/providers/claude/runtime/types';
import { isInterruptDiagnosticText } from '@/utils/interrupt';

import { createControllerDeps } from './helpers/inputControllerDeps';
import { REPO_ROOT } from './upstreamRef';

jest.mock('@/shared/components/ResumeSessionDropdown', () => ({
  ResumeSessionDropdown: jest.fn(),
}));

beforeAll(() => {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
});

const DIAGNOSTIC =
  '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use(background task completed)';

// ------------------------------------------------------------ the indicator

function createRenderer(): { renderer: MessageRenderer; messagesEl: ReturnType<typeof createMockEl> } {
  const messagesEl = createMockEl();
  const component = { registerDomEvent: jest.fn(), addChild: jest.fn(), removeChild: jest.fn(), load: jest.fn(), unload: jest.fn() };
  const renderer = new MessageRenderer({} as never, component as never, messagesEl as never);
  return { renderer, messagesEl };
}

function indicatorTexts(source?: 'escape' | 'stop' | 'system' | null): { classes: string[]; texts: string[] } {
  const { renderer } = createRenderer();
  const contentEl = createMockEl();
  renderer.appendInterruptIndicator(contentEl as never, source);
  const textEl = contentEl.children[0];
  return {
    classes: textEl.children.map((child: { className: string }) => child.className),
    texts: textEl.children.map((child: { textContent: string }) => child.textContent),
  };
}

describe('mazel patch 18: the interrupt indicator names its source', () => {
  it('Escape renders as "Interrupted · Escape · What should Claudian do instead?"', () => {
    const { classes, texts } = indicatorTexts('escape');
    expect(classes).toEqual(['claudian-interrupted', 'claudian-interrupted-source', 'claudian-interrupted-hint']);
    expect(texts).toEqual(['Interrupted', '· Escape', '· What should Claudian do instead?']);
  });

  it('the Stop button renders as "· Stop"', () => {
    const { texts } = indicatorTexts('stop');
    expect(texts[1]).toBe('· Stop');
  });

  it.each([
    ['system', 'system' as const],
    ['null', null],
    ['undefined', undefined],
  ])('a cancel without a user source (%s) renders exactly the upstream indicator', (_label, source) => {
    // Negative control: the two upstream spans, nothing in between. The stored
    // history and every caller that passes no reason must look as before.
    const { classes, texts } = indicatorTexts(source);
    expect(classes).toEqual(['claudian-interrupted', 'claudian-interrupted-hint']);
    expect(texts).toEqual(['Interrupted', '· What should Claudian do instead?']);
  });
});

// --------------------------------------------------------- state and wiring

describe('mazel patch 18: the cancel reason travels through ChatState', () => {
  it('resetStreamingState clears the reason together with cancelRequested', () => {
    const state = new ChatState();
    state.cancelRequested = true;
    state.cancelReason = 'stop';

    state.resetStreamingState();

    expect(state.cancelRequested).toBe(false);
    expect(state.cancelReason).toBeNull();
  });

  it('the three user-facing callers pass their reason, the rest stays silent', () => {
    const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');
    const tab = read('src/features/chat/tabs/Tab.ts');
    const view = read('src/features/chat/ClaudianView.ts');
    const main = read('src/main.ts');

    expect(tab).toContain("inputController?.cancelStreaming('stop')");
    expect(tab).toContain("inputController?.cancelStreaming('escape')");
    expect(view).toContain("inputController?.cancelStreaming('escape')");
    // Plugin unload and tab close are 'system' by omission.
    expect(main).toContain('inputController?.cancelStreaming();');
    expect(main).not.toMatch(/cancelStreaming\('(escape|stop)'\)/);
  });
});

// ------------------------------------------------ InputController end to end

describe('mazel patch 18: InputController hands the reason to the indicator', () => {
  it.each([
    ['escape'],
    ['stop'],
  ] as const)('cancelStreaming(%s) ends with the indicator carrying that source', async (reason) => {
    const deps = createControllerDeps();
    const controller = new InputController(deps);
    deps.query.mockImplementation(() => (async function* () {
      yield { type: 'text', content: 'partial' };
      controller.cancelStreaming(reason);
      yield { type: 'text', content: 'never rendered' };
    })());
    deps.getInputEl().value = 'hallo';

    await controller.sendMessage();

    expect(deps.appendInterruptIndicator).toHaveBeenCalledTimes(1);
    expect(deps.appendInterruptIndicator).toHaveBeenCalledWith(expect.anything(), reason);
    expect(deps.state.cancelReason).toBeNull();
    expect(deps.state.cancelRequested).toBe(false);
  });

  it('cancelStreaming() without a reason is a system cancel', async () => {
    const deps = createControllerDeps();
    const controller = new InputController(deps);
    deps.query.mockImplementation(() => (async function* () {
      yield { type: 'text', content: 'partial' };
      controller.cancelStreaming();
      yield { type: 'text', content: 'never rendered' };
    })());
    deps.getInputEl().value = 'hallo';

    await controller.sendMessage();

    expect(deps.appendInterruptIndicator).toHaveBeenCalledWith(expect.anything(), 'system');
  });
});

// ----------------------------------------------- StreamController second gate

function createStreamController(): { controller: StreamController; state: ChatState } {
  const state = new ChatState();
  state.currentContentEl = createMockEl() as never;
  const controller = new StreamController({
    plugin: { settings: { permissionMode: 'yolo' }, app: { vault: { adapter: { basePath: '/v' } } } },
    state,
    renderer: { renderContent: jest.fn(), addTextCopyButton: jest.fn() },
    subagentManager: { resetStreamingState: jest.fn() },
    getMessagesEl: () => createMockEl() as never,
    getFileContextManager: () => ({ markFileBeingEdited: jest.fn(), trackEditedFile: jest.fn() }),
    updateQueueIndicator: jest.fn(),
    getAgentService: () => ({ getSessionId: () => 's1' }),
  } as never);
  return { controller, state };
}

function emptyMessage(): ChatMessage {
  return { id: 'a1', role: 'assistant', content: '', timestamp: 0, toolCalls: [], contentBlocks: [] };
}

describe('mazel patch 18: the diagnostic predicate', () => {
  it('matches the measured line, also with leading whitespace', () => {
    expect(isInterruptDiagnosticText(DIAGNOSTIC)).toBe(true);
    expect(isInterruptDiagnosticText(`  ${DIAGNOSTIC}`)).toBe(true);
  });

  it('does not match a real error that merely mentions the marker', () => {
    expect(isInterruptDiagnosticText('Result error: error_during_execution')).toBe(false);
    expect(isInterruptDiagnosticText(`Tool failed, see ${DIAGNOSTIC}`)).toBe(false);
    expect(isInterruptDiagnosticText('')).toBe(false);
  });
});

describe('mazel patch 18: StreamController drops the diagnostic only after a cancel', () => {
  const errorChunk = (content: string): StreamChunk => ({ type: 'error', content });

  it('after a cancel the diagnostic renders nothing', async () => {
    const { controller, state } = createStreamController();
    state.cancelRequested = true;

    await controller.handleStreamChunk(errorChunk(DIAGNOSTIC), emptyMessage());

    expect(state.currentTextEl).toBeNull();
    expect(state.currentTextContent).toBe('');
  });

  it('without a cancel the same line stays a visible error', async () => {
    const { controller, state } = createStreamController();

    await controller.handleStreamChunk(errorChunk(DIAGNOSTIC), emptyMessage());

    expect(state.currentTextContent).toContain('❌ **Error:**');
    expect(state.currentTextContent).toContain(DIAGNOSTIC);
  });

  it('after a cancel any other error stays visible', async () => {
    const { controller, state } = createStreamController();
    state.cancelRequested = true;

    await controller.handleStreamChunk(errorChunk('Claude CLI crashed'), emptyMessage());

    expect(state.currentTextContent).toContain('Claude CLI crashed');
  });
});

// ---------------------------------------------------- runtime, where it starts

describe('mazel patch 18: ClaudeChatRuntime drops the diagnostic where it is born', () => {
  let service: ClaudianService;
  let onChunk: jest.Mock;

  const diagnosticResult = () => ({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: [DIAGNOSTIC],
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    session_id: 's1',
    total_cost_usd: 0,
    usage: {},
  });

  const withHandler = () => {
    onChunk = jest.fn();
    (service as any).responseHandlers = [createResponseHandler({
      id: 'route-test',
      onChunk,
      onDone: jest.fn(),
      onError: jest.fn(),
    })];
  };

  beforeEach(() => {
    const plugin = {
      app: { vault: { adapter: { basePath: '/mock/vault' } } },
      storage: {
        addDenyRule: jest.fn(), addAllowRule: jest.fn(),
        getPermissions: jest.fn().mockResolvedValue({ allow: [], deny: [], ask: [] }),
      },
      settings: {
        model: 'claude-3-5-sonnet', permissionMode: 'ask', thinkingBudget: 0, mediaFolder: 'claudian-media',
        systemPrompt: '', loadUserClaudeSettings: false, claudeCliPath: '/usr/local/bin/claude', claudeCliPaths: [],
        enableAutoTitleGeneration: true, titleGenerationModel: 'claude-3-5-haiku',
      },
      getResolvedProviderCliPath: jest.fn().mockReturnValue('/usr/local/bin/claude'),
      getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
      pluginManager: { getPluginsKey: jest.fn().mockReturnValue('') },
    };
    const mcp = {
      loadServers: jest.fn().mockResolvedValue(undefined),
      ensureLoaded: jest.fn().mockResolvedValue(undefined),
      getAllDisallowedMcpTools: jest.fn().mockReturnValue([]),
      getActiveServers: jest.fn().mockReturnValue({}),
      getDisallowedMcpTools: jest.fn().mockReturnValue([]),
      extractMentions: jest.fn().mockReturnValue(new Set<string>()),
      transformMentions: jest.fn().mockImplementation((text: string) => text),
    };
    service = new ClaudianService(plugin as never, mcp as never);
    (service as any).messageChannel = { onTurnComplete: jest.fn(), setSessionId: jest.fn() };
  });

  const errorsSeen = () => onChunk.mock.calls.map(([c]) => c).filter((c: StreamChunk) => c.type === 'error');

  it('the diagnostic result reaches the handler when nobody cancelled', async () => {
    withHandler();

    await (service as any).routeMessage(diagnosticResult());

    expect(errorsSeen()).toEqual([{ type: 'error', content: DIAGNOSTIC }]);
  });

  it('after cancel() the same result yields no error chunk on the handler path', async () => {
    withHandler();
    service.cancel();

    await (service as any).routeMessage(diagnosticResult());

    expect(errorsSeen()).toEqual([]);
  });

  it('after cancel() it also never reaches the auto-turn path (no handler left)', async () => {
    // This is the path that painted the red line: the handler was gone, the
    // late result landed in the auto-turn buffer, and ChatState.cancelRequested
    // was already false by then.
    const autoTurn = jest.fn();
    service.setAutoTurnCallback(autoTurn);
    (service as any).responseHandlers = [];
    service.cancel();

    await (service as any).routeMessage(diagnosticResult());

    const delivered = autoTurn.mock.calls.flatMap(([r]) => r.chunks as StreamChunk[]);
    expect(delivered.filter(c => c.type === 'error')).toEqual([]);
  });

  it('after cancel() a different error is still delivered', async () => {
    withHandler();
    service.cancel();

    await (service as any).routeMessage({ ...diagnosticResult(), errors: ['Claude CLI crashed'] });

    expect(errorsSeen()).toEqual([{ type: 'error', content: 'Claude CLI crashed' }]);
  });

  it('the next query() lifts the silence again', async () => {
    service.cancel();
    const sdk = jest.requireMock('@anthropic-ai/claude-agent-sdk') as {
      setMockMessages: (messages: unknown[]) => void;
      resetMockMessages: () => void;
    };
    sdk.setMockMessages([{ type: 'assistant', message: { content: [{ type: 'text', text: 'Hallo' }] } }]);
    let streamed = 0;
    try {
      for await (const chunk of service.query(service.prepareTurn({ text: 'hi' }))) {
        streamed += chunk.type === 'text' ? 1 : 0;
      }
    } finally {
      sdk.resetMockMessages();
    }
    expect(streamed).toBeGreaterThan(0);
    withHandler();

    await (service as any).routeMessage(diagnosticResult());

    expect(errorsSeen()).toEqual([{ type: 'error', content: DIAGNOSTIC }]);
  });
});
