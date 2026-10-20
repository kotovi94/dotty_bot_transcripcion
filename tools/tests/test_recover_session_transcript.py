import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "recover-session-transcript.py"
SPEC = importlib.util.spec_from_file_location("recover_transcript", SCRIPT)
RECOVERY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RECOVERY)


class TranscriptRecoveryTests(unittest.TestCase):
    def test_completed_jobs_publish_without_overwriting_existing_bitacora(self):
        with tempfile.TemporaryDirectory(dir=SCRIPT.parents[1]) as directory:
            root = Path(directory)
            source = root / "recordings" / "session1"
            source.mkdir(parents=True)
            wav = source / "audio" / "voice.wav"
            wav.parent.mkdir()
            wav.write_bytes(b"fixture")
            chunk = {"id": "chunk1", "file": "audio/voice.wav", "speakerUserId": "speaker1",
                     "speakerName": "Voz 1", "startedOffsetMs": 1234}
            manifest = {"sessionId": "session1", "campaignId": "campaign1", "sequenceNumber": 21,
                        "status": "interrupted", "chunks": [chunk]}
            campaign_db = sqlite3.connect(root / "dotty.db")
            campaign_db.execute("CREATE TABLE CampaignMember (campaignId TEXT, discordUserId TEXT, playerName TEXT, characterName TEXT)")
            campaign_db.execute("INSERT INTO CampaignMember VALUES (?,?,?,?)",
                                ("campaign1", "speaker1", "Jugadora", "Personaje"))
            campaign_db.commit()
            campaign_db.close()
            connection = sqlite3.connect(root / "transcriber.db")
            connection.execute("""CREATE TABLE transcription_job (
                id TEXT, audio_path TEXT, speaker_user_id TEXT, start_offset_ms INTEGER,
                language TEXT, initial_prompt TEXT, hotwords TEXT, status TEXT,
                error TEXT, result_json TEXT)""")
            result = {"segments": [{"start_ms": 100, "text": "Texto recuperado.", "status": "transcribed"}]}
            connection.execute("INSERT INTO transcription_job VALUES (?,?,?,?,?,?,?,?,?,?)",
                               ("session1:chunk1", str(wav.resolve()), "speaker1", 1234,
                                "es", "", "", "completed", None, json.dumps(result)))
            connection.commit()
            connection.close()
            output = root / "recovered-audio" / "session1"
            output.mkdir(parents=True)
            state = output / "transcription.status.json"
            self.assertEqual(RECOVERY.collect(root, source, manifest, output, state), (True, 0, True))
            bitacora = root / "exports" / "session1" / "bitacora.md"
            self.assertIn("[00:00:01] **Personaje:** Texto recuperado.", bitacora.read_text(encoding="utf-8"))
            self.assertEqual(bitacora.read_bytes(), (output / "transcripcion.md").read_bytes())
            raw = root / "exports" / "session1" / "transcript.raw.json"
            self.assertEqual(json.loads(raw.read_text(encoding="utf-8"))["lines"][0]["speakerName"], "Personaje")
            self.assertEqual(RECOVERY.collect(root, source, manifest, output, state), (True, 0, True))
            bitacora.write_text("Edición del usuario", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "bitácora diferente"):
                RECOVERY.collect(root, source, manifest, output, state)
            self.assertEqual(bitacora.read_text(encoding="utf-8"), "Edición del usuario")
            bitacora.write_bytes((output / "transcripcion.md").read_bytes())
            raw.write_text("Edición raw del usuario", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "transcripción raw diferente"):
                RECOVERY.collect(root, source, manifest, output, state)
            self.assertEqual(raw.read_text(encoding="utf-8"), "Edición raw del usuario")
            (source / ".transcription-regenerating").write_text("running", encoding="utf-8")
            self.assertEqual(RECOVERY.collect(root, source, manifest, output, state, replace_existing=True), (True, 0, True))
            self.assertEqual(json.loads(raw.read_text(encoding="utf-8"))["lines"][0]["text"], "Texto recuperado.")
            self.assertFalse((source / ".transcription-regenerating").exists())


if __name__ == "__main__":
    unittest.main()
