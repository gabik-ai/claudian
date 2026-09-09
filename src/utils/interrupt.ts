const INTERRUPT_MARKERS = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
]);

const COMPACTION_CANCELED_STDERR_PATTERN =
  /^<local-command-stderr>\s*Error:\s*Compaction canceled\.?\s*<\/local-command-stderr>$/i;

const LEGACY_INTERRUPT_INDICATOR_HTML =
  '<span class="claudian-interrupted">Interrupted</span> <span class="claudian-interrupted-hint">· What should Claudian do instead?</span>';

function normalize(text: string): string {
  return text.trim();
}

export function isBracketInterruptText(text: string): boolean {
  return INTERRUPT_MARKERS.has(normalize(text));
}

export function isCompactionCanceledStderr(text: string): boolean {
  return COMPACTION_CANCELED_STDERR_PATTERN.test(normalize(text));
}

export function isInterruptSignalText(text: string): boolean {
  return isBracketInterruptText(text) || isCompactionCanceledStderr(text);
}

export function stripLegacyInterruptIndicator(text: string): {
  content: string;
  interrupted: boolean;
} {
  const markerIndex = text.lastIndexOf(LEGACY_INTERRUPT_INDICATOR_HTML);
  if (
    markerIndex === -1
    || text.slice(markerIndex + LEGACY_INTERRUPT_INDICATOR_HTML.length).trim().length > 0
  ) {
    return { content: text, interrupted: false };
  }

  return {
    content: text.slice(0, markerIndex).trimEnd(),
    interrupted: true,
  };
}

// mazel: the Claude CLI closes an interrupted turn with a `result` whose
// `errors` carry one diagnostic line, measured 2026-09-09 after Escape:
//   [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use(background task completed)
// It describes the state the interrupt left behind, not a failure the user
// can act on. Claudian rendered it as a red error under the "Interrupted"
// indicator. Both the runtime and the stream renderer use this predicate to
// drop that line once a cancel happened; every other error stays visible.
export const INTERRUPT_DIAGNOSTIC_PREFIX = '[ede_diagnostic]';

export function isInterruptDiagnosticText(text: string): boolean {
  return text.trimStart().startsWith(INTERRUPT_DIAGNOSTIC_PREFIX);
}
