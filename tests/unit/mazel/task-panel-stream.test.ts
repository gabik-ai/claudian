/**
 * Mazel patch: the status panel fills up again from the stateful Task tools.
 *
 * The reducer has its own unit tests. This one drives the real StreamController
 * with real chunks, because that is where the actual bug lived: upstream never
 * calls anything on a TaskCreate, so `state.currentTodos` stays null and the
 * panel never appears (upstream issue #934).
 *
 * The assertion is therefore on `onTodosChanged` — the exact callback
 * StatusPanel subscribes to. If a future refactor keeps the reducer intact but
 * unhooks it from the stream, this goes red and the reducer tests do not.
 */
import '@/providers';

import { createMockEl } from '@test/helpers/mockElement';

import type { ChatMessage } from '@/core/types';
import { StreamController, type StreamControllerDeps } from '@/features/chat/controllers/StreamController';
import { ChatState } from '@/features/chat/state/ChatState';
import type { TodoItem } from '@/features/chat/state/types';

jest.mock('@/features/chat/rendering/ToolCallRenderer', () => ({
  getToolName: jest.fn().mockReturnValue('Tasks'),
  getToolSummary: jest.fn().mockReturnValue(''),
  isBlockedToolResult: jest.fn().mockReturnValue(false),
  renderToolCall: jest.fn(),
  updateToolCallResult: jest.fn(),
}));

jest.mock('@/utils/path', () => ({
  getVaultPath: jest.fn().mockReturnValue('/test/vault'),
  normalizePathForVault: jest.fn((path: string | undefined) => path),
}));

const originalWindow = (globalThis as { window?: Window }).window;

function installTestWindow(): void {
  Object.defineProperty(globalThis, 'window', {
    value: {
      requestAnimationFrame: (cb: FrameRequestCallback): number =>
        globalThis.setTimeout(() => cb(performance.now()), 0) as unknown as number,
      cancelAnimationFrame: (h: number): void => globalThis.clearTimeout(h as never),
      setTimeout: (cb: () => void, t: number): number => globalThis.setTimeout(cb, t) as unknown as number,
      clearTimeout: (h: number): void => globalThis.clearTimeout(h as never),
      setInterval: (cb: () => void, t: number): number => globalThis.setInterval(cb, t) as unknown as number,
      clearInterval: (h: number): void => globalThis.clearInterval(h as never),
    } as Window,
    configurable: true,
  });
}

function restoreTestWindow(): void {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: Window }).window;
    return;
  }
  Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
}

interface Harness {
  controller: StreamController;
  state: ChatState;
  msg: ChatMessage;
  todoUpdates: (TodoItem[] | null)[];
}

function createHarness(): Harness {
  const todoUpdates: (TodoItem[] | null)[] = [];
  const state = new ChatState({ onTodosChanged: (todos) => todoUpdates.push(todos) });
  const messagesEl = createMockEl();

  const deps = {
    plugin: {
      settings: { permissionMode: 'yolo' },
      app: { vault: { adapter: { basePath: '/test/vault' } } },
    },
    state,
    renderer: { renderContent: jest.fn(), addTextCopyButton: jest.fn() },
    subagentManager: {
      isAsyncTask: jest.fn().mockReturnValue(false),
      isPendingAsyncTask: jest.fn().mockReturnValue(false),
      isLinkedAgentOutputTool: jest.fn().mockReturnValue(false),
      handleAgentOutputToolResult: jest.fn().mockReturnValue(undefined),
      handleAgentOutputToolUse: jest.fn(),
      handleAsyncSubagentCompletion: jest.fn().mockReturnValue(undefined),
      handleTaskToolUse: jest.fn().mockReturnValue({ action: 'buffered' }),
      handleTaskToolResult: jest.fn(),
      getByTaskId: jest.fn().mockReturnValue(undefined),
      refreshAsyncSubagent: jest.fn(),
      hasPendingTask: jest.fn().mockReturnValue(false),
      renderPendingTask: jest.fn().mockReturnValue(null),
      renderPendingTaskFromTaskResult: jest.fn().mockReturnValue(null),
      getSyncSubagent: jest.fn().mockReturnValue(undefined),
      addSyncToolCall: jest.fn(),
      updateSyncToolResult: jest.fn(),
      finalizeSyncSubagent: jest.fn().mockReturnValue(null),
      resetStreamingState: jest.fn(),
      resetSpawnedCount: jest.fn(),
      subagentsSpawnedThisStream: 0,
    },
    getMessagesEl: () => messagesEl,
    getFileContextManager: () => ({
      markFileBeingEdited: jest.fn(),
      trackEditedFile: jest.fn(),
      getAttachedFiles: jest.fn().mockReturnValue(new Set()),
      hasFilesChanged: jest.fn().mockReturnValue(false),
    }),
    updateQueueIndicator: jest.fn(),
    getAgentService: () => ({
      getSessionId: jest.fn().mockReturnValue('session-1'),
      loadSubagentToolCalls: jest.fn().mockResolvedValue([]),
      loadSubagentFinalResult: jest.fn().mockResolvedValue(null),
      getCapabilities: jest.fn().mockReturnValue({ providerId: 'claude', supportsPlanMode: true }),
    }),
  } as unknown as StreamControllerDeps;

  return {
    controller: new StreamController(deps),
    state,
    msg: {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      timestamp: 0,
      toolCalls: [],
      contentBlocks: [],
    },
    todoUpdates,
  };
}

