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
            kwargs["mlm_client"] = client
            kwargs["mlm_model"] = os.environ.get("MLM_MODEL", "gpt-4o-mini")
        except ImportError:
            pass  # openai package not installed, proceed without vision

    from markitdown import MarkItDown
    md = MarkItDown(**kwargs)
    result = md.convert(filepath)

    if result.text_content:
        print(result.text_content)
    else:
        sys.exit(1)

if __name__ == "__main__":
    main()
