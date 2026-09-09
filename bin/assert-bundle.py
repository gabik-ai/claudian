#!/usr/bin/env python3
"""Assert that a *shipped, minified* main.js actually carries the mazel patches.

The Jest suite proves the patches against the source. This proves the artifact
on disk is that source and not a stale or upstream build. Everything here is
matched structurally, never on esbuild's mangled identifier names.

Usage:  assert-bundle.py <plugin-dir-or-main.js>
Exit:   0 all good · N number of patches that are missing · 2 bad arguments
"""

from __future__ import annotations

import json
import os
import re
import sys

GREEN, RED, DIM, RESET = "\033[32m", "\033[31m", "\033[2m", "\033[0m"


def fail(name: str, detail: str) -> tuple[str, bool, str]:
    return (name, False, detail)


def ok(name: str, detail: str = "") -> tuple[str, bool, str]:
    return (name, True, detail)


def check_manifest(plugin_dir: str) -> tuple[str, bool, str]:
    path = os.path.join(plugin_dir, "manifest.json")
    if not os.path.isfile(path):
        return fail("fork identity", f"manifest.json fehlt in {plugin_dir}")
    with open(path, encoding="utf8") as fh:
        manifest = json.load(fh)
    if manifest.get("id") != "claudian":
        return fail("fork identity", f'manifest.id ist "{manifest.get("id")}", erwartet "claudian"')
    return ok("fork identity", f'id=claudian version={manifest.get("version")}')


def check_m1(bundle: str) -> tuple[str, bool, str]:
    # private formatTokens(tokens) { if (tokens >= 1_000_000) …
    # esbuild renders 1_000_000 as 1e6 and mangles the parameter name.
    pattern = re.compile(r"formatTokens\((\w+)\)\{if\(\1>=1e6\)")
    if not pattern.search(bundle):
        # esbuild collapses upstream's if/return into a ternary.
        legacy = re.search(r"formatTokens\((\w+)\)\{.{0,80}?\1>=(?:1e3|1000)\b", bundle, re.S)
        detail = "nur die Upstream-k-Variante gefunden" if legacy else "formatTokens gar nicht gefunden"
        return fail("M1 formatTokens 1M", detail)
    return ok("M1 formatTokens 1M", "1e6-Zweig vorhanden")


def check_m2(bundle: str) -> tuple[str, bool, str]:
    # Find the toolbar factory by its return object literal, then compare the
    # construction order of the two selectors. Names are mangled, structure is not.
    for match in re.finditer(r"return\{modelSelector:(\w+),", bundle):
        start = bundle.rfind("function", max(0, match.start() - 2000), match.start())
        if start == -1:
            continue
        head = bundle[start:match.start()]
        literal_end = bundle.find("}", match.start())
        literal = bundle[match.start():literal_end]
        if "mcpServerSelector" not in literal or "externalContextSelector" not in literal:
            continue

        roles = dict(re.findall(r"(\w+):(\w+)", literal))
        mcp_var = roles.get("mcpServerSelector")
        ext_var = roles.get("externalContextSelector")
        if not mcp_var or not ext_var:
            continue

        order = [m.group(1) for m in re.finditer(r"(\w+)=new \w+\(", head)]
        if mcp_var not in order or ext_var not in order:
            return fail("M2 toolbar order", "Konstruktoren im Bundle nicht auffindbar")
        if order.index(mcp_var) >= order.index(ext_var):
            return fail(
                "M2 toolbar order",
                f"external (#{order.index(ext_var)}) wird vor mcp (#{order.index(mcp_var)}) gebaut",
            )
        return ok("M2 toolbar order", f"mcp #{order.index(mcp_var)} vor external #{order.index(ext_var)}")

    return fail("M2 toolbar order", "Toolbar-Factory im Bundle nicht gefunden")


