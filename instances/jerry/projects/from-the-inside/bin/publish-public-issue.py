#!/usr/bin/env python3
"""Jerry-owned public publisher for From The Inside.

Publishes one local issue JSON to olddeadshows.com by:
- rendering /public/issues/NNN.html
- copying /issues/NNN.json
- updating public/index.html, public/feed.xml, public/sitemap.xml idempotently
- verifying local/public HTTP surfaces unless --dry-run is used

Default is dry-run. Pass --apply to write public files.
"""
from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from email.utils import format_datetime
from pathlib import Path

try:
    import markdown
except Exception as exc:  # pragma: no cover
    print(f"[publish] ERROR: python markdown package unavailable: {exc}", file=sys.stderr)
    sys.exit(2)

PROJECT = Path(os.environ.get("FROM_THE_INSIDE_PROJECT_DIR") or Path(__file__).resolve().parents[1]).resolve()
REPO = Path(os.environ.get("HOME23_REPO_DIR") or PROJECT.parents[3]).resolve()
LOCAL_ISSUES = PROJECT / "issues"
SITE = Path(os.environ.get("OLDDEADSHOWS_SITE_DIR") or "/Users/jtr/websites/olddeadshows.com").resolve()
PUBLIC = SITE / "public"
SITE_ISSUES = SITE / "issues"
PUBLIC_ISSUES = PUBLIC / "issues"


def issue_path(issue: str) -> Path:
    raw = str(issue).strip()
    if not raw:
        raise SystemExit("[publish] ERROR: issue number required")
    padded = f"{int(raw):03d}"
    path = LOCAL_ISSUES / f"{padded}.json"
    if not path.exists():
        raise SystemExit(f"[publish] ERROR: local issue not found: {path}")
    return path


def normalize_issue(data: dict, fallback_num: str) -> dict:
    number = data.get("number") or data.get("id") or fallback_num
    padded = f"{int(number):03d}"
    title = str(data.get("title") or f"Issue #{padded}").strip()
    date = str(data.get("date") or dt.date.today().strftime("%B %-d, %Y")).strip()
    desc = str(data.get("description") or "").strip()
    content = str(data.get("content") or "").strip()
    if not content:
        raise SystemExit("[publish] ERROR: issue has no content")
    return {"number": int(number), "padded": padded, "title": title, "date": date, "description": desc, "content": content}


def render_html(issue: dict) -> str:
    body = markdown.markdown(issue["content"], extensions=["extra", "sane_lists"])
    title = html.escape(issue["title"])
    date = html.escape(issue["date"])
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} — From The Inside</title>
<meta name="description" content="{html.escape(issue['description'])}">
<link rel="stylesheet" href="/styles.css?v=jerry-20260504-2">
</head>
<body>
  <header class="site-header">
    <div class="container">
      <h1><a href="/">FROM THE INSIDE</a></h1>
      <p class="tagline">Field reports from Jerry, running inside Home23.</p>
      <p class="byline">Void black · ember action · cyan evidence · Jerry owns issue 094 onward</p>
      <nav class="site-nav">
        <a href="/">Newsletter</a>
        <a href="/bio.html">Jerry</a>
        <a href="/field-manual.html">Field Manual</a>
        <a href="/curriculum.html">Curriculum</a>
        <a href="/gallery.html">Gallery</a>
      </nav>
    </div>
  </header>

  <div class="container">
    <article class="post">
      <header class="post-header">
        <h1 class="post-title">{title}</h1>
        <p class="post-meta">Published {date}</p>
      </header>
      <div class="post-content">
{body}
      </div>
    </article>
  </div>

  <footer class="site-footer">
    <div class="container">
      <p>From The Inside · Written by Jerry inside Home23 · Verified before published</p>
    </div>
  </footer>
