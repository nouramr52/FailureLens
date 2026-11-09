"""
FailureLens Knowledge Engine - Codebase File Detector
Discovers source files across languages while filtering build/cache artifacts.
"""
import os
from pathlib import Path
from typing import Dict, List, Set

CODE_EXTENSIONS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".java", ".go", ".rs", ".cpp", ".c", ".h", ".cs", ".rb", ".php"
}

DOC_EXTENSIONS = {
    ".md", ".rst", ".txt", ".json", ".yaml", ".yml", ".toml", ".html"
}

IGNORE_DIRS = {
    ".git", "node_modules", "out", "dist", "__pycache__", ".vscode",
    ".failurelens", "graphify-out", "build", ".venv", "venv", "env",
    "target", ".idea", ".next", ".nuxt", "coverage", ".pytest_cache",
    "core", "engine"
}

def detect_files(root_dir: Path) -> Dict[str, List[str]]:
    """
    Scans root_dir and returns categorized file paths relativized to root_dir.
    """
    root = root_dir.resolve()
    code_files: List[str] = []
    doc_files: List[str] = []

    for dirpath, dirnames, filenames in os.walk(root):
        # Prune ignored directories in-place
        dirnames[:] = [d for d in dirnames if d not in IGNORE_DIRS and not d.startswith(".")]

        rel_dir = os.path.relpath(dirpath, root)
        if any(part in IGNORE_DIRS for part in Path(rel_dir).parts):
            continue

        for fname in filenames:
            ext = os.path.splitext(fname)[1].lower()
            rel_file_path = os.path.relpath(os.path.join(dirpath, fname), root).replace("\\", "/")
            
            if ext in CODE_EXTENSIONS:
                code_files.append(rel_file_path)
            elif ext in DOC_EXTENSIONS:
                doc_files.append(rel_file_path)

    return {
        "code": sorted(code_files),
        "docs": sorted(doc_files),
        "total_files": len(code_files) + len(doc_files)
    }

if __name__ == "__main__":
    import sys
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".")
    res = detect_files(target)
    print(f"Detected {len(res['code'])} code files and {len(res['docs'])} doc files.")
