/**
 * Mazel patch M2: the MCP selector sits before the external-context selector.
 *
 * Upstream builds the toolbar in the order
 *   … contextUsageMeter, externalContextSelector, mcpServerSelector, …
 * We want MCP first, because it is the control we reach for constantly while
 * the external-context picker is the rare one.
 *
 * Asserted on real DOM position, not on source text: construction order in
 * createInputToolbar() IS append order IS DOM order IS tab order. A rebase
 * that silently restores upstream's order turns this red.
 */
import { createMockEl } from '@test/helpers/mockElement';

import { createInputToolbar } from '@/features/chat/ui/InputToolbar';

import { readUpstreamFile } from './upstreamRef';

jest.mock('obsidian', () => ({
  Notice: jest.fn(),
  setIcon: jest.fn(),
}));

const MCP = 'claudian-mcp-selector';
const EXTERNAL = 'claudian-external-context-selector';
const METER = 'claudian-context-meter';

function createMockCallbacks(): never {
  const uiConfig = {
    getProviderIcon: jest.fn().mockReturnValue(null),
    getModelOptions: jest.fn().mockReturnValue([{ value: 'sonnet', label: 'Sonnet' }]),
    isAdaptiveReasoningModel: jest.fn().mockReturnValue(true),
    getReasoningOptions: jest.fn().mockReturnValue([{ value: 'high', label: 'High' }]),
    getDefaultReasoningValue: jest.fn().mockReturnValue('high'),
    getContextWindowSize: jest.fn().mockReturnValue(200000),
    isDefaultModel: jest.fn().mockReturnValue(true),
    applyModelDefaults: jest.fn(),
    normalizeModelVariant: jest.fn((model: string) => model),
    getPermissionModeToggle: jest.fn().mockReturnValue({
      inactiveValue: 'normal',
      inactiveLabel: 'Safe',
      activeValue: 'yolo',
      activeLabel: 'YOLO',
      planValue: 'plan',
      planLabel: 'PLAN',
    }),
    getServiceTierToggle: jest.fn().mockReturnValue(null),
    getModeSelector: jest.fn().mockReturnValue({
      activeValue: 'build',
      label: 'Mode',
      options: [{ value: 'build', label: 'Build', description: 'Default editing agent' }],
      value: 'build',
    }),
  };

  return {
    onModelChange: jest.fn().mockResolvedValue(undefined),
    onModeChange: jest.fn().mockResolvedValue(undefined),
    onThinkingBudgetChange: jest.fn().mockResolvedValue(undefined),
    onEffortLevelChange: jest.fn().mockResolvedValue(undefined),
    onServiceTierChange: jest.fn().mockResolvedValue(undefined),
    onPermissionModeChange: jest.fn().mockResolvedValue(undefined),
    getSettings: jest.fn().mockReturnValue({
      model: 'sonnet',
      thinkingBudget: 'low',
      effortLevel: 'high',
      serviceTier: 'default',
      permissionMode: 'normal',
      selectedMode: 'build',
    }),
    getEnvironmentVariables: jest.fn().mockReturnValue(''),
    getUIConfig: jest.fn().mockReturnValue(uiConfig),
    getCapabilities: jest.fn().mockReturnValue({
      providerId: 'claude',
      supportsPersistentRuntime: true,
      supportsNativeHistory: true,
      supportsPlanMode: true,
      supportsRewind: true,
      supportsFork: true,
      supportsProviderCommands: true,
      reasoningControl: 'effort',
    }),
  } as never;
}

function indexOfClass(parentEl: { children: { hasClass(cls: string): boolean }[] }, cls: string): number {
  return parentEl.children.findIndex((child) => child.hasClass(cls));
}

describe('mazel patch M2: toolbar order', () => {
  it('renders the MCP selector before the external-context selector', () => {
    const parentEl = createMockEl();
    createInputToolbar(parentEl, createMockCallbacks());

    const mcpIndex = indexOfClass(parentEl, MCP);
    const externalIndex = indexOfClass(parentEl, EXTERNAL);

    expect(mcpIndex).toBeGreaterThanOrEqual(0);
    expect(externalIndex).toBeGreaterThanOrEqual(0);
    expect(mcpIndex).toBeLessThan(externalIndex);
  });

  it('does not drop or duplicate any toolbar control', () => {
    const parentEl = createMockEl();
    createInputToolbar(parentEl, createMockCallbacks());

    for (const cls of [MCP, EXTERNAL, METER]) {
      const matches = parentEl.children.filter((child: { hasClass(c: string): boolean }) => child.hasClass(cls));
      expect(matches).toHaveLength(1);
    }
  });

  it('keeps the mode selector last (upstream invariant we must not break)', () => {
    const parentEl = createMockEl();
    createInputToolbar(parentEl, createMockCallbacks());

    expect(indexOfClass(parentEl, 'claudian-mode-selector')).toBe(parentEl.children.length - 1);
  });
});

describe('obsolescence guard: M2', () => {
  it('upstream still builds external-context before MCP', () => {
    // Once upstream adopts our order this patch is dead weight — the guard
    // says so instead of us carrying a no-op commit through every rebase.
    const upstreamSource = readUpstreamFile('src/features/chat/ui/InputToolbar.ts');
    if (upstreamSource === null) return;

    const upstreamExternal = upstreamSource.indexOf('new ExternalContextSelector(parentEl');
    const upstreamMcp = upstreamSource.indexOf('new McpServerSelector(parentEl');
    expect(upstreamExternal).toBeGreaterThanOrEqual(0);
    expect(upstreamMcp).toBeGreaterThanOrEqual(0);
    expect(upstreamExternal).toBeLessThan(upstreamMcp);
  });
});
