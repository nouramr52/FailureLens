"""
FailureLens Knowledge Engine - Command Line Interface
Unified CLI for repository initialization, blast radius calculation, graph queries,
and Qwen AI context subgraph extraction.
"""
from __future__ import annotations

import sys
import json
import os
import argparse
from pathlib import Path
from typing import Dict, List, Any
import networkx as nx

# Ensure project root is in sys.path
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

try:
    from src.engine.detector import detect_files
    from src.engine.blast_radius import calculate_blast_radius
    from src.engine.analyzer import identify_critical_nodes, generate_hypotheses_from_graph, find_relevant_tests
    from src.engine.visualizer import generate_graph_html, classify_change_impact, inject_change_overlay
    from src.engine.adapter import FailureLensGraphAdapter
except ImportError:
    from detector import detect_files
    from blast_radius import calculate_blast_radius
    from analyzer import identify_critical_nodes, generate_hypotheses_from_graph, find_relevant_tests
    from visualizer import generate_graph_html, classify_change_impact, inject_change_overlay
    from adapter import FailureLensGraphAdapter

def cmd_init(workspace_path: Path):
    try:
        from src.engine.core.extract import extract
        from src.engine.core.build import build_from_json
        from src.engine.core.cluster import cluster
        from src.engine.core.export import to_json
    except ImportError:
        from core.extract import extract
        from core.build import build_from_json
        from core.cluster import cluster
        from core.export import to_json

    root = workspace_path.resolve()
    adapter = FailureLensGraphAdapter(root)
    out_dir = adapter.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    detect_res = detect_files(root)
    code_files = [root / f for f in detect_res["code"]]

    if not code_files:
        print(json.dumps({
            "status": "error",
            "message": f"No supported code files found in {root}"
        }))
        return

    # Extract AST symbols across files
    extraction = extract(code_files, root=root)

    # Build STRICTLY DIRECTED NetworkX DiGraph
    G = build_from_json(extraction, directed=True, root=root)

    if G.number_of_nodes() == 0:
        print(json.dumps({
            "status": "error",
            "message": "AST extraction produced 0 nodes."
        }))
        return

    # Detect Leiden communities
    communities = cluster(G)
    community_labels = adapter.derive_community_labels(G, communities)

    # Attach community and service names to nodes
    for nid in G.nodes():
        cid = G.nodes[nid].get("community")
        if cid is not None and cid in community_labels:
            G.nodes[nid]["community_name"] = community_labels[cid]
        sf = G.nodes[nid].get("source_file", "")
        G.nodes[nid]["service_name"] = adapter.resolve_service_name(sf)

    # Export graph.json (directed=True with commit provenance)
    to_json(G, communities, str(adapter.graph_json_path), community_labels=community_labels, force=True)

    # Export graph.html (Vis.js interactive visualization)
    generate_graph_html(G, communities, adapter.graph_html_path, community_labels=community_labels)

    # Generate Critical Nodes (high fan-in architectural hubs)
    crit_nodes = identify_critical_nodes(G, top_n=6)

    # Output markdown report
    report_lines = [
        f"# FailureLens Knowledge Graph Report",
        f"- **Repository**: `{root.name}`",
        f"- **Components (Nodes)**: {G.number_of_nodes()}",
        f"- **Dependencies (Directed Edges)**: {G.number_of_edges()}",
        f"- **Feature Communities**: {len(communities)}",
        "",
        "## Feature Communities",
    ]
    for cid, label in sorted(community_labels.items()):
        report_lines.append(f"- **{label}**: {len(communities[cid])} components")

    report_lines.append("\n## Critical Nodes (High Fan-In Architectural Bottlenecks)")
    for n in crit_nodes:
        report_lines.append(f"- `{n['label']}` (`{n['filePath']}`) — Fan-in (In-Degree): {n['inDegree']}, Total Degree: {n['degree']}")

    adapter.report_path.write_text("\n".join(report_lines), encoding="utf-8")

    result = {
        "status": "success",
        "nodes": G.number_of_nodes(),
        "edges": G.number_of_edges(),
        "communities": len(communities),
        "criticalNodes": crit_nodes,
        "criticalHubs": crit_nodes,
        "godNodes": crit_nodes,
        "graphJson": str(adapter.graph_json_path),
        "graphHtml": str(adapter.graph_html_path),
        "reportPath": str(adapter.report_path)
    }
    print(json.dumps(result))