async function taskCreate(h: Harness, toolUseId: string, id: string, subject: string, activeForm?: string) {
  await h.controller.handleStreamChunk(
    {
      type: 'tool_use',
      id: toolUseId,
      name: 'TaskCreate',
      input: { subject, description: `do ${subject}`, ...(activeForm ? { activeForm } : {}) },
    },
    h.msg,
  );
  await h.controller.handleStreamChunk(
    {
      type: 'tool_result',
      id: toolUseId,
      content: `Task #${id} created successfully: ${subject}`,
    },
    h.msg,
  );
}

async function taskUpdate(h: Harness, toolUseId: string, taskId: string, status: string) {
  await h.controller.handleStreamChunk(
    { type: 'tool_use', id: toolUseId, name: 'TaskUpdate', input: { taskId, status } },
    h.msg,
  );
  await h.controller.handleStreamChunk(
    { type: 'tool_result', id: toolUseId, content: `Updated task #${taskId} ${status}` },
    h.msg,
  );
}

describe('mazel: task panel fills from the stateful task tools', () => {
  beforeEach(() => installTestWindow());
  afterEach(() => restoreTestWindow());

  it('a TaskCreate round trip puts a todo in the panel', async () => {
    const h = createHarness();
    expect(h.state.currentTodos).toBeNull();

    await taskCreate(h, 'tu_1', '1', 'Run tests', 'Running tests');

    // This is the whole bug: upstream leaves this null forever.
    expect(h.state.currentTodos).toEqual([
      { content: 'Run tests', status: 'pending', activeForm: 'Running tests' },
    ]);
    expect(h.todoUpdates.length).toBeGreaterThan(0);
  });

  it('a TaskUpdate moves the todo to in_progress', async () => {
    const h = createHarness();
    await taskCreate(h, 'tu_1', '1', 'Run tests');
    await taskUpdate(h, 'tu_2', '1', 'in_progress');

    expect(h.state.currentTodos?.[0].status).toBe('in_progress');
  });

  it('three creates and one completion produce the "Tasks 1/3" the header shows', async () => {
    const h = createHarness();
    await taskCreate(h, 'tu_1', '1', 'First');
    await taskCreate(h, 'tu_2', '2', 'Second');
    await taskCreate(h, 'tu_3', '3', 'Third');
    await taskUpdate(h, 'tu_4', '2', 'completed');

    const todos = h.state.currentTodos ?? [];
    const done = todos.filter(t => t.status === 'completed').length;
    expect(`Tasks ${done}/${todos.length}`).toBe('Tasks 1/3');
  });

  it('a deleted task leaves the panel instead of counting as done', async () => {
    const h = createHarness();
    await taskCreate(h, 'tu_1', '1', 'Keep');
    await taskCreate(h, 'tu_2', '2', 'Drop');
    await taskUpdate(h, 'tu_3', '2', 'deleted');

    expect(h.state.currentTodos?.map(t => t.content)).toEqual(['Keep']);
  });

  it('two ChatStates keep separate task lists', async () => {
    // A module-global reducer would merge two streaming tabs into one list.
    const a = createHarness();
    const b = createHarness();

    await taskCreate(a, 'tu_1', '1', 'Tab A task');
    await taskCreate(b, 'tu_1', '1', 'Tab B task');

    expect(a.state.currentTodos?.map(t => t.content)).toEqual(['Tab A task']);
    expect(b.state.currentTodos?.map(t => t.content)).toEqual(['Tab B task']);
  });

  it('a new conversation does not inherit the previous task list', async () => {
    const h = createHarness();
    await taskCreate(h, 'tu_1', '1', 'Old task');
    expect(h.state.currentTodos).not.toBeNull();

    h.state.resetForNewConversation();
    expect(h.state.currentTodos).toBeNull();

    await taskCreate(h, 'tu_2', '2', 'New task');
    expect(h.state.currentTodos?.map(t => t.content)).toEqual(['New task']);
  });

  it('a failed TaskCreate does not put a phantom task in the panel', async () => {
    const h = createHarness();
    await h.controller.handleStreamChunk(
      { type: 'tool_use', id: 'tu_1', name: 'TaskCreate', input: { subject: 'Nope', description: 'x' } },
      h.msg,
    );
    await h.controller.handleStreamChunk(
      { type: 'tool_result', id: 'tu_1', content: 'Error: quota exceeded', isError: true },
      h.msg,
    );

    expect(h.state.currentTodos).toBeNull();
  });

  it('still handles plain TodoWrite, so the Codex provider keeps working', async () => {
    // The Codex adapter synthesises a TodoWrite call; that path must not have
    // been disturbed by the task-tool wiring.
    const h = createHarness();
    await h.controller.handleStreamChunk(
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'TodoWrite',
        input: { todos: [{ content: 'Legacy', status: 'pending', activeForm: 'Legacy' }] },
      },
      h.msg,
    );

    expect(h.state.currentTodos?.map(t => t.content)).toEqual(['Legacy']);
  });
});