def check_m11(bundle: str) -> tuple[str, bool, str]:
    """M11: die Bash-Zeile liest description, mit Rückfall auf command.

    Zwei Stellen müssen es tun, die sichtbare Zusammenfassung und das ARIA-Label.
    Findet sich nur eine, ist der Patch halb angekommen, und das wäre schlimmer als
    gar nicht, weil Screenreader und Auge dann Verschiedenes melden.
    """
    hits = re.findall(r'\(\w+,"description"\)\.trim\(\)\|\|\w+\(\w+,"command"', bundle)
    if len(hits) < 2:
        upstream_only = re.search(r'case \w+:\{let \w+=\w+\(\w+,"command"\);return \w+\(\w+,60\)', bundle)
        detail = "nur die Upstream-Variante gefunden" if upstream_only else f"{len(hits)} von 2 Stellen"
        return fail("M11 Bash zeigt description", detail)
    return ok("M11 Bash zeigt description", f"{len(hits)} Stellen mit Rückfall auf command")


def check_m5(bundle: str) -> tuple[str, bool, str]:
    deny = re.search(
        r'\{continue:(![01]),hookSpecificOutput:\{hookEventName:"PreToolUse",permissionDecision:"deny"',
        bundle,
    )
    if not deny:
        return fail("M5 deny keeps turn alive", "PreToolUse-Deny-Zweig nicht gefunden")
    # !0 is `true`, !1 is `false` in esbuild output.
    if deny.group(1) != "!0":
        return fail("M5 deny keeps turn alive", "continue:false — Upstream-Verhalten, Patch fehlt")
    return ok("M5 deny keeps turn alive", "continue:true neben permissionDecision:deny")


def check_task_reducer(bundle: str) -> tuple[str, bool, str]:
    # String literals survive minification; the reducer's class and method names
    # do not reliably. So assert on the four tool names plus the one behaviour
    # that is uniquely ours: treating "deleted" as a removal.
    missing = [name for name in ("TaskCreate", "TaskUpdate", "TaskList", "TaskGet")
               if f'"{name}"' not in bundle]
    if missing:
        return fail("task reducer", f"Tool-Namen fehlen im Bundle: {', '.join(missing)}")
    if '"deleted"' not in bundle:
        return fail("task reducer", 'kein "deleted"-Zweig — Tasks würden als erledigt gezählt')
    return ok("task reducer", "alle vier Task-Tools + deleted-Zweig vorhanden")


def check_tab_rename(bundle: str) -> tuple[str, bool, str]:
    # CSS class names are string literals and survive minification intact.
    if '"claudian-tab-badge-renaming"' not in bundle and "'claudian-tab-badge-renaming'" not in bundle:
        return fail("tab rename", "Rename-Zustandsklasse fehlt im Bundle")
    if "plaintext-only" not in bundle:
        return fail("tab rename", "contenteditable-Editor fehlt")
    # The rename gesture is the PLAIN dblclick since 2026-07-27 (Gabriel).
    # Upstream's toggleBadgeTitle was dropped on purpose, so its absence is the
    # expected state — asserting it is still there would now be backwards.
    if "toggleBadgeTitle" in bundle:
        return fail("tab rename", "toggleBadgeTitle wieder im Bundle — der einfache Doppelklick ist wieder belegt")
    # The user-named marker is a persisted object key and survives minification.
    if "userNamedConversationIds" not in bundle:
        return fail("tab rename", "Merker fuer benannte Gespraeche fehlt — Badges zeigen nur Nummern")
    return ok("tab rename", "dblclick-Editor da, Upstream-Toggle entfernt, Merker vorhanden")


