/**
 * Mazel-Patch: der Drei-Zustands-Chip fuer den Berechtigungsmodus.
 *
 * Was upstream fehlt
 * ------------------
 * Upstream 2.0.41 rendert einen Schieber mit genau zwei erreichbaren
 * Zustaenden, Safe und YOLO. PLAN hat dort eine Beschriftung, aber keine Geste:
 * der Modus wird sichtbar, sobald das SDK oder Shift+Tab ihn setzt, und ist mit
 * der Maus nicht auswaehlbar. Beide erreichbaren Zustaende gelten ausserdem fuer
 * den PROVIDER, also fuer alle Tabs gleichzeitig.
 *
 * Woher der Patch kommt
 * ---------------------
 * Aus der Laufzeit-Injektion `projects/claudian/ui-fixes.js` Fix 2 v5 im Vault
 * (1.3.72-Zeit). Die hing an einem MutationObserver, der bei jeder DOM-Aenderung
 * das ganze Skript neu ausfuehrte und `.claudian-permission-toggle` von aussen
 * neu aufbaute — ein Wettlauf mit der Komponente, der die Huelle gehoert, und
 * fuer Build und Testlauf voellig unsichtbar. Mit dieser Portierung kann die
 * Injektion geloescht werden; das ist die Bedingung der Definition of Done im
 * SPEC, die das Loeschen von `ui-fixes.js` verlangt.
 *
 * Warum die reinen Funktionen einzeln geprueft werden
 * ---------------------------------------------------
 * `nextPermissionMode` und `availablePermissionModes` sind der ganze Verstand
 * des Chips. Ueber die Klasse geprueft braeuchte jeder Fall ein DOM-Doppel; als
 * Funktionen sind die Randfaelle in je zwei Zeilen abgedeckt, und genau die
 * Randfaelle waren in der Injektion nicht behandelt.
 */
import {
  autoApprovesEveryTool,
  availablePermissionModes,
  nextPermissionMode,
  permissionModeStateClass,
} from '@/features/chat/ui/PermissionModeButton';

import { readUpstreamFile } from './upstreamRef';

const CLAUDE_TOGGLE = {
  inactiveValue: 'normal',
  inactiveLabel: 'Safe',
  activeValue: 'yolo',
  activeLabel: 'YOLO',
  planValue: 'plan',
  planLabel: 'PLAN',
};

describe('mazel: the cycle runs Safe -> YOLO -> Plan -> Safe', () => {
  const modes = availablePermissionModes(CLAUDE_TOGGLE, true);

  it('offers all three modes when the provider can enter plan', () => {
    expect(modes).toEqual(['normal', 'yolo', 'plan']);
  });

  it('steps forward and wraps around', () => {
    expect(nextPermissionMode('normal', modes)).toBe('yolo');
    expect(nextPermissionMode('yolo', modes)).toBe('plan');
    expect(nextPermissionMode('plan', modes)).toBe('normal');
  });

  it('three clicks land back where they started', () => {
    // Umkehrbarkeit, wie beim Umsortieren der Tabs: ein Kreis, der irgendwo
    // einen Halt verschluckt, kommt hier nicht heraus, wo er hineinging.
    let mode = 'normal';
    for (let i = 0; i < 3; i++) mode = nextPermissionMode(mode, modes);
    expect(mode).toBe('normal');
  });

  it('drops plan when the provider cannot enter it', () => {
    // Codex, OpenCode und Pi bilden die Modi auf eigene Sandbox-Begriffe ab.
    // Plan anzubieten, wo der Provider ihn nicht kennt, schriebe einen Wert,
    // den niemand angefordert hat.
    expect(availablePermissionModes(CLAUDE_TOGGLE, false)).toEqual(['normal', 'yolo']);
  });

  it('offers nothing at all when the provider has no toggle', () => {
    expect(availablePermissionModes(null, true)).toEqual([]);
  });

  it('an unknown mode lands on the first entry instead of freezing', () => {
    // Ein Chip, der sich nicht bewegt, weil er sich selbst nicht wiedererkennt,
    // ist von einem kaputten Klick-Handler nicht zu unterscheiden.
    expect(nextPermissionMode('was-auch-immer', modes)).toBe('normal');
  });

  it('an empty mode list leaves the current mode untouched', () => {
    expect(nextPermissionMode('yolo', [])).toBe('yolo');
  });
});

