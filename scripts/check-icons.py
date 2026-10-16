#!/usr/bin/env python3
"""
Build-time check: verify that every Material Symbols icon used in
index.html and script.js exists in the subsetted icon font.
Fails loudly (exit code 1) if any icon is missing.
"""

import sys
import re
from pathlib import Path
from fontTools.ttLib import TTFont

def extract_used_icons(html_path: Path, js_path: Path) -> set[str]:
    icons = set()

    # 1. Icons in index.html (e.g. <span class="icon">name</span>)
    if html_path.exists():
        html = html_path.read_text(encoding="utf-8")
        matches = re.findall(
            r"<span[^>]*class=[\x27\"][^\x27\"]*\bicon\b[^\x27\"]*[\x27\"][^>]*>([a-z0-9_]+)</span>",
            html,
            re.IGNORECASE
        )
        icons.update(matches)

    # 2. Icons in script.js (TRACK_STATES, dynamic assignments, celebration glyphs)
    if js_path.exists():
        js = js_path.read_text(encoding="utf-8")

        # Object property: icon: 'name'
        icons.update(re.findall(r"\bicon:\s*[\x27\"]([a-z0-9_]+)[\x27\"]", js))

        # textContent assignments targeting icons
        for match in re.findall(r"(?:\.icon|\b(?:themeIcon|pasteIcon|fetchIcon|[a-zA-Z]*icon|[a-zA-Z]*Icon))\b[^=\n]*\.textContent\s*=\s*([^;\n]+)", js):
            for word in re.findall(r"[\x27\"]([a-z0-9_]+)[\x27\"]", match):
                icons.add(word)

        # Arrays of glyphs, e.g. glyphs = ['music_note', 'favorite', ...]
        for match in re.findall(r"\bglyphs\s*=\s*\[([^\]]+)\]", js):
            for word in re.findall(r"[\x27\"]([a-z0-9_]+)[\x27\"]", match):
                icons.add(word)

    # Clean out empty strings or invalid identifiers
    cleaned = {icon.strip() for icon in icons if re.match(r"^[a-z0-9_]+$", icon.strip())}
    return cleaned

def get_font_ligatures(font_path: Path) -> set[str]:
    font = TTFont(font_path)
    ligatures = set()

    if "GSUB" in font and font["GSUB"].table.LookupList:
        for lookup in font["GSUB"].table.LookupList.Lookup:
            if lookup.LookupType in (7, 4):  # Extension or Ligature
                for st in lookup.SubTable:
                    target = st.ExtSubTable if hasattr(st, "ExtSubTable") else st
                    if hasattr(target, "ligatures"):
                        for first_char, lig_list in target.ligatures.items():
                            for lig in lig_list:
                                # Reconstruct the ligature text sequence
                                # In Material Symbols, '_' is named 'underscore'
                                comp_parts = []
                                for c in lig.Component:
                                    if c == "underscore":
                                        comp_parts.append("_")
                                    elif len(c) == 1:
                                        comp_parts.append(c)
                                    else:
                                        comp_parts.append(c)
                                lig_name = first_char + "".join(comp_parts)
                                ligatures.add(lig_name)
                                # Also track lig.LigGlyph
                                ligatures.add(lig.LigGlyph)
    return ligatures

def main():
    root = Path(__file__).resolve().parent.parent
    html_file = root / "public" / "index.html"
    js_file = root / "public" / "script.js"
    font_file = root / "public" / "assets" / "fonts" / "material-symbols-rounded.woff2"

    if not font_file.exists():
        print(f"FATAL: Font file not found at {font_file}", file=sys.stderr)
        sys.exit(1)

    used_icons = extract_used_icons(html_file, js_file)
    print(f"Found {len(used_icons)} unique icons in frontend files: {sorted(used_icons)}")

    font_ligatures = get_font_ligatures(font_file)
    print(f"Font supports {len(font_ligatures)} ligature / glyph identifiers.")

    missing = sorted(used_icons - font_ligatures)
    if missing:
        print("\n" + "=" * 60, file=sys.stderr)
        print("BUILD ERROR: Icons used in code are MISSING from the font subset!", file=sys.stderr)
        print("Missing icons:", file=sys.stderr)
        for m in missing:
            print(f"  - {m}", file=sys.stderr)
        print("\nRun `scripts/subset-icons.py` to regenerate the subset with all required icons.", file=sys.stderr)
        print("=" * 60 + "\n", file=sys.stderr)
        sys.exit(1)

    print("\nSUCCESS: All icons used in index.html and script.js exist in the subset font!")
    sys.exit(0)

if __name__ == "__main__":
    main()
