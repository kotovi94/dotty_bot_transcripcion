#!/usr/bin/env python3
"""Clean and reprocess a transcription session."""

import pathlib
import json
import sys
from datetime import datetime

session_id = "cmsb6og3v0000y4xzq63tn7ja"
recordings_dir = pathlib.Path("data/recordings")
session_dir = recordings_dir / session_id

print(f"Processing session {session_id}")
print(f"Session directory: {session_dir}")
print(f"Directory exists: {session_dir.exists()}")

if not session_dir.exists():
    print("ERROR: Session directory not found")
    sys.exit(1)

# Remove markers
for marker in [".transcription-enqueued", ".transcription-failed", ".transcription-published"]:
    path = session_dir / marker
    if path.exists():
        path.unlink()
        print(f"✓ Removed {marker}")
    else:
        print(f"✗ {marker} not found")

# Create new enqueued marker
enqueued_marker = session_dir / ".transcription-enqueued"
enqueued_marker.write_text(datetime.now().isoformat())
print(f"✓ Created .transcription-enqueued marker")

# Read manifest
manifest_path = session_dir / "manifest.json"
if manifest_path.exists():
    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)
    print(f"\nSession info:")
    print(f"  Campaign: {manifest.get('campaignName')}")
    print(f"  Chunks: {len(manifest.get('chunks', []))}")
    print(f"  Status: {manifest.get('status')}")
else:
    print("ERROR: manifest.json not found")
    sys.exit(1)

print("\nSession ready for reprocessing.")
print("The bot will pick up the session on the next check (~5 seconds).")
