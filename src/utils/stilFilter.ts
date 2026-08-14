/**
 * Mazel Patch M10: der deterministische Stil-Filter, portiert nach TypeScript.
 *
 * WARUM ES DIESEN FILTER HIER GIBT:
 *   Live läuft derselbe Filter als `MessageDisplay`-Hook der Claude-CLI
 *   (.claude/scripts/stil-filter.py im Vault). Der Hook sieht aber nur den
 *   laufenden Stream. Beim Rendern aus der Historie und beim Kopieren griff er
 *   nicht, also standen angezeigter und kopierter Text auseinander. Diese
 *   Fassung filtert im Renderer und deckt damit Streaming, Historie und
 *   Subagenten in einem Punkt ab.
 *
 * VIER MECHANISCHE REGELN, kein Ermessen:
 *   1. Geviert- und Halbgeviertstrich raus, Zahlenbereiche werden zu "bis"
 *   2. eine Zeile aus drei oder mehr Bindestrichen fällt weg
 *   3. je Zeile bleibt nur das erste Emoji, Tabellenzeilen ausgenommen
 *   4. eine Prosa-Zeile mit mehr als drei Sätzen wird umgebrochen
 *
 * WAS ER NIEMALS ANFASST:
 *   Wörter, Reihenfolge, Inhalt, Zahlen, Pfade, Befehle, Fehlermeldungen,
 *   Code-Blöcke, Inline-Code, Wikilinks, URLs, Tabellenzeilen, Bullets,
 *   Zitatblöcke, Überschriften, reine Fett-Titel und das erste Emoji.
 *
 * IDEMPOTENZ: Ein zweiter Lauf auf gefiltertem Text ändert nichts mehr. Das ist
 *   Pflicht, weil derselbe Text beim erneuten Rendern einer Sitzung noch einmal
 *   durch den Filter läuft.
 *
 * Vorlage: .claude/scripts/stil-filter.py, Regel: .claude/rules/klartext-antworten.md
 */

