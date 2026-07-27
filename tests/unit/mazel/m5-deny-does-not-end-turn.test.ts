/**
 * Mazel patch M5: a denied tool no longer kills the whole response.
 *
 * `createReadOnlyHook` guards inline-edit mode. Upstream returns
 * `{ continue: false, … permissionDecision: 'deny' }`. In the SDK those two
 * fields are orthogonal:
 *   - `permissionDecision: 'deny'`  blocks THIS tool call and hands the reason
 *     back to the model.
 *   - `continue: false`             ends the ENTIRE turn.
 * Setting both means the first non-read-only tool the model reaches for stops
 * the answer mid-sentence with nothing on screen explaining why — the silent
 * cut-off we chased for months.
 *
 * The patch drops `continue` to `true`. The tool stays blocked (the deny does
 * that), the model gets told why, and it can pick a read-only path instead.
 */
import { execFileSync } from 'child_process';
import { join } from 'path';

import { createReadOnlyHook } from '@/providers/claude/auxiliary/ClaudeInlineEditService';

type HookResult = {
  continue?: boolean;
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
};

async function runHook(toolName: string): Promise<HookResult> {
  const hook = createReadOnlyHook();
  const callback = hook.hooks[0] as unknown as (
    input: Record<string, unknown>,
    toolUseId: string | undefined,
    options: Record<string, unknown>,
  ) => Promise<HookResult>;
  return callback({ tool_name: toolName, tool_input: {} }, undefined, {});
}

const BLOCKED_TOOLS = ['Write', 'Edit', 'Bash', 'NotebookEdit'];
const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch'];

describe('mazel patch M5: deny does not end the turn', () => {
  it.each(BLOCKED_TOOLS)('%s is denied but the turn continues', async (toolName) => {
    const result = await runHook(toolName);

    // The important half: no turn-level abort.
    expect(result.continue).toBe(true);
    // The other important half: the tool is still blocked.
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it.each(BLOCKED_TOOLS)('%s still gets a reason the model can act on', async (toolName) => {
    const result = await runHook(toolName);

    expect(result.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain(toolName);
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain('read-only');
  });

  it.each(ALLOWED_TOOLS)('%s passes through untouched', async (toolName) => {
    const result = await runHook(toolName);

    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput).toBeUndefined();
  });

  it('never returns continue:false for any tool name', async () => {
    for (const toolName of [...ALLOWED_TOOLS, ...BLOCKED_TOOLS, 'SomeUnknownTool']) {
      const result = await runHook(toolName);
      expect(result.continue).not.toBe(false);
    }
  });
});

describe('obsolescence guard: M5', () => {
  it('upstream still aborts the turn on deny', () => {
    // The day upstream stops sending `continue: false` here, this patch is a
    // no-op and should be deleted rather than carried through every rebase.
    const repoRoot = join(__dirname, '..', '..', '..');

    let upstreamSource: string;
    try {
      upstreamSource = execFileSync(
        'git',
        ['show', 'origin/main:src/providers/claude/auxiliary/ClaudeInlineEditService.ts'],
        { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      );
    } catch {
      // origin/main not fetched (shallow or single-branch checkout) — skip.
      return;
    }

    const hookBody = /export function createReadOnlyHook\(\)[\s\S]*?\n\}/.exec(upstreamSource)?.[0] ?? '';
    expect(hookBody).not.toBe('');
    expect(hookBody).toContain('continue: false');
  });
});
