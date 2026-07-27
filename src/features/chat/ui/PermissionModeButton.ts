import type { ProviderPermissionModeToggleConfig } from '../../../core/providers/types';

/**
 * mazel: the three-state permission chip in the composer.
 *
 * Upstream ships a two-state slider: Safe ⇄ YOLO. Plan mode has a label in the
 * same shell but no way to reach it from the mouse — it only appears once the
 * SDK or Shift+Tab has already put the session into plan. So the third mode was
 * visible but not selectable, and the two that were selectable applied to the
 * PROVIDER, i.e. to every tab at once. Flipping tab 1 to Safe silently flipped
 * tab 2 and tab 3 with it.
 *
 * This replaces the slider with a chip that cycles Safe → YOLO → Plan → Safe.
 * It was a runtime injection (`ui-fixes.js` Fix 2 v5) from the 1.3.72 era, kept
 * alive by a MutationObserver that re-ran the whole script on every DOM change.
 * That is why it existed at all, and why it had to go: an injection that
 * rebuilds `.claudian-permission-toggle` from the outside races the component
 * that owns it, and nothing in the build or the test suite could see it.
 *
 * The chip holds no mode of its own. It asks for the current one on every
 * render, so it cannot drift away from the tab it belongs to — the failure mode
 * of the injected version, which cached the mode in a DOM attribute and lost it
 * whenever the composer was rebuilt.
 */
export interface PermissionModeButtonCallbacks {
  /** The mode of the tab this chip belongs to. Per tab, never the global one. */
  getMode: () => string;
  /** Provider-owned labels and values, or null when the provider has no such UI. */
  getToggleConfig: () => ProviderPermissionModeToggleConfig | null;
  /** Plan is offered only where the provider can actually enter it. */
  supportsPlanMode: () => boolean;
  onModeChange: (mode: string) => Promise<void>;
}

/**
 * The one mode that answers every approval request with "allow" before the
 * prompt is ever built.
 *
 * Exported because the decision belongs in exactly one place. The chip shows
 * it, the tab's approval callback acts on it, and if those two ever disagree
 * the user sees YOLO while a modal waits for a click — or worse, sees Safe
 * while tools run unasked.
 */
export function autoApprovesEveryTool(mode: string): boolean {
  return mode === 'yolo';
}

/** State class on the chip. Drives the colour, nothing else. */
export function permissionModeStateClass(mode: string): string {
  if (mode === 'yolo') return 'mode-yolo';
  if (mode === 'plan') return 'mode-plan';
  return 'mode-safe';
}

const ALL_STATE_CLASSES = ['mode-safe', 'mode-yolo', 'mode-plan'] as const;

/**
 * Steps one position along the cycle.
 *
 * An unknown current mode lands on the first entry rather than staying put: a
 * chip that refuses to move because it does not recognise itself is a dead
 * control, and the user has no way to tell that from a stuck click handler.
 */
export function nextPermissionMode(current: string, available: readonly string[]): string {
  if (available.length === 0) return current;
  const index = available.indexOf(current);
  if (index === -1) return available[0];
  return available[(index + 1) % available.length];
}

/**
 * Safe → YOLO → Plan, in that order, taken from the provider's own toggle
 * descriptor rather than hard-coded. Providers disagree on the values (Codex,
 * OpenCode and Pi map them onto their own sandbox notions), and a hard-coded
 * 'normal' would write a mode those providers never asked for.
 */
export function availablePermissionModes(
  config: ProviderPermissionModeToggleConfig | null,
  supportsPlanMode: boolean,
): string[] {
  if (!config) return [];
  const modes = [config.inactiveValue, config.activeValue];
  if (config.planValue && supportsPlanMode) modes.push(config.planValue);
  return modes;
}

export class PermissionModeButton {
  private readonly buttonEl: HTMLElement;
  private readonly callbacks: PermissionModeButtonCallbacks;
  private readonly handleClick: (event: MouseEvent) => void;

  constructor(parentEl: HTMLElement, callbacks: PermissionModeButtonCallbacks) {
    this.callbacks = callbacks;
    this.buttonEl = parentEl.createDiv({ cls: 'claudian-mode-button' });
    // A div is not focusable and not announced without these two. The injected
    // version had neither, so the only way to change mode was the mouse.
    this.buttonEl.setAttribute('role', 'button');
    this.buttonEl.setAttribute('tabindex', '0');

    this.handleClick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      void this.cycle();
    };
    this.buttonEl.addEventListener('click', this.handleClick);

    this.updateDisplay();
  }

  /** The modes this chip will cycle through, in cycle order. */
  getAvailableModes(): string[] {
    return availablePermissionModes(
      this.callbacks.getToggleConfig(),
      this.callbacks.supportsPlanMode(),
    );
  }

  updateDisplay(): void {
    const config = this.callbacks.getToggleConfig();
    const mode = this.callbacks.getMode();
    const stateClass = permissionModeStateClass(mode);

    for (const cls of ALL_STATE_CLASSES) {
      this.buttonEl.toggleClass(cls, cls === stateClass);
    }

    this.buttonEl.setText(this.labelFor(mode, config));
    // The mode is on the element as well as in the text, because the text is a
    // provider-supplied label and a runtime assertion must not have to guess
    // which string means which mode.
    this.buttonEl.setAttribute('data-permission-mode', mode);
    this.buttonEl.setAttribute('aria-label', `Permission mode: ${this.labelFor(mode, config)}`);
  }

  private labelFor(mode: string, config: ProviderPermissionModeToggleConfig | null): string {
    if (!config) return mode;
    if (mode === config.planValue) return config.planLabel ?? 'PLAN';
    if (mode === config.activeValue) return config.activeLabel;
    if (mode === config.inactiveValue) return config.inactiveLabel;
    return mode;
  }

  private async cycle(): Promise<void> {
    const available = this.getAvailableModes();
    if (available.length === 0) return;
    const next = nextPermissionMode(this.callbacks.getMode(), available);
    await this.callbacks.onModeChange(next);
    this.updateDisplay();
  }

  destroy(): void {
    this.buttonEl.removeEventListener('click', this.handleClick);
    this.buttonEl.remove();
  }
}
