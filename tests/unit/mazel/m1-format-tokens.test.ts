/**
 * Mazel patch M1: the context meter renders 1M windows as "1M", not "1000k".
 *
 * Upstream's formatTokens only knows the `k` unit, so a 1,000,000-token window
 * reads "1000k" — the exact number that made the tooltip unreadable for us.
 *
 * The assertions go through the public `update()` path and read the rendered
 * tooltip, so a rebase that keeps the source text but breaks the wiring still
 * turns this red.
 */
import { createMockEl } from '@test/helpers/mockElement';
import { execFileSync } from 'child_process';
import { join } from 'path';

import type { UsageInfo } from '@/core/types';
import { ContextUsageMeter } from '@/features/chat/ui/InputToolbar';

jest.mock('obsidian', () => ({
  Notice: jest.fn(),
  setIcon: jest.fn(),
}));

function makeUsage(overrides: Partial<UsageInfo> = {}): UsageInfo {
  return {
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    contextWindow: 200000,
    contextTokens: 0,
    percentage: 0,
    ...overrides,
  };
}

function tooltipFor(contextTokens: number, contextWindow: number): string {
  const parentEl = createMockEl();
  const meter = new ContextUsageMeter(parentEl);
  meter.update(makeUsage({
    contextTokens,
    contextWindow,
    percentage: Math.round((contextTokens / contextWindow) * 100),
  }));
  const container = parentEl.querySelector('.claudian-context-meter');
  return String(container?.getAttribute('data-tooltip') ?? '');
}

describe('mazel patch M1: formatTokens', () => {
  it('renders a 1M window as "1M", never "1000k"', () => {
    const tooltip = tooltipFor(250_000, 1_000_000);
    expect(tooltip).toContain('1M');
    expect(tooltip).not.toContain('1000k');
  });

  it('keeps one decimal for partial millions', () => {
    expect(tooltipFor(1_200_000, 2_000_000)).toContain('1.2M');
  });

  it('drops the decimal above 10M', () => {
    const tooltip = tooltipFor(12_400_000, 20_000_000);
    expect(tooltip).toContain('12M');
    expect(tooltip).not.toContain('12.4M');
  });

  it('promotes a value that would round up to four digits of k', () => {
    // 999_999 / 1000 rounds to 1000 — must not print "1000k".
    const tooltip = tooltipFor(999_999, 1_000_000);
    expect(tooltip).not.toContain('1000k');
    expect(tooltip.startsWith('1M')).toBe(true);
  });

  it('leaves the k range untouched (no upstream regression)', () => {
    const tooltip = tooltipFor(120_000, 200_000);
    expect(tooltip).toContain('120k');
    expect(tooltip).toContain('200k');
  });

  it('leaves sub-1000 values as plain numbers', () => {
    expect(tooltipFor(512, 200_000)).toContain('512');
  });
});

describe('obsolescence guard: M1', () => {
  it('upstream formatTokens still has no million branch', () => {
    // If upstream learns the M unit itself, this patch is dead weight and the
    // guard says so instead of us carrying it for months unnoticed.
    const repoRoot = join(__dirname, '..', '..', '..');

    let upstreamSource: string;
    try {
      upstreamSource = execFileSync(
        'git',
        ['show', 'origin/main:src/features/chat/ui/InputToolbar.ts'],
        { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      );
    } catch {
      // origin/main not fetched (shallow or single-branch checkout) — skip.
      return;
    }

    const match = /private formatTokens\(tokens: number\): string \{[\s\S]*?\n {2}\}/.exec(upstreamSource);
    expect(match).not.toBeNull();
    const body = match?.[0] ?? '';
    expect(body).not.toMatch(/1_000_000|1000000|'M'|`\$\{[^}]*\}M`/);
  });
});
