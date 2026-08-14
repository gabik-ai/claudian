/**
 * Mazel Patch M10: der deterministische Stil-Filter wirkt auch beim Rendern aus
 * der Historie und beim Kopieren.
 *
 * Die Fälle sind eins zu eins aus der Python-Suite
 * `.claude/scripts/stil-filter-test.py` übernommen, damit beide Fassungen
 * denselben Text meinen. Weicht die eine Seite ab, wird das hier rot.
 */
import { createMockEl } from '@test/helpers/mockElement';
import { readFileSync } from 'fs';
import { MarkdownRenderer } from 'obsidian';
import { resolve } from 'path';

import type { ChatMessage } from '@/core/types';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { applyStilFilter, filtereAbschnitt } from '@/utils/stilFilter';

jest.mock('@/utils/imageEmbed', () => ({
  replaceImageEmbedsWithHtml: jest.fn().mockImplementation((md: string) => md),
}));
jest.mock('@/utils/fileLink', () => ({
  processFileLinks: jest.fn(),
  registerFileLinkHandler: jest.fn(),
}));

const f = (text: string, imCode = false, letzteOffen = false): string =>
  filtereAbschnitt(text, imCode, letzteOffen).text;

const MIT_STRICH = 'Der Deploy lief — die URL hinkt.';
const OHNE_STRICH = 'Der Deploy lief, die URL hinkt.';

function createRenderer() {
  const messagesEl = createMockEl();
  const component = {
    registerDomEvent: jest.fn(),
    register: jest.fn(),
    addChild: jest.fn(),
    load: jest.fn(),
    unload: jest.fn(),
  };
  const plugin = { app: {}, settings: { mediaFolder: '' } };
  return new MessageRenderer(
    plugin as never,
    component as never,
    messagesEl as never
  );
}

/** Der Text, den MarkdownRenderer.render zuletzt wirklich zu sehen bekam. */
function zuletztGerendert(): string {
  const aufrufe = (MarkdownRenderer.render as jest.Mock).mock.calls;
  return aufrufe[aufrufe.length - 1][1] as string;
}

function nachrichtMitText(role: 'user' | 'assistant', text: string): ChatMessage {
  return {
    id: `m-${role}`,
    role,
    content: text,
    timestamp: Date.now(),
    toolCalls: [],
    contentBlocks: role === 'assistant' ? [{ type: 'text', content: text }] : [],
  } as unknown as ChatMessage;
}

describe('M10 Stil-Filter: Striche', () => {
  it('ersetzt den Geviertstrich mit Leerzeichen durch ein Komma', () => {
    expect(f('Der Deploy lief — die URL hinkt.')).toBe('Der Deploy lief, die URL hinkt.');
  });

  it('ersetzt den Halbgeviertstrich mit Leerzeichen durch ein Komma', () => {
    expect(f('Fertig – mehr nicht.')).toBe('Fertig, mehr nicht.');
  });

  it('macht aus einem Zahlenbereich ein "bis"', () => {
    expect(f('Das dauert 10–15 Minuten.')).toBe('Das dauert 10 bis 15 Minuten.');
  });

  it('ersetzt einen Strich ohne Leerzeichen zwischen Wörtern', () => {
    expect(f('Setup—Fertig')).toBe('Setup, Fertig');
  });

  it('lässt einen Strich in Inline-Code stehen', () => {
    expect(f('Nimm `a — b` so.')).toBe('Nimm `a — b` so.');
  });

  it('lässt einen Strich in einer URL stehen', () => {
    expect(f('Siehe https://x.de/a–b hier.')).toBe('Siehe https://x.de/a–b hier.');
  });

  it('lässt einen Strich in einem Wikilink stehen', () => {
    expect(f('Siehe [[a–b]] dort.')).toBe('Siehe [[a–b]] dort.');
  });
});

describe('M10 Stil-Filter: Trennlinie und Struktur', () => {
  it('verschluckt die Trennlinie, nicht den Text darunter', () => {
    expect(f('oben\n---\nunten')).toBe('oben\nunten');
  });

  it('lässt den Tabellentrenner stehen', () => {
    expect(f('|---|---|')).toBe('|---|---|');
  });

  it('lässt ein Bullet unverändert', () => {
    expect(f('- ein Punkt')).toBe('- ein Punkt');
  });

  it('lässt ein Zitatblock-Zeichen und eine Überschrift unverändert', () => {
    expect(f('> ein Zitat mit 10–15 Minuten.\n# Titel')).toBe(
      '> ein Zitat mit 10 bis 15 Minuten.\n# Titel'
    );
  });
});

