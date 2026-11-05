import importlib.util
import os
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCANNER_PATH = ROOT / "instances/jerry/scripts/cards/card-scanner.py"
MARKETPLACES_PATH = ROOT / "instances/jerry/scripts/cards/marketplaces.py"


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


scanner = load_module(SCANNER_PATH, "card_scanner_under_test")
marketplaces = load_module(MARKETPLACES_PATH, "marketplaces_under_test")


class CardScannerFilterTests(unittest.TestCase):
    def test_rejects_read_description_damaged_and_loose_sealed_titles(self):
        listings = [
            {
                "title": "Sword and Shield Evolving Skies Booster Box FACTORY SEALED READ DESCRIPTION",
                "price": 1320.24,
                "url": "",
            },
            {
                "title": "Giratina V Alt Full Art Holo Ultra Rare 186/196 Lost Origin EN DMG",
                "price": 350.0,
                "url": "",
            },
            {
                "title": "Pokemon Evolving Skies LOOSE Factory Sealed 36 packs Booster Box Equivalent",
                "price": 1799.99,
                "url": "",
            },
        ]

        self.assertEqual(scanner.filter_active(listings, "Evolving Skies booster box sealed"), [])

    def test_keeps_valid_sealed_and_graded_listings(self):
        sealed = scanner.filter_active(
            [
                {
                    "title": "Pokemon Sword & Shield Evolving Skies Factory Sealed Booster Box",
                    "price": 1550.0,
                    "url": "https://example.test/sealed",
                }
            ],
            "Evolving Skies booster box sealed",
        )
        graded = scanner.filter_active(
            [
                {
                    "title": "2021 Pokemon SWSH Evolving Skies Glaceon VMAX #209/203 PSA 10 GEM MINT",
                    "price": 300.0,
                    "url": "https://example.test/graded",
                }
            ],
            "Glaceon VMAX 209/203 Evolving Skies PSA 10",
        )

        self.assertEqual(len(sealed), 1)
        self.assertEqual(len(graded), 1)

    def test_gg_collector_number_must_match(self):
        listings = [
            {
                "title": "Pokemon Crown Zenith Arceus VSTAR GG70 PSA 10",
                "price": 160.0,
                "url": "",
            },
            {
                "title": "Pokemon Crown Zenith Mewtwo VSTAR GG44 PSA 10",
                "price": 120.0,
                "url": "",
            },
            {
                "title": "Pokemon Crown Zenith Giratina VSTAR GG69 PSA 10",
                "price": 280.0,
                "url": "",
            },
        ]

        filtered = scanner.filter_active(listings, "Giratina VSTAR GG69 Crown Zenith PSA 10")

        self.assertEqual([item["title"] for item in filtered], ["Pokemon Crown Zenith Giratina VSTAR GG69 PSA 10"])


class ScannerConfigTests(unittest.TestCase):
    def test_default_deal_markets_are_only_ebay(self):
        self.assertEqual(marketplaces.DEFAULT_SCAN_MARKETS, ["ebay"])
        self.assertIn("tcgplayer", marketplaces.EXPERIMENTAL_SCAN_MARKETS)
        self.assertIn("pricecharting", marketplaces.REFERENCE_MARKETS)

    def test_alert_token_fallback_uses_bot_env_token_without_printing_it(self):
        previous = {key: os.environ.get(key) for key in ("CARD_BOT_TOKEN", "TOKEN", "CUSTOM_TOKEN")}
        try:
            os.environ.pop("CARD_BOT_TOKEN", None)
            os.environ["TOKEN"] = "secret-from-bot-env"
            os.environ.pop("CUSTOM_TOKEN", None)

            self.assertEqual(scanner.resolve_alert_token("CARD_BOT_TOKEN"), "secret-from-bot-env")
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def test_pricing_cache_rejects_stale_entries_and_evicts_oldest(self):
        now = time.time()
        cache = {
            "old|0.25|0.135": {"ts_epoch": now - 4000, "market": 10},
            "fresh|0.25|0.135": {"ts_epoch": now - 30, "market": 20},
            "another|0.25|0.135": {"ts_epoch": now - 20, "market": 30},
        }

        self.assertIsNone(scanner.get_cached_pricing(cache, "old", 0.25, 0.135, now=now, ttl_seconds=3600))
        self.assertEqual(scanner.get_cached_pricing(cache, "fresh", 0.25, 0.135, now=now, ttl_seconds=3600)["market"], 20)

        scanner.store_cached_pricing(cache, "new", 0.25, 0.135, {"market": 40}, now=now, max_entries=2)

        self.assertEqual(set(cache), {"another|0.25|0.135", "new|0.25|0.135"})

    def test_watchlist_cli_can_load_smoke_config(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            f.write('{"margin": 0.25, "cards": [{"name": "Smoke Card"}]}')
            path = f.name
        try:
            cfg = scanner.load_watchlist_config(path)
            self.assertEqual(cfg["cards"][0]["name"], "Smoke Card")
        finally:
            os.unlink(path)

    def test_no_alerts_does_not_mark_deals_seen(self):
        seen = {}
        history = []
        result = {
            "card": "Journey Together booster box sealed",
            "ok": True,
            "market": 271,
            "buy_under": 188,
            "confidence": "high",
            "deals": [{
                "title": "Pokemon Journey Together Enhanced Booster Box SEALED NEW [AUCTION]",
                "price": 152.5,
                "est_net_profit": 81.91,
                "est_margin_pct": 53.7,
                "url": "https://example.test",
                "source": "ebay_auction",
            }],
        }

        alerts = scanner.record_result_deals(result, history, seen, no_alerts=True)

        self.assertEqual(len(alerts), 1)
        self.assertEqual(seen, {})
        self.assertEqual(len(history), 1)


if __name__ == "__main__":
    unittest.main()
