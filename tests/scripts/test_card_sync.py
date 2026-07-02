import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SYNC_PATH = ROOT / "instances/jerry/scripts/cards/sync-pi-card-state.py"


def load_sync_module():
    spec = importlib.util.spec_from_file_location("card_sync_under_test", SYNC_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CardSyncTests(unittest.TestCase):
    def test_scan_command_uses_runner_with_batch_size(self):
        sync = load_sync_module()

        cmd = sync.build_scan_command("jtr@example.local:/cards", 12)

        self.assertEqual(
            cmd,
            [
                "ssh",
                "jtr@example.local",
                "cd /cards && ./run-scan.sh --batch-size 12",
            ],
        )

    def test_jsonl_validation_rejects_bad_lines(self):
        sync = load_sync_module()
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "events.jsonl"
            p.write_text('{"ok": true}\nnot-json\n')

            with self.assertRaises(ValueError):
                sync.validate_file(p, "jsonl")

    def test_local_copy_validation_is_atomic(self):
        sync = load_sync_module()
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            remote = root / "remote"
            dest = root / "dest"
            remote.mkdir()
            (remote / "scanner-latest.json").write_text(json.dumps({"ts": "new"}))
            (remote / "history.json").write_text(json.dumps([{"card": "A"}]))
            (remote / "events.jsonl").write_text(json.dumps({"ts": "event"}) + "\n")
            (dest / "nested").mkdir(parents=True)
            (dest / "nested" / "scanner-latest.json").write_text(json.dumps({"ts": "old"}))

            copies = [
                ("scanner-latest.json", "nested/scanner-latest.json", "json"),
                ("history.json", "history.json", "json"),
                ("events.jsonl", "events.jsonl", "jsonl"),
            ]

            copied = sync.copy_files("local:" + str(remote), root, copies)

            self.assertEqual(len(copied), 3)
            self.assertEqual(json.loads((dest / "nested" / "scanner-latest.json").read_text())["ts"], "old")
            self.assertEqual(json.loads((root / "nested" / "scanner-latest.json").read_text())["ts"], "new")
            self.assertEqual(json.loads((root / "history.json").read_text())[0]["card"], "A")


if __name__ == "__main__":
    unittest.main()
