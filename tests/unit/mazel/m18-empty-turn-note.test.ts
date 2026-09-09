/**
 * Mazel patch 18, part B: a turn that ends without text gets a visible note.
 *
 * Measured 2026-09-09: Codex finished a turn with `output_text: ''` after two
 * apply_patch calls. Claudian showed the tool rows and "Stirred for 15s" and
 * nothing else, so the user could not tell whether the answer was missing or
 * simply empty. Claude can end the same way when a turn stops on a tool
 * result. The InputController now appends `(Antwort ohne Text beendet)` when
 * the final assistant message carries no text. Tool blocks do not count.
 * Cancelled turns already show the interrupt indicator, compaction turns
 * their boundary, so both stay untouched.
 */
import type { ChatMessage } from '@/core/types';
import { InputController } from '@/features/chat/controllers/InputController';
import { EMPTY_TURN_NOTE, hasVisibleTurnText } from '@/features/chat/utils/emptyTurn';

import { createControllerDeps } from './helpers/inputControllerDeps';

jest.mock('@/shared/components/ResumeSessionDropdown', () => ({
  ResumeSessionDropdown: jest.fn(),
}));

beforeAll(() => {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
});

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'a1', role: 'assistant', content: '', timestamp: 0, toolCalls: [], contentBlocks: [], ...overrides };
}

const TOOL_CALL = { id: 't1', name: 'Bash', input: { command: 'ls' }, status: 'completed' as const };

describe('mazel patch 18: what counts as visible text', () => {
  it('an empty message has no text', () => {
    expect(hasVisibleTurnText(message())).toBe(false);
    expect(hasVisibleTurnText(message({ content: '   \n' }))).toBe(false);
  });

  it('content or a filled text block is text', () => {
    expect(hasVisibleTurnText(message({ content: 'Fertig.' }))).toBe(true);
    expect(hasVisibleTurnText(message({ contentBlocks: [{ type: 'text', content: 'Fertig.' }] }))).toBe(true);
  });

  it('text still buffered in the stream counts too', () => {
    expect(hasVisibleTurnText(message(), 'noch nicht finalisiert')).toBe(true);
    expect(hasVisibleTurnText(message(), '  ')).toBe(false);
  });

  it('tool calls and thinking are work, not text', () => {
    const toolOnly = message({
      toolCalls: [TOOL_CALL],
      contentBlocks: [{ type: 'tool_use', toolId: 't1' }, { type: 'thinking', content: 'hmm' }],
    });
    expect(hasVisibleTurnText(toolOnly)).toBe(false);
  });

  it('the note itself is short, German and carries no dash', () => {
    expect(EMPTY_TURN_NOTE).toBe('(Antwort ohne Text beendet)');
    expect(EMPTY_TURN_NOTE).not.toMatch(/[–—]/);
  });
});

describe('mazel patch 18: the InputController appends the note', () => {
  function streamOf(chunks: unknown[]) {
    return () => (async function* () {
      for (const chunk of chunks) yield chunk;
    })();
  }

  /** Mirrors the real StreamController just enough: text lands in msg.content. */
  function mirrorText(deps: ReturnType<typeof createControllerDeps>): void {
    deps.handleStreamChunk.mockImplementation(async (chunk: { type: string; content?: string }, msg: ChatMessage) => {
      if (chunk.type === 'text') msg.content += chunk.content ?? '';
      if (chunk.type === 'context_compacted') {
        msg.contentBlocks = msg.contentBlocks ?? [];
        msg.contentBlocks.push({ type: 'context_compacted' });
      }
    });
  }

  const assistant = (deps: ReturnType<typeof createControllerDeps>) =>
    deps.state.messages.find(m => m.role === 'assistant') as ChatMessage;

  it('a turn made only of tool calls ends with the note', async () => {
    const deps = createControllerDeps();
    mirrorText(deps);
    deps.query.mockImplementation(streamOf([
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_result', id: 't1', content: 'a b c' },
      { type: 'done' },
    ]));
    deps.getInputEl().value = 'lies das Verzeichnis';

    await new InputController(deps).sendMessage();

    expect(deps.appendText).toHaveBeenCalledWith(EMPTY_TURN_NOTE);
    expect(assistant(deps).content).toBe(EMPTY_TURN_NOTE);
  });

  it('a Codex-style empty final message (no chunks at all) ends with the note', async () => {
    const deps = createControllerDeps();
    mirrorText(deps);
    deps.query.mockImplementation(streamOf([{ type: 'done' }]));
    deps.getInputEl().value = 'hallo';

    await new InputController(deps).sendMessage();

    expect(deps.appendText).toHaveBeenCalledWith(EMPTY_TURN_NOTE);
  });

  it('a turn with text does not get the note', async () => {
    const deps = createControllerDeps();
    mirrorText(deps);
    deps.query.mockImplementation(streamOf([
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'text', content: 'Drei Dateien.' },
      { type: 'done' },
    ]));
    deps.getInputEl().value = 'hallo';

    await new InputController(deps).sendMessage();

    expect(deps.appendText).not.toHaveBeenCalledWith(EMPTY_TURN_NOTE);
    expect(assistant(deps).content).toBe('Drei Dateien.');
  });

  it('a cancelled turn keeps the interrupt indicator and gets no note', async () => {
    const deps = createControllerDeps();
    mirrorText(deps);
    const controller = new InputController(deps);
    deps.query.mockImplementation(() => (async function* () {
      yield { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 99' } };
      controller.cancelStreaming('escape');
      yield { type: 'done' };
    })());
    deps.getInputEl().value = 'hallo';

    await controller.sendMessage();

    expect(deps.appendInterruptIndicator).toHaveBeenCalledTimes(1);
    expect(deps.appendText).not.toHaveBeenCalledWith(EMPTY_TURN_NOTE);
  });

  it('a compaction turn shows its boundary and gets no note', async () => {
    const deps = createControllerDeps();
    mirrorText(deps);
    deps.query.mockImplementation(streamOf([{ type: 'context_compacted' }, { type: 'done' }]));
    deps.getInputEl().value = '/compact';

    await new InputController(deps).sendMessage();

    expect(deps.appendText).not.toHaveBeenCalledWith(EMPTY_TURN_NOTE);
  });

  it('a turn that failed with an exception keeps its error line and gets no note', async () => {
    const deps = createControllerDeps();
    mirrorText(deps);
    // The catch block writes the error through appendText; the real
    // StreamController would leave it in currentTextContent, mirror that.
    deps.appendText.mockImplementation(async (text: string) => {
      deps.state.currentTextContent += text;
    });
    deps.query.mockImplementation(() => (async function* () {
      yield { type: 'tool_use', id: 't1', name: 'Bash', input: {} };
      throw new Error('CLI weg');
    })());
    deps.getInputEl().value = 'hallo';

    await new InputController(deps).sendMessage();

    expect(deps.appendText).toHaveBeenCalledWith(expect.stringContaining('CLI weg'));
    expect(deps.appendText).not.toHaveBeenCalledWith(EMPTY_TURN_NOTE);
  });
});
