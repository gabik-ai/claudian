/**
 * Stop-hook feedback detection.
 *
 * When a `Stop` hook answers with `{"decision":"block","reason":"..."}`, the Claude
 * CLI does NOT retract the assistant message that was already streamed. It injects a
 * synthetic user message and lets the model answer a second time. Without special
 * handling the retry is appended to the SAME bubble, so the user reads the discarded
 * draft and the rewrite back to back.
 *
 * Measured shape of that injected message (Agent SDK 2.1.x, probe on 2026-07-29):
 *   { type: 'user', isSynthetic: true,
 *     message: { role: 'user', content: 'Stop hook feedback:\n<reason>' } }
 *
 * Detection is deliberately prefix-based on the CLI-owned constant plus the
 * `isSynthetic` marker. Both must match, so a human message quoting the prefix
 * cannot trigger a discard.
 */

export const STOP_HOOK_FEEDBACK_PREFIX = 'Stop hook feedback:';

/**
 * Vault-owned fallback marker.
 *
 * `Stop hook feedback:` belongs to the CLI and can be renamed by an upstream
 * release without warning. Our own Stop hook therefore starts every reason with
 * this token, so detection survives a CLI rename. Kept in sync with
 * `.claude/scripts/antwort-stil-hook.py` by `.claude/scripts/stil-block-marker-check.py`.
 */
export const STIL_BLOCK_MARKER = '[STIL-BLOCK]';

/**
 * Returns the hook reason when `message` is stop-hook feedback, otherwise `null`.
 */
export function extractStopHookFeedback(message: { type: string }): string | null {
  if (message.type !== 'user') return null;

  const record = message as Record<string, unknown>;
  if (record.isSynthetic !== true) return null;

  const inner = record.message as { content?: unknown } | undefined;
  const content = inner?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
        .filter((block): block is { type: string; text: string } =>
          typeof block === 'object'
          && block !== null
          && (block as { type?: unknown }).type === 'text'
          && typeof (block as { text?: unknown }).text === 'string'
        )
        .map(block => block.text)
        .join('')
      : null;

  if (typeof text !== 'string') return null;

  if (text.startsWith(STOP_HOOK_FEEDBACK_PREFIX)) {
    return text.slice(STOP_HOOK_FEEDBACK_PREFIX.length).trim();
  }

  // CLI prefix renamed? Our own marker still identifies the block.
  const markerIndex = text.indexOf(STIL_BLOCK_MARKER);
  if (markerIndex >= 0) {
    return text.slice(markerIndex + STIL_BLOCK_MARKER.length).trim();
  }

  return null;
}