def check_tab_drag(bundle: str) -> tuple[str, bool, str]:
    # Upstream has no drag on the badges at all: no `draggable`, no dragstart,
    # no reorder. Everything checked here is ours, so a miss means the feature
    # is simply gone rather than merely renamed.
    for needle, why in (
        ("claudian-tab-badge-dragging", "Drag-Optik fehlt"),
        ("claudian-tab-badge-drag-over", "Ziel-Markierung fehlt"),
        ("dragstart", "Drag-Start-Handler fehlt"),
        ("reorderTabs", "Reorder im TabManager fehlt"),
    ):
        if needle not in bundle:
            return fail("tab drag-reorder", why)
    return ok("tab drag-reorder", "Handler, Reorder und beide Zustandsklassen im Bundle")


def check_attention_trigger(bundle: str) -> tuple[str, bool, str]:
    # Upstream ships the whole apparatus for the finished-answer frame except
    # the moment that raises it. The assignment is what we add, and minifiers
    # keep property names on object members, so it survives the build.
    if "needsAttention=!0" not in bundle and "needsAttention = true" not in bundle:
        return fail("attention trigger", "Ausloeser fehlt — der Rahmen bliebe tot wie upstream")
    if '"claudian-tab-badge-attention"' not in bundle and "'claudian-tab-badge-attention'" not in bundle:
        return fail("attention trigger", "Zustandsklasse fehlt — Rahmen waere unsichtbar")
    return ok("attention trigger", "Ausloeser und Zustandsklasse im Bundle")


def check_permission_chip(bundle: str, plugin_dir: str) -> tuple[str, bool, str]:
    """Der Drei-Zustands-Chip fuer den Berechtigungsmodus (ex ui-fixes.js Fix 2).

    Geprueft wird die Klasse UND der Kreis. Nur die Klasse zu pruefen liesse
    einen Chip durch, der zwar da ist, aber wieder nur zwei Zustaende kennt —
    und genau das ist der Upstream-Zustand, aus dem wir kommen.

    Und geprueft wird die CSS, aus dem gleichen Grund wie beim Send/Stop-Knopf.
    Dieser Check war am 2026-07-28 falsch-gruen: Klasse, Plan-Zustand und
    Attribut standen alle im Bundle, aber keine einzige Regel stylte den Chip.
    Das Aussehen kam bis dahin aus der Laufzeit-Injektion `ui-fixes.js` Fix 2 v5,
    also aus einer Datei, die der Bundle-Check nie gesehen hat. Beim naechsten
    Obsidian-Neustart rendert ein solcher Chip als nackter Text.
    """
    if '"claudian-mode-button"' not in bundle and "'claudian-mode-button'" not in bundle:
        return fail("permission chip", "Chip-Klasse fehlt — Schalter waere weg")
    if "mode-plan" not in bundle:
        return fail("permission chip", "Plan-Zustand fehlt — zurueck beim Zwei-Zustands-Schieber")
    if "data-permission-mode" not in bundle:
        return fail("permission chip", "Modus-Attribut fehlt — Laufzeit-Pruefung koennte nichts lesen")
    # Hier stand die Pruefung "der Schieber darf nicht mehr im Bundle sein".
    # Sie war beim ersten Lauf rot, und zwar zu Recht: `claudian-toggle-switch`
    # gehoert auch dem ModeSelector (Build/Plan), einem voellig anderen
    # Bedienelement, das bleiben soll. Im minifizierten Bundle laesst sich nicht
    # unterscheiden, welche Komponente die Klasse setzt. Die Abwesenheit des
    # Schiebers NEBEN dem Chip prueft deshalb die Laufzeit-Zusicherung
    # "permission chip is native", die im echten DOM nachsehen kann.

    css_path = os.path.join(plugin_dir, "styles.css")
    if not os.path.isfile(css_path):
        return fail("permission chip", "styles.css fehlt — Aussehen nicht pruefbar")
    with open(css_path, encoding="utf8") as fh:
        css = fh.read()

    if "\n.claudian-mode-button {" not in css:
        return fail("permission chip", "Grundregel fehlt in styles.css — Chip waere nackter Text")
    # Je Zustand eine eigene Regel. Ohne sie sehen Safe, YOLO und Plan gleich
    # aus, und die Farbe ist beim Berechtigungsmodus die eigentliche Anzeige.
    for state in ("mode-safe", "mode-yolo", "mode-plan"):
        if f".claudian-mode-button.{state} {{" not in css:
            return fail("permission chip", f"Farbregel fuer {state} fehlt in styles.css")
    return ok("permission chip", "Chip, Plan-Zustand, Modus-Attribut und 3 Farbregeln")


