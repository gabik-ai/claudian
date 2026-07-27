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
        check_task_reducer(bundle),
        check_tab_rename(bundle),
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
