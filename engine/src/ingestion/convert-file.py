#!/usr/bin/env python3
"""
Thin wrapper around MarkItDown for document-to-markdown conversion.
Supports optional OpenAI vision for scanned PDFs and image OCR.

Usage: python3 convert-file.py <filepath>
Output: Markdown text to stdout
"""
import sys
import os

def main():
    if len(sys.argv) < 2:
        print("Usage: convert-file.py <filepath>", file=sys.stderr)
        sys.exit(1)

    filepath = sys.argv[1]
    if not os.path.isfile(filepath):
        print(f"File not found: {filepath}", file=sys.stderr)
        sys.exit(1)

    kwargs = {}
    client = None

    # Optional: OpenAI vision client for scanned PDFs and image OCR
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        # Try loading from .env in engine directory
        env_path = os.path.join(os.path.dirname(__file__), '..', '..', '.env')
        if os.path.isfile(env_path):
            for line in open(env_path):
                line = line.strip()
                if line.startswith("OPENAI_API_KEY="):
                    api_key = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break

    if api_key:
        try:
            from openai import OpenAI
            client = OpenAI(api_key=api_key)
            # MarkItDown >=0.1 renamed mlm_* to llm_* — the old names were
            # silently swallowed by **kwargs, so vision OCR never engaged.
            kwargs["llm_client"] = client
            kwargs["llm_model"] = os.environ.get("MLM_MODEL", "gpt-4o-mini")
        except ImportError:
            pass  # openai package not installed, proceed without vision

    from markitdown import MarkItDown
    md = MarkItDown(**kwargs)
    result = md.convert(filepath)

    text = (result.text_content or "").strip()
    if text:
        print(result.text_content)
        return

    # Empty conversion. For a PDF this almost always means a pure scan with
    # no text layer — MarkItDown's LLM hook only OCRs image FILES, never PDF
    # pages — so render the pages and OCR them ourselves.
    if filepath.lower().endswith(".pdf"):
        ocr_text = ocr_scanned_pdf(filepath, client)
        if ocr_text:
            print(ocr_text)
            return

    # Always leave a reason on stderr: the feeder records it in the
    # ingestion manifest, and a silent refusal is undiagnosable later.
    print(f"conversion produced empty text: {os.path.basename(filepath)}", file=sys.stderr)
    sys.exit(1)


OCR_PROMPT = (
    "Transcribe this scanned document page to clean markdown. Preserve the "
    "reading order, headings, lists, and tables. Transcribe exactly what is "
    "on the page; do not summarize and do not add commentary. If the page "
    "is blank, output nothing."
)


def strip_code_fence(text):
    """Vision models habitually wrap transcriptions in a ``` fence; fenced
    markdown defeats semantic chunking (headings inside a code block)."""
    t = text.strip()
    if t.startswith("```"):
        lines = t.split("\n")[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        t = "\n".join(lines).strip()
    return t


def find_pdftoppm():
    import shutil
    found = shutil.which("pdftoppm")
    if found:
        return found
    for candidate in ("/opt/homebrew/bin/pdftoppm", "/usr/local/bin/pdftoppm"):
        if os.path.isfile(candidate):
            return candidate
    return None


def ocr_scanned_pdf(filepath, client):
    """Render a text-layer-less PDF to page images and vision-OCR each page.

    Returns markdown text, or None with the reason on stderr (the feeder
    stores stderr in the manifest entry).
    """
    if client is None:
        print("scanned PDF (no text layer) and no OPENAI_API_KEY — OCR fallback unavailable", file=sys.stderr)
        return None
    pdftoppm = find_pdftoppm()
    if not pdftoppm:
        print("scanned PDF (no text layer) and pdftoppm not installed — OCR fallback unavailable", file=sys.stderr)
        return None

    import base64
    import glob
    import subprocess
    import tempfile

    model = os.environ.get("MLM_MODEL", "gpt-4o-mini")
    max_pages = int(os.environ.get("HOME23_OCR_MAX_PAGES", "20"))
    with tempfile.TemporaryDirectory(prefix="home23-pdf-ocr-") as tmpdir:
        prefix = os.path.join(tmpdir, "page")
        try:
            subprocess.run(
                [pdftoppm, "-png", "-r", "150", "-l", str(max_pages), filepath, prefix],
                check=True, capture_output=True, timeout=120,
            )
        except (subprocess.SubprocessError, OSError) as err:
            print(f"pdftoppm failed: {err}", file=sys.stderr)
            return None
        pages = sorted(glob.glob(f"{prefix}-*.png"))
        if not pages:
            print("pdftoppm produced no page images", file=sys.stderr)
            return None
        chunks = []
        for page_path in pages:
            with open(page_path, "rb") as fh:
                image_b64 = base64.b64encode(fh.read()).decode("ascii")
            response = client.chat.completions.create(
                model=model,
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": OCR_PROMPT},
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_b64}"}},
                    ],
                }],
            )
            page_text = strip_code_fence(response.choices[0].message.content or "")
            if page_text:
                chunks.append(page_text)
        if not chunks:
            print("vision OCR returned no text for any page", file=sys.stderr)
            return None
        return "\n\n".join(chunks)


if __name__ == "__main__":
    main()
