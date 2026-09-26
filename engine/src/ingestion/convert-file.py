#!/usr/bin/env python3
"""
Thin wrapper around MarkItDown for document-to-markdown conversion.

Image files and scanned PDF pages are OCR'd by the engine itself
(engine/src/ingestion/vision-ocr.js) against the provider that owns the
configured vision model. This script used to build an OpenAI client from
OPENAI_API_KEY for any configured model, so a model from another provider
failed on every image.

Usage: python3 convert-file.py <filepath>
Output: Markdown text to stdout
Exit 3: the conversion produced no text (for a PDF: no text layer, so the
engine renders and OCRs its pages).
"""
import sys
import os

EXIT_EMPTY = 3


def main():
    if len(sys.argv) < 2:
        print("Usage: convert-file.py <filepath>", file=sys.stderr)
        sys.exit(1)

    filepath = sys.argv[1]
    if not os.path.isfile(filepath):
        print(f"File not found: {filepath}", file=sys.stderr)
        sys.exit(1)

    kwargs = {}

    # Optional vision client for MarkItDown's own image hooks (pictures inside
    # a PPTX). The engine sets HOME23_VISION_* only when the vision model's
    # provider speaks the OpenAI chat API.
    api_key = os.environ.get("HOME23_VISION_API_KEY")
    model = os.environ.get("HOME23_VISION_MODEL")
    if api_key and model:
        try:
            from openai import OpenAI
            # MarkItDown >=0.1 renamed mlm_* to llm_* — the old names were
            # silently swallowed by **kwargs, so vision never engaged.
            kwargs["llm_client"] = OpenAI(api_key=api_key, base_url=os.environ.get("HOME23_VISION_BASE_URL") or None)
            kwargs["llm_model"] = model
        except ImportError:
            pass  # openai package not installed, proceed without vision

    from markitdown import MarkItDown
    md = MarkItDown(**kwargs)
    result = md.convert(filepath)

    text = (result.text_content or "").strip()
    if text:
        print(result.text_content)
        return

    # Always leave a reason on stderr: the feeder records it in the
    # ingestion manifest, and a silent refusal is undiagnosable later.
    print(f"conversion produced empty text: {os.path.basename(filepath)}", file=sys.stderr)
    sys.exit(EXIT_EMPTY)


if __name__ == "__main__":
    main()
