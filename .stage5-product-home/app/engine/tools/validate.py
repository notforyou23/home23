#!/usr/bin/env python3
"""
Validator v1 - Manifest verification

Purpose:
- Loads manifest.json
- Verifies file integrity (rehash)
- Checks for missing files
- Generates validation report

Usage:
  python3 tools/validate.py [runtime_path]
  
Output:
  runtime/outputs/reports/validation_report.json
  
Exit codes:
  0 - Validation passed
  1 - Missing manifest
  2 - Validation failed
  3 - Exception occurred
"""

import json
import sys
import hashlib
import os
import time
import traceback
from pathlib import Path

def rehash(p: Path) -> str:
    """Recompute SHA-256 of file"""
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def write_json(path: Path, obj):
    """Write JSON atomically"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, sort_keys=True, separators=(",", ":")))
    os.replace(tmp, path)

def main():
    run_root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path("runtime").resolve()
    mpath = run_root / "outputs" / "manifests" / "manifest.json"
    report_path = run_root / "outputs" / "reports" / "validation_report.json"
    
    log = {
        "errors": [],
        "warnings": [],
        "checks": {},
        "status": "fail",
        "timestamp": int(time.time())
    }
    
    try:
        # Check manifest exists
        if not mpath.exists():
            log["errors"].append("missing_manifest")
            write_json(report_path, log)
            print("[Validator] ERROR: Manifest not found", file=sys.stderr)
            return 1
        
        print(f"[Validator] Loading manifest: {mpath}")
        manifest = json.loads(mpath.read_text())
        
        # Validate required fields
        required = ["spec_version", "algorithm", "artifacts", "merkle_root"]
        for field in required:
            if field not in manifest:
                log["errors"].append(f"missing_field:{field}")
        
        # Verify algorithm
        if manifest.get("algorithm") != "sha256":
            log["warnings"].append("unsupported_algorithm")
        
        artifacts = manifest.get("artifacts", [])
        print(f"[Validator] Verifying {len(artifacts)} artifacts")
        
        # Rehash and verify
        mismatches = []
        missing = []
        
        for a in artifacts:
            p = run_root / "outputs" / a["path"]
            
            if not p.exists():
                missing.append({"path": a["path"], "error": "missing_file"})
                continue
            
            h = rehash(p)
            if h != a["sha256"]:
                mismatches.append({
                    "path": a["path"],
                    "error": "hash_mismatch",
                    "expected": a["sha256"][:16] + "...",
                    "actual": h[:16] + "..."
                })
        
        if missing:
            log["errors"].append("missing_files")
            log["checks"]["missing"] = missing
            print(f"[Validator] ERROR: {len(missing)} files missing")
        
        if mismatches:
            log["errors"].append("hash_mismatches")
            log["checks"]["mismatches"] = mismatches
            print(f"[Validator] ERROR: {len(mismatches)} files have wrong hashes")
        
        # Set final status
        log["status"] = "pass" if not log["errors"] else "fail"
        log["artifacts_verified"] = len(artifacts) - len(missing)
        log["artifacts_failed"] = len(missing) + len(mismatches)
        
        write_json(report_path, log)
        
        if log["status"] == "pass":
            print(f"[Validator] ✓ PASSED - {len(artifacts)} artifacts verified")
            return 0
        else:
            print(f"[Validator] ✗ FAILED - {len(log['errors'])} errors")
            return 2
            
    except Exception as e:
        log["errors"].append("exception")
        log["exception"] = {
            "type": type(e).__name__,
            "message": str(e),
            "trace": traceback.format_exc()
        }
        write_json(report_path, log)
        print(f"[Validator] EXCEPTION: {e}", file=sys.stderr)
        return 3

if __name__ == "__main__":
    sys.exit(main())