describe('M10 Stil-Filter: Emojis', () => {
  it('entfernt das zweite Emoji einer Zeile', () => {
    expect(f('✅ fertig 🎉 geprüft')).toBe('✅ fertig geprüft');
  });

  it('lässt ein einzelnes Emoji stehen', () => {
    expect(f('✅ fertig')).toBe('✅ fertig');
  });

  it('lässt eine Tabellenzeile mit vielen Emojis unangetastet', () => {
    expect(f('| ✅ | 🎯 | 💭 | ⚠️ |')).toBe('| ✅ | 🎯 | 💭 | ⚠️ |');
  });

  it('lässt Emojis in einem Code-Block stehen', () => {
    expect(f('```\n✅ 🎯 🎉\n```')).toBe('```\n✅ 🎯 🎉\n```');
  });
});

describe('M10 Stil-Filter: Absatzumbruch', () => {
  it('lässt drei Sätze in einer Zeile', () => {
    expect(f('Eins ist da. Zwei ist da. Drei ist da.')).toBe(
      'Eins ist da. Zwei ist da. Drei ist da.'
    );
  });

  it('bricht nach dem dritten Satz um', () => {
    expect(f('Eins ist da. Zwei ist da. Drei ist da. Vier ist da.')).toBe(
      'Eins ist da. Zwei ist da. Drei ist da.\n\nVier ist da.'
    );
  });

  it('bricht ein Bullet mit vier Sätzen nicht um', () => {
    expect(f('- Eins ist da. Zwei ist da. Drei ist da. Vier ist da.')).toBe(
      '- Eins ist da. Zwei ist da. Drei ist da. Vier ist da.'
    );
  });

  it('lässt einen reinen Fett-Titel unangetastet', () => {
    expect(f('**Der Titel**')).toBe('**Der Titel**');
  });

  it('hält Tausendertrennung nicht für ein Satzende', () => {
    expect(f('Es sind 11.883 Zeichen. Das ist viel. Mehr nicht. Ende.')).toBe(
      'Es sind 11.883 Zeichen. Das ist viel. Mehr nicht.\n\nEnde.'
    );
  });
});

describe('M10 Stil-Filter: Code und Zustand', () => {
  it('lässt einen Code-Block komplett unberührt', () => {
    const roh = '```bash\nls -la /tmp/x --flag\n---\n✅ 🎯\n```';
    expect(f(roh)).toBe(roh);
  });

  it('meldet einen offenen Code-Block als Zustand', () => {
    expect(filtereAbschnitt('```python\nx = 1').imCode).toBe(true);
  });

  it('filtert im offenen Code-Block nicht weiter', () => {
    expect(f('y — 2\n```', true)).toBe('y — 2\n```');
  });
});

describe('M10 Stil-Filter: offene letzte Zeile', () => {
  it('bricht eine noch offene Zeile nicht um', () => {
    expect(f('Eins ist da. Zwei ist da. Drei ist da. Vier ist', false, true)).toBe(
      'Eins ist da. Zwei ist da. Drei ist da. Vier ist'
    );
  });

  it('nimmt der offenen Zeile trotzdem den Strich', () => {
    expect(f('Text — mit Strich', false, true)).toBe('Text, mit Strich');
  });
});

describe('M10 Stil-Filter: Idempotenz und Unversehrtes', () => {
  it('ändert beim zweiten Lauf nichts mehr', () => {
    const roh = 'Eins ist da. Zwei ist da. Drei ist da. Vier, fünf ist da.\n---\n✅ a 🎯 b';
    const einmal = f(roh);
    expect(f(einmal)).toBe(einmal);
  });

  it('lässt einen Pfad in Inline-Code unangetastet', () => {
    expect(f('Siehe `.claude/scripts/x-y.py` dort.')).toBe('Siehe `.claude/scripts/x-y.py` dort.');
  });

  it('lässt Zahlen, Befehle und Fehlermeldungen unverändert', () => {
    const roh = 'Exit 2 bei `python3 a.py --pruefen`, 0 Fehler.';
    expect(f(roh)).toBe(roh);
  });
});