def cmd_affected(workspace_path: Path, files: List[str], lines_path: str = ""):
    root = workspace_path.resolve()
    adapter = FailureLensGraphAdapter(root)

    try:
        G = adapter.load_digraph()
    except FileNotFoundError:
        print(json.dumps({
            "status": "error",
            "message": "Knowledge graph not initialized. Run init first."
        }))
        return

    modified_lines = None
    if lines_path:
        try:
            raw = json.loads(Path(lines_path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(json.dumps({
                "status": "error",
                "message": f"Could not read hunk lines: {exc}"
            }))
            return
        if isinstance(raw, dict):
            modified_lines = {
                str(key).replace("\\", "/"): [int(n) for n in value]
                for key, value in raw.items()
                if isinstance(value, list)
            }

    changed = [f for f in files if f]
    affected = calculate_blast_radius(G, changed, modified_lines=modified_lines)
    tests = find_relevant_tests(G, affected, repo_root=root)
    hypotheses = generate_hypotheses_from_graph(G, affected, tests)

    result = {
        "status": "success",
        "affectedComponents": affected,
        "hypotheses": hypotheses,
        "recommendedTests": tests
    }
    print(json.dumps(result))

def cmd_query(workspace_path: Path, query_str: str):
    root = workspace_path.resolve()
    adapter = FailureLensGraphAdapter(root)

    try:
        G = adapter.load_digraph()
    except FileNotFoundError:
        print(json.dumps({"status": "error", "message": "Graph not initialized."}))
        return

    q = query_str.lower()
    matches = []
    for nid, data in G.nodes(data=True):
        lbl = str(data.get("label", "")).lower()
        sf = str(data.get("source_file", "")).lower()
        comm = str(data.get("community_name", "")).lower()
        svc = str(data.get("service_name", "")).lower()
        if q in lbl or q in sf or q in comm or q in svc:
            matches.append({
                "id": nid,
                "label": data.get("label", nid),
                "file": data.get("source_file"),
                "service": data.get("service_name"),
                "community": data.get("community_name")
            })

    print(json.dumps({
        "status": "success",
        "matches": matches[:12]
    }))

def cmd_subgraph(workspace_path: Path, node_ids: List[str], depth: int = 2):
    root = workspace_path.resolve()
    adapter = FailureLensGraphAdapter(root)
    try:
        data = adapter.build_qwen_context_subgraph(node_ids, max_depth=depth)
        print(json.dumps({"status": "success", **data}))
    except Exception as exc:
        print(json.dumps({"status": "error", "message": str(exc)}))

def cmd_update_impact(workspace_path: Path, cleared_path: str = "", failed_path: str = ""):
    root = workspace_path.resolve()
    adapter = FailureLensGraphAdapter(root)

    try:
        G = adapter.load_digraph()
    except FileNotFoundError:
        print(json.dumps({"status": "error", "message": "Knowledge graph not initialized. Run init first."}))
        return

    cleared_nodes = set()
    cleared_files = set()
    if cleared_path and Path(cleared_path).exists():
        try:
            raw = json.loads(Path(cleared_path).read_text(encoding="utf-8"))
            cleared_nodes = set(raw.get("nodes", []))
            cleared_files = set(raw.get("files", []))
        except Exception:
            pass
    elif (adapter.out_dir / "cleared-nodes.json").exists():
        try:
            raw = json.loads((adapter.out_dir / "cleared-nodes.json").read_text(encoding="utf-8"))
            cleared_nodes = set(raw.get("nodes", []))
            cleared_files = set(raw.get("files", []))
        except Exception:
            pass

    failed_nodes = set()
    failed_files = set()
    if failed_path and Path(failed_path).exists():
        try:
            raw = json.loads(Path(failed_path).read_text(encoding="utf-8"))
            failed_nodes = set(raw.get("nodes", []))
            failed_files = set(raw.get("files", []))
        except Exception:
            pass
    elif (adapter.out_dir / "failed-nodes.json").exists():
        try:
            raw = json.loads((adapter.out_dir / "failed-nodes.json").read_text(encoding="utf-8"))
            failed_nodes = set(raw.get("nodes", []))
            failed_files = set(raw.get("files", []))
        except Exception:
            pass

    impact = classify_change_impact(
        G,
        start_dir=root,
        cleared_nodes=cleared_nodes,
        cleared_files=cleared_files,
        failed_nodes=failed_nodes,
        failed_files=failed_files,
    )

    if adapter.graph_html_path.exists():
        inject_change_overlay(adapter.graph_html_path, impact)

    counts = {"edited": 0, "affected": 0, "safe": 0, "failed": 0, "critical": 0}
    for info in impact.get("nodes", {}).values():
        status = str(info.get("status") or "")
        if status in counts:
            counts[status] += 1

    unpushed = sum(1 for info in impact.get("nodes", {}).values() if info.get("edited") == "yes")
    counts["unpushed"] = unpushed

    print(json.dumps({
        "status": "success",
        "counts": counts,
        "nodes": len(impact.get("nodes", {})),
        "graphHtml": str(adapter.graph_html_path),
    }))

def main():
    parser = argparse.ArgumentParser(description="FailureLens Knowledge Graph Engine CLI")
    subparsers = parser.add_subparsers(dest="command")

    # init
    p_init = subparsers.add_parser("init")
    p_init.add_argument("workspace", type=str, default=".", nargs="?")

    # affected
    p_affected = subparsers.add_parser("affected")
    p_affected.add_argument("workspace", type=str, default=".", nargs="?")
    p_affected.add_argument("--lines", dest="lines", default="", help="JSON file mapping repo-relative paths to changed line numbers")
    p_affected.add_argument("files", nargs="*", default=[])

    # query
    p_query = subparsers.add_parser("query")
    p_query.add_argument("workspace", type=str, default=".", nargs="?")
    p_query.add_argument("query", type=str, default="", nargs="?")

    # subgraph
    p_subgraph = subparsers.add_parser("subgraph")
    p_subgraph.add_argument("workspace", type=str, default=".", nargs="?")
    p_subgraph.add_argument("--nodes", nargs="+", required=True)
    p_subgraph.add_argument("--depth", type=int, default=2)

    # update-impact
    p_impact = subparsers.add_parser("update-impact")
    p_impact.add_argument("workspace", type=str, default=".", nargs="?")
    p_impact.add_argument("--cleared", dest="cleared", default="", help="JSON file mapping cleared node IDs and files")
    p_impact.add_argument("--failed", dest="failed", default="", help="JSON file mapping failed node IDs and files")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    ws = Path(args.workspace)

    if args.command == "init":
        cmd_init(ws)
    elif args.command == "affected":
        cmd_affected(ws, args.files, lines_path=args.lines)
    elif args.command == "query":
        cmd_query(ws, args.query)
    elif args.command == "subgraph":
        cmd_subgraph(ws, args.nodes, depth=args.depth)
    elif args.command == "update-impact":
        cmd_update_impact(ws, cleared_path=args.cleared, failed_path=args.failed)

if __name__ == "__main__":
    main()
