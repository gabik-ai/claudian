/**
 * Mazel patch M11: eine Bash-Zeile zeigt eingeklappt die Beschreibung, nicht den Befehl.
 *
 * Das Bash-Tool hat ein Pflichtfeld `description`. Das Modell füllt es bei jedem
 * Aufruf aus, upstream wirft es weg und zeigt stattdessen die ersten 60 Zeichen des
 * Befehls. Bei mehreren Aufrufen hintereinander sieht der Leser damit eine Wand aus
 * abgeschnittenen Shell-Zeilen und weiß nicht, was gerade passiert.
 *
 * Der Patch kostet keine Tokens: das Feld wird ohnehin geschrieben.
 *
 * Zugesichert wird hier viererlei:
 *   1. mit Beschreibung steht die Beschreibung in der Kopfzeile (Positivfall);
 *   2. ohne Beschreibung steht weiter der Befehl da (Negativkontrolle, sonst wäre
 *      ein Patch, der schlicht immer leert, ebenfalls grün);
 *   3. der vollständige Befehl bleibt im aufgeklappten Körper erhalten, wir
 *      verstecken ihn also nicht, sondern verschieben ihn nur einen Klick weit;
 *   4. das ARIA-Label liest dieselbe Quelle vor wie die sichtbare Zeile.
 *
 * Behauptet wird gegen das gerenderte DOM, nicht gegen Quelltext: ein Rebase, der
 * upstreams Fassung stillschweigend zurückholt, färbt diesen Test rot.
 */
import { createMockEl } from '@test/helpers/mockElement';

import type { ToolCallInfo } from '@/core/types';
import {
  getToolLabel,
  getToolSummary,
  renderToolCall,
} from '@/features/chat/rendering/ToolCallRenderer';

import { readUpstreamFile } from './upstreamRef';

jest.mock('obsidian', () => ({
  setIcon: jest.fn(),
}));

const RENDERER_PATH = 'src/features/chat/rendering/ToolCallRenderer.ts';

function bashCall(input: Record<string, unknown>): ToolCallInfo {
  return { id: 'tool-m11', name: 'Bash', input, status: 'running' };
}

function headerText(input: Record<string, unknown>): string {
  const toolEl = renderToolCall(createMockEl(), bashCall(input), new Map());
  return toolEl.querySelector('.claudian-tool-summary')?.textContent ?? '';
}

function bodyCommand(input: Record<string, unknown>): string {
  const toolEl = renderToolCall(createMockEl(), bashCall(input), new Map());
  return toolEl.querySelector('.claudian-tool-bash-command')?.textContent ?? '';
}

describe('M11: Bash-Zeile zeigt die Beschreibung', () => {
  it('zeigt die Beschreibung statt des Befehls, wenn beide da sind', () => {
    const input = {
      command: 'cd .claudian/sessions && python3 -c "import json, sys; print(json.load(sys.stdin))"',
      description: 'Session-Transkripte nach Trendbox-Erwähnungen durchsuchen',
    };

    expect(headerText(input)).toBe('Session-Transkripte nach Trendbox-Erwähnungen durchsuchen');
    expect(headerText(input)).not.toContain('python3');
  });

  it('fällt auf den Befehl zurück, wenn keine Beschreibung da ist', () => {
    // Negativkontrolle: ältere Historie und andere Provider liefern kein description-Feld.
    expect(headerText({ command: 'npm test' })).toBe('npm test');
    expect(getToolSummary('Bash', { command: 'npm test' })).toBe('npm test');
  });

  it('behandelt eine leere Beschreibung wie eine fehlende', () => {
    expect(getToolSummary('Bash', { command: 'npm test', description: '' })).toBe('npm test');
    expect(getToolSummary('Bash', { command: 'npm test', description: '   ' })).toBe('npm test');
  });

  it('kürzt eine zu lange Beschreibung auf 60 Zeichen', () => {
    const lang = 'b'.repeat(80);
    expect(getToolSummary('Bash', { command: 'npm test', description: lang })).toBe(
      'b'.repeat(60) + '...'
    );
  });

  it('behält den vollständigen Befehl im aufgeklappten Körper', () => {
    // Der Befehl verschwindet nicht, er rückt einen Klick weiter.
    const command = 'git rev-list --count HEAD';
    expect(bodyCommand({ command, description: 'Commits zählen' })).toBe(`$ ${command}`);
  });

  it('liest im ARIA-Label dieselbe Quelle vor wie die sichtbare Zeile', () => {
    expect(getToolLabel('Bash', { command: 'npm test', description: 'Tests laufen lassen' })).toBe(
      'Bash: Tests laufen lassen'
    );
    expect(getToolLabel('Bash', { command: 'npm test' })).toBe('Bash: npm test');
    expect(getToolLabel('Bash', {})).toBe('Bash: command');
  });

  it('Obsoleszenz-Wächter: upstream bevorzugt die Beschreibung noch nicht selbst', () => {
    const upstream = readUpstreamFile(RENDERER_PATH);
    if (upstream === null) return; // lokal ohne origin/main, in CI erzwungen

    const bevorzugtBeschreibung = /getInputText\(input, 'description'\)/.test(upstream);
    expect(bevorzugtBeschreibung).toBe(false);
  });
});
