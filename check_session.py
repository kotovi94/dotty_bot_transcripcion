#!/usr/bin/env python3
"""Check session status and exports."""

import pathlib
import json
from datetime import datetime

session_id = "cmsb6og3v0000y4xzq63tn7ja"
session_dir = pathlib.Path("data/recordings") / session_id
exports_dir = pathlib.Path("data/exports") / session_id

print(f"Session: {session_id}\n")

# Check session markers
print("Session markers:")
for marker in [".transcription-enqueued", ".transcription-failed", ".transcription-published"]:
    path = session_dir / marker
    status = "✓" if path.exists() else "✗"
    print(f"  {status} {marker}")

# Check exports
print("\nExports:")
if exports_dir.exists():
    for item in exports_dir.iterdir():
        size_kb = item.stat().st_size / 1024 if item.is_file() else 0
        print(f"  - {item.name} ({size_kb:.1f} KB)" if item.is_file() else f"  - {item.name}/")
    
    # Show bitácora preview
    bitacora_path = exports_dir / "bitacora.md"
    if bitacora_path.exists():
        print("\n=== BITÁCORA PREVIEW ===")
        content = bitacora_path.read_text(encoding="utf-8")
        lines = content.split("\n")
        for line in lines[:50]:
            print(line)
        if len(lines) > 50:
            print(f"\n... ({len(lines) - 50} more lines)")
else:
    print("  Exports directory not found yet")

# Check transcript quality
transcript_path = exports_dir / "transcript.raw.json" if exports_dir.exists() else None
if transcript_path and transcript_path.exists():
    data = json.loads(transcript_path.read_text(encoding="utf-8"))
    print(f"\n=== TRANSCRIPT QUALITY ===")
    print(f"Lines: {len(data.get('lines', []))}")
    print(f"Quality: {data.get('quality', {})}")
    print(f"Discarded segments: {len(data.get('diagnostics', []))}")
