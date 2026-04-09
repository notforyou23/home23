#!/usr/bin/env python3
"""
Manifest Builder v1.1 - Deterministic manifest generation

Purpose:
- Scans outputs/ directory
- Generates canonical manifest with file hashes
- Computes Merkle root for integrity
- Deterministic (sorted, normalized)

Usage:
  python3 tools/manifest_builder.py [runtime_path]
  
Output:
  runtime/outputs/manifests/manifest.json
  runtime/outputs/manifests/manifest.merkle
"""

import os
import sys
import json
import hashlib
import time
import stat
import tempfile
from pathlib import Path

SPEC_VERSION = "manifest_canon_v1.1"
ALGORITHM = "sha256"

def file_sha256(p: Path) -> str:
    """Compute SHA-256 hash of file"""
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def safe_write(path: Path, data: bytes):
    """Atomic write with fsync"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        dir=str(path.parent),
        prefix="._tmp.",
        suffix=".json"
    )
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        try:
            if os.path.exists(tmp):
                os.unlink(tmp)
        except:
            pass

def env_created_at():
    """Get canonical timestamp from SOURCE_DATE_EPOCH or current time"""
    sde = os.environ.get("SOURCE_DATE_EPOCH")
    return int(sde) if sde and sde.isdigit() else int(time.time())

def walk_artifacts(root: Path):
    """Walk outputs directory and catalog all files"""
    artifacts = []
    
    for dirpath, dirnames, filenames in os.walk(root):
        # Sort for determinism
        dirnames.sort()
        filenames.sort()
        
        for fn in filenames:
            p = Path(dirpath) / fn
            
            # Skip manifests directory (avoid self-reference)
            rel = p.relative_to(root).as_posix()
            if rel.startswith("manifests/"):
                continue
            
            # Get file stats
            try:
                st = p.stat()
                artifacts.append({
                    "path": rel,
                    "sha256": file_sha256(p),
                    "size": st.st_size,
                    "mode": stat.S_IMODE(st.st_mode),
                    "created_at": env_created_at()
                })
            except Exception as e:
                print(f"Warning: Failed to process {rel}: {e}", file=sys.stderr)
                continue
    
    return artifacts

def merkle_root(artifacts):
    """Compute Merkle root from artifact hashes"""
    if not artifacts:
        return hashlib.sha256(b"").hexdigest()
    
    leafs = [a["sha256"] for a in artifacts]
    buf = ("\n".join(leafs)).encode("utf-8")
    return hashlib.sha256(buf).hexdigest()

def main():
    run_root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path("runtime").resolve()
    outputs = run_root / "outputs"
    
    if not outputs.exists():
        print(f"Error: Outputs directory not found: {outputs}", file=sys.stderr)
        return 1
    
    print(f"[ManifestBuilder] Scanning: {outputs}")
    
    artifacts = walk_artifacts(outputs)
    print(f"[ManifestBuilder] Found {len(artifacts)} files")
    
    mroot = merkle_root(artifacts)
    
    manifest = {
        "spec_version": SPEC_VERSION,
        "algorithm": ALGORITHM,
        "run_root": run_root.as_posix(),
        "created_at": env_created_at(),
        "artifact_count": len(artifacts),
        "artifacts": artifacts,
        "merkle_root": mroot
    }
    
    # Write manifest
    data = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")
    outdir = outputs / "manifests"
    safe_write(outdir / "manifest.json", data)
    safe_write(outdir / "manifest.merkle", (mroot + "\n").encode("utf-8"))
    
    print(f"[ManifestBuilder] Merkle root: {mroot}")
    print(f"[ManifestBuilder] Manifest written to: {outdir / 'manifest.json'}")
    
    return 0

if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"Fatal error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)