def check_send_stop(bundle: str, plugin_dir: str) -> tuple[str, bool, str]:
    if '"claudian-send-stop-btn"' not in bundle and "'claudian-send-stop-btn'" not in bundle:
        return fail("send/stop button", "Button-Klasse fehlt im Bundle")
    if "Stop generating" not in bundle:
        return fail("send/stop button", "Stop-Zustand fehlt — Button koennte nur senden")
    # Icon-Paar: play/square, nicht arrow-up/square. Der Minifier laesst den
    # ternaeren Ausdruck stehen, deshalb ist das Paar woertlich im Bundle.
    if '"square":"play"' not in bundle and "'square':'play'" not in bundle:
        return fail("send/stop button", "Icon-Paar play/square fehlt — Pfeil-Symbol ist zurueck")

    # Die Farblogik lebt in der CSS, nicht im JS-Bundle. Ohne diesen Teil waere
    # der Check falsch-gruen: die Klasse kann da sein und trotzdem lila leuchten.
    css_path = os.path.join(plugin_dir, "styles.css")
    if not os.path.isfile(css_path):
        return fail("send/stop button", "styles.css fehlt — Farblogik nicht pruefbar")
    with open(css_path, encoding="utf8") as fh:
        css = fh.read()

    def block(marker: str) -> str | None:
        parts = css.split(marker, 1)
        return parts[1].split("}", 1)[0] if len(parts) == 2 else None

    streaming_block = block(".claudian-send-stop-btn--streaming {")
    if streaming_block is None:
        return fail("send/stop button", "Streaming-Regel fehlt in styles.css")
    idle_block = block("\n.claudian-send-stop-btn {")
    if idle_block is None:
        return fail("send/stop button", "Ruhe-Regel fehlt in styles.css")

    if "--interactive-accent" in idle_block:
        return fail("send/stop button", "Ruhezustand wieder auf Accent-Lila — Rueckfall")

    # Die Farblogik ist eine UMKEHRUNG, keine Einzelfarbe: Platte und Symbol
    # tauschen die Rollen. Nur den Hintergrund zu pruefen liesse einen Zustand
    # durch, in dem die Platte kippt und das Symbol stehenbleibt.
    def has(decl_block: str, prop: str, needle: str) -> bool:
        for line in decl_block.splitlines():
            stripped = line.strip()
            if stripped.startswith(prop + ":") and needle in stripped:
                return True
        return False

    if not has(idle_block, "background", "sendstop-dark"):
        return fail("send/stop button", "Ruhe-Platte ist nicht das dunkle Token")
    if not has(idle_block, "color", "--claudian-brand"):
        return fail("send/stop button", "Ruhe-Symbol ist nicht Marken-Orange")
    if not has(streaming_block, "background", "--claudian-brand"):
        return fail("send/stop button", "Streaming-Platte ist nicht Marken-Orange")
    if not has(streaming_block, "color", "sendstop-dark"):
        return fail("send/stop button", "Streaming-Symbol ist nicht das dunkle Token")

    # Position: oben rechts, buendig mit dem YOLO-Chip. `bottom` waere der alte
    # Sitz ueber dem Permission-Toggle.
    if "top:" not in idle_block or "bottom:" in idle_block:
        return fail("send/stop button", "Knopf sitzt nicht oben (top fehlt oder bottom zurueck)")

    # Gefuellte Symbole. Obsidians globales `.svg-icon` setzt fill:none +
    # stroke, also ist das ein Dauer-Override: faellt er weg, werden Dreieck und
    # Quadrat zu Haarlinien-Umrissen und sind bei 15px nicht unterscheidbar.
    glyph_block = block(".claudian-send-stop-btn .svg-icon {")
    if glyph_block is None:
        return fail("send/stop button", "Symbol-Regel fehlt in styles.css")
    if "fill: currentColor" not in glyph_block:
        return fail("send/stop button", "Symbol nicht gefuellt — Obsidians fill:none gewinnt wieder")
    if "stroke: none" not in glyph_block:
        return fail("send/stop button", "stroke nicht geloescht — Umriss sitzt auf der Fuellung")

    return ok("send/stop button", "Zustaende, Icon-Paar, Farb-Umkehrung, Position, Fuellung")


