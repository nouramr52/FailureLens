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

from src.engine.detector import detect_files
from src.engine.blast_radius import calculate_blast_radius
from src.engine.analyzer import identify_critical_nodes, generate_hypotheses_from_graph, find_relevant_tests
from src.engine.visualizer import generate_graph_html
from src.engine.adapter import FailureLensGraphAdapter

def cmd_init(workspace_path: Path):
    from src.engine.core.extract import extract
    from src.engine.core.build import build_from_json
    from src.engine.core.cluster import cluster
    from src.engine.core.export import to_json

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

def cmd_affected(workspace_path: Path, files: List[str]):
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

    affected = calculate_blast_radius(G, files)
    hypotheses = generate_hypotheses_from_graph(G, affected)
    tests = find_relevant_tests(G, affected)

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

def main():
    parser = argparse.ArgumentParser(description="FailureLens Knowledge Graph Engine CLI")
    subparsers = parser.add_subparsers(dest="command")

    # init
    p_init = subparsers.add_parser("init")
    p_init.add_argument("workspace", type=str, default=".", nargs="?")

    # affected
    p_affected = subparsers.add_parser("affected")
    p_affected.add_argument("workspace", type=str, default=".", nargs="?")
    p_affected.add_argument("files", nargs="*", default=["src/db/pool.py"])

    # query
    p_query = subparsers.add_parser("query")
    p_query.add_argument("workspace", type=str, default=".", nargs="?")
    p_query.add_argument("query", type=str, default="", nargs="?")

    # subgraph
    p_subgraph = subparsers.add_parser("subgraph")
    p_subgraph.add_argument("workspace", type=str, default=".", nargs="?")
    p_subgraph.add_argument("--nodes", nargs="+", required=True)
    p_subgraph.add_argument("--depth", type=int, default=2)

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    ws = Path(args.workspace)

    if args.command == "init":
        cmd_init(ws)
    elif args.command == "affected":
        cmd_affected(ws, args.files)
    elif args.command == "query":
        cmd_query(ws, args.query)
    elif args.command == "subgraph":
        cmd_subgraph(ws, args.nodes, depth=args.depth)

if __name__ == "__main__":
    main()