describe('M10 Stil-Filter: Renderer-Einhängepunkt', () => {
  it('liefert dieselbe Ausgabe wie der Abschnitts-Filter', () => {
    const roh = 'Der Deploy lief — 10–15 Minuten.\n---\n✅ a 🎯 b';
    expect(applyStilFilter(roh)).toBe(f(roh));
  });

  it('reicht leeren Text unverändert durch', () => {
    expect(applyStilFilter('')).toBe('');
  });

  it('sitzt im MessageRenderer vor normalizeLatexMathDelimiters und hängt an der Option', () => {
    const quelle = readFileSync(
      resolve(__dirname, '../../../src/features/chat/rendering/MessageRenderer.ts'),
      'utf8'
    );
    expect(quelle).toContain(
      'const styledMarkdown = options?.stilFilter ? applyStilFilter(markdown) : markdown;'
    );
    expect(quelle).toContain('normalizeLatexMathDelimiters(styledMarkdown)');
  });

  it('filtert im Live-Pfad des StreamControllers, nicht im Thinking-Pfad', () => {
    const quelle = readFileSync(
      resolve(__dirname, '../../../src/features/chat/controllers/StreamController.ts'),
      'utf8'
    );
    // Genau zwei Aufrufstellen schalten den Filter ein: finalizeCurrentTextBlock
    // und renderPendingText. Beide rendern Assistenten-Antworttext.
    expect(quelle.match(/stilFilter: true/g) ?? []).toHaveLength(2);
    // Die Thinking-Aufrufe bleiben ohne Option.
    expect(quelle).toContain('await renderer.renderContent(thinkingState.contentEl, thinkingState.content);');
  });

  it('lässt Thinking-, Plan- und Nutzer-Pfade ohne Option', () => {
    const dateien = [
      'src/features/chat/rendering/ThinkingBlockRenderer.ts',
      'src/features/chat/rendering/InlineExitPlanMode.ts',
      'src/features/chat/controllers/InputController.ts',
    ];
    for (const datei of dateien) {
      const quelle = readFileSync(resolve(__dirname, '../../../', datei), 'utf8');
      expect(quelle).not.toContain('stilFilter');
    }
  });
});

describe('M10 Stil-Filter: nur Assistenten-Antworttext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('filtert nur mit gesetzter Option, sonst geht der Rohtext an den Markdown-Renderer', async () => {
    const renderer = createRenderer();

    await renderer.renderContent(createMockEl() as never, MIT_STRICH);
    expect(zuletztGerendert()).toBe(MIT_STRICH);

    await renderer.renderContent(createMockEl() as never, MIT_STRICH, { stilFilter: true });
    expect(zuletztGerendert()).toBe(OHNE_STRICH);
  });

  it('lässt eine Nutzer-Nachricht mit Geviertstrich unverändert', () => {
    const renderer = createRenderer();
    renderer.renderStoredMessage(nachrichtMitText('user', MIT_STRICH));
    expect(zuletztGerendert()).toBe(MIT_STRICH);
  });

  it('filtert den Antworttext des Assistenten', () => {
    const renderer = createRenderer();
    renderer.renderStoredMessage(nachrichtMitText('assistant', MIT_STRICH));
    expect(zuletztGerendert()).toBe(OHNE_STRICH);
  });

  it('lässt einen Thinking-Block unverändert', async () => {
    const renderer = createRenderer();
    const gedanke = 'Ich prüfe erst — dann entscheide ich.';
    // So ruft ThinkingBlockRenderer: ohne Optionen, also ohne Filter.
    await renderer.renderContent(createMockEl() as never, gedanke);
    expect(zuletztGerendert()).toBe(gedanke);
  });

  it('lässt eine Tool-Ausgabe mit Dateiinhalt unverändert', async () => {
    const renderer = createRenderer();
    const dateiinhalt = 'Zeile 1 — mit Strich\n---\nZeile 3 ✅ 🎯';
    await renderer.renderContent(createMockEl() as never, dateiinhalt);
    expect(zuletztGerendert()).toBe(dateiinhalt);
  });
});

describe('M10 Stil-Filter: Kopier-Knopf stimmt mit der Anzeige überein', () => {
  const originalNavigator = globalThis.navigator;

  beforeEach(() => {
    // Der Knopf setzt einen 1,5-Sekunden-Timer für die Rückmeldung, der sonst
    // nach dem Lauf offen bleibt.
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
  });

  function klickeKopieren(markdown: string, stilFilter?: boolean): jest.Mock {
    const renderer = createRenderer();
    const textEl = createMockEl();
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText } },
      writable: true,
      configurable: true,
    });
    if (stilFilter === undefined) {
      renderer.addTextCopyButton(textEl as never, markdown);
    } else {
      renderer.addTextCopyButton(textEl as never, markdown, stilFilter);
    }
    const copyBtn = (textEl as never as { children: Array<{ _eventListeners: Map<string, Array<(e: unknown) => unknown>> }> }).children[0];
    const handler = copyBtn._eventListeners.get('click')![0];
    void handler({ stopPropagation: jest.fn() });
    return writeText;
  }

  it('kopiert den gefilterten Text, weil der Knopf nur an Assistentenblöcken hängt', async () => {
    const writeText = klickeKopieren(MIT_STRICH);
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(OHNE_STRICH);
    expect(writeText).toHaveBeenCalledWith(applyStilFilter(MIT_STRICH));
  });

  it('kopiert das Original, wenn der Block ungefiltert angezeigt wurde', async () => {
    const writeText = klickeKopieren(MIT_STRICH, false);
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(MIT_STRICH);
  });
});