// Dieselben Muster wie in der Python-Fassung, damit beide Seiten denselben Text meinen.
const INLINE_CODE = /`[^`\n]*`/g;
const WIKILINK = /\[\[[^\]]*\]\]/g;
const URL = /https?:\/\/\S+/g;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}]\u{FE0F}?/gu;
// Satzgrenze: Punkt, Frage- oder Ausrufezeichen, danach Leerraum und ein Satzanfang.
// Der verlangte Grossbuchstabe schützt Tausendertrennung (11.883) und Versionsnummern.
const SATZGRENZE = /(?<=[.!?])\s+(?=[A-ZÄÖÜ„“"`*[])/;
const FETT_TITEL = /^\s*(\*\*|__).+(\*\*|__)\s*:?\s*$/;
const TRENNLINIE = /^\s*-{3,}\s*$/;
const FENCE = /^\s*(```|~~~)/;
const NUMMERIERT = /^\d+[.)]\s/;

const MAX_SAETZE_JE_ABSATZ = 3;

const STRUKTUR_PRAEFIXE = ['|', '-', '*', '+', '>', '#'];

/** Bullet, Tabellenzeile, nummerierte Liste, Callout oder Überschrift. */
function istStrukturzeile(zeile: string): boolean {
  const z = zeile.replace(/^\s+/, '');
  if (!z) return false;
  if (STRUKTUR_PRAEFIXE.some((p) => z.startsWith(p))) {
    return !(z.startsWith('**') || z.startsWith('__'));
  }
  return NUMMERIERT.test(z);
}

/** Bereiche, in denen ein Strich legitim ist und nichts ersetzt werden darf. */
function geschuetzteTeile(zeile: string): Array<[number, number]> {
  const bereiche: Array<[number, number]> = [];
  for (const muster of [INLINE_CODE, WIKILINK, URL]) {
    muster.lastIndex = 0;
    let treffer: RegExpExecArray | null;
    while ((treffer = muster.exec(zeile)) !== null) {
      bereiche.push([treffer.index, treffer.index + treffer[0].length]);
      if (treffer[0].length === 0) muster.lastIndex += 1;
    }
  }
  bereiche.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return bereiche;
}

/** Wendet `funktion` nur auf die ungeschützten Abschnitte einer Zeile an. */
function ausserhalbErsetzen(zeile: string, funktion: (t: string) => string): string {
  const bereiche = geschuetzteTeile(zeile);
  if (bereiche.length === 0) return funktion(zeile);
  const teile: string[] = [];
  let pos = 0;
  for (const [start, ende] of bereiche) {
    if (start < pos) continue; // Überlappung, zum Beispiel eine URL in Backticks
    teile.push(funktion(zeile.slice(pos, start)));
    teile.push(zeile.slice(start, ende));
    pos = ende;
  }
  teile.push(funktion(zeile.slice(pos)));
  return teile.join('');
}

/** Geviert- und Halbgeviertstrich raus. Zahlenbereiche werden zu "bis". */
function stricheErsetzen(text: string): string {
  let neu = text.replace(/(?<=\d)\s*[–—]\s*(?=\d)/g, ' bis ');
  neu = neu.replace(/\s+[–—]\s+/g, ', ');
  // Python `\w` ist unicode-bewusst, JS `\w` wäre nur ASCII: hier explizit nachgebildet.
  neu = neu.replace(/(?<=[\p{L}\p{N}_])[–—](?=[\p{L}\p{N}_])/gu, ', ');
  neu = neu.replace(/^\s*[–—]\s*/, '');
  return neu.split('—').join(',').split('–').join(',');
}

/** Lässt das erste Emoji stehen und entfernt jedes weitere in derselben Zeile. */
function emojisKappen(zeile: string): string {
  EMOJI.lastIndex = 0;
  const treffer = Array.from(zeile.matchAll(EMOJI));
  if (treffer.length < 2) return zeile;
  let ergebnis = zeile;
  for (let i = treffer.length - 1; i >= 1; i--) {
    const m = treffer[i];
    const start = m.index ?? 0;
    ergebnis = ergebnis.slice(0, start) + ergebnis.slice(start + m[0].length);
  }
  ergebnis = ergebnis.replace(/[ \t]{2,}/g, ' ');
  ergebnis = ergebnis.replace(/[ \t]+([,.;:!?])/g, '$1');
  return ergebnis.replace(/\s+$/, '');
}

/** Bricht eine Prosa-Zeile nach jedem dritten Satz um. Kein Wort ändert sich. */
function absatzUmbrechen(zeile: string): string {
  const satzliste = zeile.split(SATZGRENZE).filter((s) => s !== undefined && s.trim() !== '');
  if (satzliste.length <= MAX_SAETZE_JE_ABSATZ) return zeile;
  const bloecke: string[] = [];
  for (let i = 0; i < satzliste.length; i += MAX_SAETZE_JE_ABSATZ) {
    bloecke.push(satzliste.slice(i, i + MAX_SAETZE_JE_ABSATZ).join(' ').trim());
  }
  return bloecke.join('\n\n');
}

export interface StilFilterErgebnis {
  text: string;
  imCode: boolean;
}

/**
 * Filtert einen Textabschnitt und meldet, ob er in einem offenen Code-Block endet.
 *
 * `letzteOffen` sagt, dass die letzte Zeile mitten im Satz endet: dort wird nur
 * zeichenweise gefiltert, nie umgebrochen. Im Renderer liegt immer der ganze
 * Block vor, das Flag bleibt dort auf `false`.
 */
export function filtereAbschnitt(
  text: string,
  imCodeStart = false,
  letzteOffen = false
): StilFilterErgebnis {
  let imCode = imCodeStart;
  const endetMitUmbruch = text.endsWith('\n');
  const zeilen = text.split('\n');
  const ausgabe: string[] = [];

  for (let nr = 0; nr < zeilen.length; nr++) {
    const zeile = zeilen[nr];
    const istLetzte = nr === zeilen.length - 1;
    const offen = istLetzte && letzteOffen && !endetMitUmbruch;

    if (FENCE.test(zeile)) {
      imCode = !imCode;
      ausgabe.push(zeile);
      continue;
    }
    if (imCode) {
      ausgabe.push(zeile);
      continue;
    }

    if (TRENNLINIE.test(zeile)) {
      continue; // verschluckt in Obsidian den Text darunter
    }

    let neu = ausserhalbErsetzen(zeile, stricheErsetzen);

    if (!neu.replace(/^\s+/, '').startsWith('|')) {
      neu = emojisKappen(neu);
    }

    if (!offen && neu.trim() !== '' && !istStrukturzeile(neu) && !FETT_TITEL.test(neu)) {
      neu = absatzUmbrechen(neu);
    }

    ausgabe.push(neu);
  }

  return { text: ausgabe.join('\n'), imCode };
}

/**
 * Der Einhängepunkt für den Renderer: nimmt einen kompletten Text und gibt den
 * gefilterten zurück. Bei jedem Zweifel bleibt das Original stehen, ein Fehler
 * im Filter darf nie eine Nachricht kosten.
 */
export function applyStilFilter(text: string): string {
  if (!text) return text;
  try {
    return filtereAbschnitt(text).text;
  } catch {
    return text;
  }
}
