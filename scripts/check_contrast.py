#!/usr/bin/env python3
"""Check docs/site/tokens.css: WCAG AA contrast for every text/background pair in both themes,
and that the three copies of the dark palette (system preference, data-theme, Material slate) and the
two copies of the light palette (bare :root, Material default) are identical.

Stdlib only.
"""

import re
import sys
from pathlib import Path

TOKENS = Path(__file__).resolve().parent.parent / "docs" / "site" / "tokens.css"
HUES = ["k8s", "docker", "tf", "linux", "cicd", "git", "obs", "db", "skills", "mcp"]


def blocks(css: str) -> list[tuple[str, dict[str, str]]]:
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    out = []
    for m in re.finditer(r"([^{}@;]+?)\{([^{}]*)\}", css):
        selector = " ".join(m.group(1).split())
        decls = dict(re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", m.group(2)))
        if decls:
            out.append((selector, {k: v.strip() for k, v in decls.items()}))
    return out


def lum(hex_color: str) -> float:
    h = hex_color.lstrip("#")
    r, g, b = (int(h[i : i + 2], 16) / 255 for i in (0, 2, 4))
    f = lambda c: c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4  # noqa: E731
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)


def ratio(a: str, b: str) -> float:
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def main() -> int:
    found = blocks(TOKENS.read_text(encoding="utf-8"))
    by_sel = {}
    for sel, decls in found:
        by_sel.setdefault(sel, {}).update(decls)

    light_sels = [":root", 'body[data-md-color-scheme="default"]']
    dark_sels = [
        ':root:not([data-theme="light"])',
        ':root[data-theme="dark"], body[data-md-color-scheme="slate"]',
    ]
    errors = []
    for sel in light_sels + dark_sels:
        if sel not in by_sel:
            errors.append(f"missing token block: {sel}")
    if errors:
        print("\n".join(errors))
        return 1

    light, dark = by_sel[":root"], by_sel[dark_sels[1]]
    for name, a, b in (("light", light, by_sel[light_sels[1]]), ("dark", dark, by_sel[dark_sels[0]])):
        for key in sorted(set(a) | set(b)):
            if key in ("--font-display", "--font-body", "--font-mono") or key.startswith(("--space", "--radius")):
                continue
            if a.get(key) != b.get(key) and key != "color-scheme":
                errors.append(f"{name} palette drifted for {key}: {a.get(key)} vs {b.get(key)}")

    for theme, t in (("light", light), ("dark", dark)):
        def check(fg, bg, minimum, what):
            r = ratio(t[fg], t[bg])
            if r < minimum:
                errors.append(f"{theme}: {fg} on {bg} is {r:.2f}:1 (< {minimum}) for {what}")

        for fg in ("--ink", "--muted"):
            for bg in ("--bg", "--surface", "--surface-2"):
                check(fg, bg, 4.5, "body text")
        for fg in ("--accent", "--ok", "--warn", "--bad"):
            for bg in ("--bg", "--surface"):
                check(fg, bg, 4.5, "text")
        check("--accent-ink", "--accent", 4.5, "button text")
        check("--term-ink", "--term-bg", 4.5, "terminal text")
        check("--term-dim", "--term-bg", 4.5, "terminal secondary text")
        for hue in HUES:
            check("--on-hue", f"--h-{hue}", 4.5, "label on a topic mark")
            check(f"--h-{hue}", "--surface", 3.0, "topic mark against the card")

    for e in errors:
        print(e)
    if errors:
        return 1
    print("tokens.css: palettes consistent, all text pairs meet WCAG AA in light and dark")
    return 0


if __name__ == "__main__":
    sys.exit(main())
