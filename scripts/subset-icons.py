#!/usr/bin/env python3
"""
Regenerate subsetted Material Symbols Rounded font for Ripcord.
Usage:
    pipx run --spec "fonttools[brotli,woff]" python scripts/subset-icons.py [path-to-full-material-symbols.woff2]

Icons used across index.html and script.js:
- graphic_eq, dark_mode, light_mode, info, wb_sunny, music_note, link, content_paste,
  arrow_forward, check, arrow_back, download, close, refresh, bolt, search, gavel,
  progress_activity, library_music, schedule, check_circle, error, queue_music, favorite
"""

import sys
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools import subset

ICONS = [
    "graphic_eq",
    "dark_mode",
    "light_mode",
    "info",
    "wb_sunny",
    "music_note",
    "link",
    "content_paste",
    "arrow_forward",
    "check",
    "arrow_back",
    "download",
    "close",
    "refresh",
    "bolt",
    "search",
    "gavel",
    "progress_activity",
    "library_music",
    "schedule",
    "check_circle",
    "error",
    "queue_music",
    "favorite"
]

def subset_icons(src_path: Path, dest_path: Path):
    font = TTFont(src_path)
    icon_set = set(ICONS)

    # Filter GSUB ligature subtables to only our icons to prevent pyftsubset
    # from pulling in all 5000+ ligatures whose letter components exist in the alphabet.
    if "GSUB" in font and font["GSUB"].table.LookupList:
        for lookup in font["GSUB"].table.LookupList.Lookup:
            if lookup.LookupType in (7, 4):  # Extension or Ligature
                for st in lookup.SubTable:
                    target = st.ExtSubTable if hasattr(st, "ExtSubTable") else st
                    if hasattr(target, "ligatures"):
                        new_ligs = {}
                        for first_char, lig_list in target.ligatures.items():
                            filtered = [lig for lig in lig_list if lig.LigGlyph in icon_set]
                            if filtered:
                                new_ligs[first_char] = filtered
                        target.ligatures = new_ligs

    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]
    text_chars = set("".join(ICONS))

    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text="".join(text_chars), glyphs=ICONS)
    subsetter.subset(font)

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    font.save(dest_path)
    print(f"Subsetted font saved to {dest_path} ({dest_path.stat().st_size // 1024} KB)")

if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "public" / "assets" / "fonts" / "material-symbols-rounded.woff2"
    dest = root / "public" / "assets" / "fonts" / "material-symbols-rounded.woff2"
    subset_icons(src, dest)
