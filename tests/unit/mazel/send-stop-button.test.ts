/**
 * Mazel patch: an explicit send / stop control in the composer.
 *
 * Upstream 2.0.41 has no send button anywhere (0 hits in the tree). Sending is
 * Enter or Cmd/Ctrl+Enter, stopping is Escape, and all three require the
 * textarea to have focus. After scrolling back through a long answer, stopping
 * a runaway turn means clicking into the input first.
 *
 * The button deliberately has no opinion of its own about whether a stream is
 * running: it is driven from ChatState. A control that tracks its own flag
 * drifts the moment a stream ends for a reason it never hears about — an
 * error, an abort, a tab switch — and then the only visible "stop" does
 * nothing.
 */
import { createMockEl } from '@test/helpers/mockElement';

import { SendStopButton } from '@/features/chat/ui/SendStopButton';

import { readUpstreamFile } from './upstreamRef';

jest.mock('obsidian', () => ({
  Notice: jest.fn(),
  setIcon: jest.fn((el: { _icon?: string }, icon: string) => {
    el._icon = icon;
  }),
}));

function setup() {
  const parentEl = createMockEl();
  const onSend = jest.fn();
  const onStop = jest.fn();
  const button = new SendStopButton(parentEl, { onSend, onStop });
  const el = parentEl.children[0];
  return { parentEl, button, el, onSend, onStop };
}

function click(el: ReturnType<typeof createMockEl>): void {
  const handlers = el._eventListeners.get('click') ?? [];
  for (const handler of handlers) {
    handler({ type: 'click', preventDefault: jest.fn(), stopPropagation: jest.fn() });
  }
}

describe('mazel: send/stop button', () => {
  it('starts in send state', () => {
    const { el, button } = setup();

    expect(button.isStreaming()).toBe(false);
    expect(el.getAttribute('data-state')).toBe('send');
    expect(el.getAttribute('aria-label')).toBe('Send message');
  });

  it('is reachable without focusing the textarea', () => {
    // The whole point: role + tabindex so it is a real control, not decoration.
    const { el } = setup();

    expect(el.getAttribute('role')).toBe('button');
    expect(el.getAttribute('tabindex')).toBe('0');
  });

  it('sends when clicked while idle', () => {
    const { el, onSend, onStop } = setup();

    click(el);

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('stops when clicked while streaming', () => {
    const { el, button, onSend, onStop } = setup();

    button.setStreaming(true);
    click(el);

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('flips its label and state class with the stream', () => {
    const { el, button } = setup();

    button.setStreaming(true);
    expect(el.getAttribute('data-state')).toBe('stop');
    expect(el.getAttribute('aria-label')).toBe('Stop generating');
    expect(el.hasClass('claudian-send-stop-btn--streaming')).toBe(true);

    button.setStreaming(false);
    expect(el.getAttribute('data-state')).toBe('send');
    expect(el.hasClass('claudian-send-stop-btn--streaming')).toBe(false);
  });

  it('sends again after a stream ends', () => {
    // The regression this guards: a button stuck in "stop" after the stream is
    // over is worse than no button, because clicking it does nothing.
    const { el, button, onSend, onStop } = setup();

    button.setStreaming(true);
    click(el);
    button.setStreaming(false);
    click(el);

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('ignores a repeated setStreaming with the same value', () => {
    const { el, button } = setup();

    button.setStreaming(true);
    const iconAfterFirst = (el as { _icon?: string })._icon;
    button.setStreaming(true);

    expect((el as { _icon?: string })._icon).toBe(iconAfterFirst);
  });

  it('stops responding once destroyed', () => {
    const { el, button, onSend } = setup();

    button.destroy();
    click(el);

    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('obsolescence guard: send/stop button', () => {
  it('upstream still ships no send button', () => {
    const upstreamToolbar = readUpstreamFile('src/features/chat/ui/InputToolbar.ts');
    if (upstreamToolbar === null) return;

    expect(upstreamToolbar).not.toContain('send-stop');
    expect(upstreamToolbar).not.toContain('Stop generating');
  });
});
