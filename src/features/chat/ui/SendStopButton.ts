import { setIcon } from 'obsidian';

/**
 * mazel: an explicit send / stop control in the composer.
 *
 * Upstream 2.0.41 has no such button at all (0 hits in the whole tree). The
 * only ways to send are Enter and Cmd/Ctrl+Enter, and the only way to stop is
 * Escape — all of which require the textarea to have focus. After scrolling
 * back through a long answer, stopping a runaway turn means clicking into the
 * input first and only then hitting Escape.
 *
 * One button, two states, so the affordance is always visible and always
 * reachable with the mouse.
 */
export interface SendStopButtonCallbacks {
  onSend: () => void;
  onStop: () => void;
}

const SEND_LABEL = 'Send message';
const STOP_LABEL = 'Stop generating';

export class SendStopButton {
  private readonly buttonEl: HTMLElement;
  private readonly callbacks: SendStopButtonCallbacks;
  private streaming = false;
  private readonly handleClick: (event: MouseEvent) => void;

  constructor(parentEl: HTMLElement, callbacks: SendStopButtonCallbacks) {
    this.callbacks = callbacks;
    this.buttonEl = parentEl.createDiv({ cls: 'claudian-send-stop-btn' });
    this.buttonEl.setAttribute('role', 'button');
    this.buttonEl.setAttribute('tabindex', '0');

    this.handleClick = (event: MouseEvent) => {
      // The composer sits inside clickable chrome; without this a click can
      // bubble up and refocus or switch things underneath.
      event.preventDefault();
      event.stopPropagation();
      if (this.streaming) {
        this.callbacks.onStop();
      } else {
        this.callbacks.onSend();
      }
    };

    this.buttonEl.addEventListener('click', this.handleClick);
    this.render();
  }

  /**
   * Flips the button between send and stop.
   *
   * Called from ChatState's streaming callback, so the button cannot drift out
   * of sync with the actual stream — which is the failure mode of a button that
   * tracks its own idea of "am I sending".
   */
  setStreaming(isStreaming: boolean): void {
    if (this.streaming === isStreaming) return;
    this.streaming = isStreaming;
    this.render();
  }

  isStreaming(): boolean {
    return this.streaming;
  }

  private render(): void {
    const label = this.streaming ? STOP_LABEL : SEND_LABEL;
    this.buttonEl.toggleClass('claudian-send-stop-btn--streaming', this.streaming);
    this.buttonEl.setAttribute('aria-label', label);
    this.buttonEl.setAttribute('data-state', this.streaming ? 'stop' : 'send');
    // play/square, not arrow-up/square. The retired full-width button used a
    // play triangle and Gabriel reads that pair as "run / halt"; an arrow reads
    // as "submit", which is the same act but a different mental picture. Kept
    // deliberately in sync with the colours in input.css.
    setIcon(this.buttonEl, this.streaming ? 'square' : 'play');
  }

  destroy(): void {
    this.buttonEl.removeEventListener('click', this.handleClick);
    this.buttonEl.remove();
  }
}
