// mazel: a turn must end with at least one visible sentence.
//
// Measured 2026-09-09: Codex closed a turn with `output_text: ''` after two
// apply_patch calls, and Claudian showed only the tool rows plus the timer
// line. Claude can do the same when a turn ends on a tool result. The
// InputController appends EMPTY_TURN_NOTE when hasVisibleTurnText says no.
//
// Text means `content` or a text content block with something in it. Tool
// calls, thinking and other blocks are not text: the note is about the answer
// the user reads, not about work that happened.
import type { ChatMessage } from '../../../core/types';

export const EMPTY_TURN_NOTE = '(Antwort ohne Text beendet)';

/**
 * @param pendingText text still buffered in ChatState.currentTextContent, i.e.
 *   streamed but not yet moved into a content block.
 */
export function hasVisibleTurnText(msg: ChatMessage, pendingText = ''): boolean {
  if (msg.content.trim().length > 0) return true;
  if (pendingText.trim().length > 0) return true;
  return msg.contentBlocks?.some(block =>
    block.type === 'text' && block.content.trim().length > 0
  ) ?? false;
}