describe('mazel: exactly one mode auto-approves', () => {
  it('yolo does, the other two do not', () => {
    // Diese Entscheidung darf nur an einer Stelle stehen. Der Chip zeigt sie,
    // der Approval-Callback des Tabs handelt danach. Gehen die beiden
    // auseinander, sieht der Nutzer YOLO waehrend ein Dialog auf einen Klick
    // wartet — oder schlimmer, er sieht Safe waehrend Werkzeuge ungefragt laufen.
    expect(autoApprovesEveryTool('yolo')).toBe(true);
    expect(autoApprovesEveryTool('normal')).toBe(false);
    expect(autoApprovesEveryTool('plan')).toBe(false);
  });

  it('an unknown mode never auto-approves', () => {
    // Fail-safe in die sichere Richtung: was wir nicht kennen, fragt nach.
    expect(autoApprovesEveryTool('')).toBe(false);
    expect(autoApprovesEveryTool('yolo-ish')).toBe(false);
  });
});

describe('mazel: the state class follows the mode', () => {
  it('maps each mode to its own class', () => {
    expect(permissionModeStateClass('normal')).toBe('mode-safe');
    expect(permissionModeStateClass('yolo')).toBe('mode-yolo');
    expect(permissionModeStateClass('plan')).toBe('mode-plan');
  });

  it('falls back to safe for anything unknown', () => {
    // Dieselbe Richtung wie oben: im Zweifel sieht es nach Safe aus, nie nach
    // YOLO. Eine Fehlfarbe, die Sorglosigkeit suggeriert, ist die schlimmere.
    expect(permissionModeStateClass('quatsch')).toBe('mode-safe');
  });
});

describe('obsolescence guard: permission mode chip', () => {
  /**
   * Rot heisst hier nicht "kaputt", sondern: "der Boden unter dem Patch hat
   * sich bewegt, lies den Diff neu". Baut upstream den dritten Modus selbst
   * ein, ist unsere Fassung ueberfluessig und gehoert geloescht, nicht
   * weitergeschleppt — sonst haengen zwei Bedienelemente am selben Zustand.
   */
  it('upstream still ships the two-state slider, not a cycling chip', () => {
    const upstream = readUpstreamFile('src/features/chat/ui/InputToolbar.ts');
    if (upstream === null) return;

    // Der Schieber, den wir ersetzen.
    expect(upstream).toContain('claudian-toggle-switch');
    // Und nichts von unserem Ersatz.
    expect(upstream).not.toContain('claudian-mode-button');
    expect(upstream).not.toContain('PermissionModeButton');
  });

  it('upstream still reads the provider-wide mode, not a per-tab one', () => {
    const upstream = readUpstreamFile('src/features/chat/ui/InputToolbar.ts');
    if (upstream === null) return;

    // Genau der Zugriff, der den Schalter global machte. Rot = der Anker ist
    // weg, upstream kennt jetzt vielleicht selbst einen Modus pro Tab.
    expect(upstream).toContain('getSettings().permissionMode');
    // Bewusst mit Wortgrenze statt `toContain('getPermissionMode')`: upstream
    // hat `getPermissionModeToggle`, und das enthaelt unseren Namen als Praefix.
    // Die unscharfe Fassung war beim ersten Lauf rot und haette den Waechter
    // dauerhaft rot gehalten — ein Waechter, der immer schreit, wird abgeschaltet.
    expect(upstream).not.toMatch(/getPermissionMode\b(?!Toggle)/);
  });
});