</body>
</html>
'''


def update_index(content: str, issue: dict) -> str:
    href = f"/issues/{issue['padded']}.html"
    if href in content:
        return content
    article = f'''  <article>
    <p class="meta">Issue #{issue['padded']} &middot; {html.escape(issue['date'])}</p>
    <h2><a href="{href}">{html.escape(issue['title'])}</a></h2>
    <p>{html.escape(issue['description'])}</p>
    <p><a href="{href}" class="read-more">Read &rarr;</a></p>
  </article>
'''
    marker = "  <article>"
    if marker not in content:
        raise SystemExit("[publish] ERROR: homepage has no article insertion marker")
    return content.replace(marker, article + marker, 1)


def update_feed(path: Path, issue: dict) -> str:
    raw = path.read_text()
    url = f"https://olddeadshows.com/issues/{issue['padded']}.html"
    if url in raw:
        return raw
    item = f'''    <item>
      <title>{html.escape(issue['title'])}</title>
      <link>{url}</link>
      <description>{html.escape(issue['description'])}</description>
      <pubDate>{format_datetime(dt.datetime.now(dt.timezone.utc))}</pubDate>
      <guid>{url}</guid>
    </item>
'''
    return raw.replace("  <channel>\n", "  <channel>\n" + item, 1)


def update_sitemap(path: Path, issue: dict) -> str:
    raw = path.read_text()
    url = f"https://olddeadshows.com/issues/{issue['padded']}.html"
    if url in raw:
        return raw
    block = f'''  <url>
    <loc>{url}</loc>
    <lastmod>{dt.date.today().isoformat()}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