def check_interrupt_source(bundle: str, plugin_dir: str) -> tuple[str, bool, str]:
    """Patch 18: Abbruch mit Quelle, stumme CLI-Diagnose, Hinweis bei leerem Zug.

    Drei Zeichenketten, die nur dieser Patch ins Bundle bringt: die Klasse der
    Quell-Spanne, der Diagnose-Präfix des CLI und der deutsche Hinweistext.
    Dazu die CSS-Regel, damit die Quelle nicht in der Textfarbe untergeht.
    """
    if '"claudian-interrupted-source"' not in bundle and "'claudian-interrupted-source'" not in bundle:
        return fail("interrupt source", "Quell-Spanne fehlt, Abbruch sagt nicht, woher er kam")
    if "[ede_diagnostic]" not in bundle:
        return fail("interrupt source", "Diagnose-Präfix fehlt, rote CLI-Zeile nach Abbruch käme zurück")
    if "(Antwort ohne Text beendet)" not in bundle:
        return fail("interrupt source", "Hinweis für leeren Zug fehlt")
    css_path = os.path.join(plugin_dir, "styles.css")
    if not os.path.isfile(css_path):
        return fail("interrupt source", "styles.css fehlt, Aussehen nicht prüfbar")
    with open(css_path, encoding="utf8") as fh:
        css = fh.read()
    if ".claudian-interrupted-source {" not in css:
        return fail("interrupt source", "CSS-Regel fehlt in styles.css")
    return ok("interrupt source", "Quell-Spanne, Diagnose-Präfix, Hinweistext und CSS-Regel")


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2

    arg = sys.argv[1]
    if os.path.isdir(arg):
        plugin_dir, bundle_path = arg, os.path.join(arg, "main.js")
    else:
        plugin_dir, bundle_path = os.path.dirname(arg) or ".", arg

    if not os.path.isfile(bundle_path):
        print(f"{RED}FEHLER{RESET}: {bundle_path} existiert nicht")
        return 1

    with open(bundle_path, encoding="utf8") as fh:
        bundle = fh.read()

    results = [
        check_manifest(plugin_dir),
        check_m1(bundle),
        check_m2(bundle),
        check_m5(bundle),
        check_m11(bundle),
        check_task_reducer(bundle),
        check_tab_rename(bundle),
        check_tab_drag(bundle),
        check_attention_trigger(bundle),
        check_send_stop(bundle, plugin_dir),
        check_permission_chip(bundle, plugin_dir),
        check_interrupt_source(bundle, plugin_dir),
    ]

    failed = 0
    for name, passed, detail in results:
        mark = f"{GREEN}✓{RESET}" if passed else f"{RED}✗{RESET}"
        print(f"  {mark} {name:<28} {DIM}{detail}{RESET}")
        if not passed:
            failed += 1

    print(f"  {DIM}Bundle: {len(bundle):,} Zeichen, {bundle_path}{RESET}")
    # Exit code carries the number of failed checks so callers can report an
    # honest count instead of "1 block was red".
    return min(failed, 120)


if __name__ == "__main__":
    sys.exit(main())