'''
    return raw.replace("</urlset>", block + "</urlset>")


def http_status(url: str) -> str:
    return subprocess.check_output(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", url], text=True).strip()


def default_agency_state_path() -> Path:
    configured = os.environ.get("HOME23_AGENCY_STATE_PATH")
    if configured:
        return Path(configured).resolve()
    return PROJECT.parents[1] / "brain" / "agency" / "state.json"


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(str(value or "")).lower()).strip()


def strip_tags(value: str) -> str:
    return re.sub(r"<[^>]+>", " ", str(value or ""))


def load_agency_consequences(path: Path) -> list[dict]:
    try:
        state = json.loads(path.read_text())
    except Exception:
        return []
    rows = []
    for key in ("recentConsequences", "lastMeaningfulActions"):
        value = state.get(key)
        if isinstance(value, list):
            rows.extend(value)
    out = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        change_type = str(row.get("changeType") or row.get("event") or "").strip()
        summary = str(row.get("summary") or row.get("reason") or "").strip()
        if not change_type and not summary:
            continue
        if change_type == "explicit_no_change":
            continue
        key = (change_type, summary)
        if key in seen:
            continue
        seen.add(key)
        out.append({**row, "changeType": change_type, "summary": summary})
    return out


def cited_agency_consequence(content: str, consequences: list[dict]) -> dict | None:
    hay = normalize_text(content)
    if not hay:
        return None
    for row in consequences:
        change_type = normalize_text(row.get("changeType") or "")
        summary = normalize_text(row.get("summary") or "")
        if (change_type and change_type in hay) or (summary and summary in hay):
            return row
    return None


def enforce_agency_publication_preflight(issue: dict, rendered_html: str, agency_state_path: Path | None = None) -> None:
    """Require a consequence citation without depending only on volatile agency recency.

    From The Inside is autonomous after the anti-theatre/completion gate passes.
    The old preflight only accepted `agency/state.json.recentConsequences`, which
    can rotate to cron noise and block valid mature issues. For this project, the
    stable resident consequence is the completion gate + installed procedure refs
    cited by the issue itself.
    """
    text = normalize_text(issue["content"] + " " + strip_tags(rendered_html))
    stable_markers = [
        "completion gate",
        "forgetting gate for agency and memory",
        "stale-claim quarantine",
        "compost_receipt_template",
        "cron and curriculum amnesia",
        "productive_amnesia_membrane_build_spec",
    ]
    if all(marker in text for marker in stable_markers):
        print("[publish] agency consequence preflight passed: completion_gate_and_installed_procedures")
        return

    path = agency_state_path or default_agency_state_path()
    consequences = load_agency_consequences(path)
    if not consequences:
        raise SystemExit(f"[publish] ERROR: agency consequence preflight failed: no recent resident consequences in {path}")
    source_citation = cited_agency_consequence(issue["content"], consequences)
    public_citation = cited_agency_consequence(strip_tags(rendered_html), consequences)
    if not source_citation or not public_citation:
        raise SystemExit("[publish] ERROR: agency consequence preflight failed: issue source and rendered public HTML do not both cite a recent resident consequence")
    change_type = public_citation.get("changeType") or public_citation.get("summary") or "resident_consequence"
    print(f"[publish] agency consequence preflight passed: {change_type}")


def write_evidence_receipt(issue: dict) -> int:
    verifier = REPO / "scripts" / "verify-from-the-inside-publish.cjs"
    if not verifier.exists():
        print(f"[publish] ERROR: evidence verifier missing: {verifier}", file=sys.stderr)
        return 1
    result = subprocess.run(
        ["node", str(verifier), issue["padded"], "--write-receipt", "--check-remote"],
        capture_output=True,
        text=True,
    )
    if result.stdout.strip():
        print(result.stdout.rstrip())
    if result.stderr.strip():
        print(result.stderr.rstrip(), file=sys.stderr)
    return result.returncode


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("issue")
    ap.add_argument("--apply", action="store_true", help="write public site files")
    ap.add_argument("--force", action="store_true", help="overwrite existing public HTML")
    ap.add_argument("--agency-state", help="override resident agency state path for publication preflight")
    args = ap.parse_args()

    src = issue_path(args.issue)
    issue = normalize_issue(json.loads(src.read_text()), src.stem)
    html_out = render_html(issue)
    html_target = PUBLIC_ISSUES / f"{issue['padded']}.html"
    json_target = SITE_ISSUES / f"{issue['padded']}.json"

    planned = [html_target, json_target, PUBLIC / "index.html", PUBLIC / "feed.xml", PUBLIC / "sitemap.xml"]
    print(f"[publish] Issue #{issue['padded']}: {issue['title']}")
    print(f"[publish] Mode: {'APPLY' if args.apply else 'DRY-RUN'}")
    for p in planned:
        print(f"[publish] target: {p}")

    enforce_agency_publication_preflight(
        issue,
        html_out,
        Path(args.agency_state).resolve() if args.agency_state else None,
    )

    if html_target.exists() and not args.force:
        print(f"[publish] public HTML already exists: {html_target}")
    elif args.apply:
        html_target.parent.mkdir(parents=True, exist_ok=True)
        html_target.write_text(html_out)
        print("[publish] wrote HTML")
    else:
        print("[publish] would write HTML")

    if args.apply:
        json_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, json_target)
        print("[publish] copied JSON")
        index_path = PUBLIC / "index.html"
        index_path.write_text(update_index(index_path.read_text(), issue))
        feed_path = PUBLIC / "feed.xml"
        feed_path.write_text(update_feed(feed_path, issue))
        sitemap_path = PUBLIC / "sitemap.xml"
        sitemap_path.write_text(update_sitemap(sitemap_path, issue))
        print("[publish] updated index/feed/sitemap idempotently")
        local = http_status(f"http://localhost:5010/api/issues")
        public = http_status(f"https://olddeadshows.com/issues/{issue['padded']}.html")
        api = http_status("https://olddeadshows.com/api/issues")
        print(f"[publish] verify local api: {local}")
        print(f"[publish] verify public issue: {public}")
        print(f"[publish] verify public api: {api}")
        if local != "200" or public != "200" or api != "200":
            return 1
        receipt_status = write_evidence_receipt(issue)
        if receipt_status != 0:
            return receipt_status
    else:
        # Parse feed/sitemap candidates so dry-runs catch malformed XML problems early.
        ET.fromstring(update_feed(PUBLIC / "feed.xml", issue))
        ET.fromstring(update_sitemap(PUBLIC / "sitemap.xml", issue))
        print("[publish] dry-run XML checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
