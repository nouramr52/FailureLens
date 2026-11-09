"""
FailureLens Knowledge Graph Adapter
Provides a normalized, strongly-typed integration boundary between Graphify's static
AST graph generation and FailureLens operational & reliability intelligence layers.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Dict, List, Set, Any, Optional, Tuple
import networkx as nx

# Provenance types
PROVENANCE_STATIC_AST = "STATIC_AST"
PROVENANCE_CONFIG_LINK = "CONFIG_LINK"
PROVENANCE_RUNTIME_TRACE = "RUNTIME_TRACE"
PROVENANCE_EXPERIMENT_CONFIRMED = "EXPERIMENT_CONFIRMED"

# Secret patterns to scrub from configuration nodes
SECRET_PATTERN = re.compile(
    r"(password|passwd|secret|token|api_?key|auth|bearer|credentials|private_?key)",
    re.IGNORECASE
)

# Common structural top-level directories to skip when naming features
GENERIC_DIR_NAMES = {"src", "lib", "source", "app", "apps", "packages", "pkg", "internal"}

class FailureLensGraphAdapter:
    """
    Adapter between Graphify and FailureLens.
    Normalizes entities, enforces directed relationships, preserves provenance,
    sanitizes secrets, and resolves high-level service domains.
    """

    def __init__(self, workspace_root: Path | str):
        self.workspace_root = Path(workspace_root).resolve()
        self.out_dir = self.workspace_root / ".failurelens"
        self.graph_json_path = self.out_dir / "graph.json"
        self.graph_html_path = self.out_dir / "graph.html"
        self.report_path = self.out_dir / "KNOWLEDGE_REPORT.md"

    def resolve_service_name(self, file_path: str) -> str:
        """
        Maps a file path to a logical Service / Feature domain.
        Avoids generic directory names like 'src' or 'lib'.
        """
        if not file_path:
            return "Core Domain"

        p = Path(file_path.replace("\\", "/"))
        parts = [part for part in p.parts if part not in (".", "")]

        # Filter out generic top-level directory names
        meaningful_parts = [part for part in parts if part.lower() not in GENERIC_DIR_NAMES]

        if not meaningful_parts:
            return "Core Service"

        # Check for service/package patterns e.g. packages/auth, services/payment
        if len(parts) >= 2 and parts[0].lower() in ("services", "packages", "apps", "components"):
            domain = parts[1]
        elif len(meaningful_parts) >= 2 and meaningful_parts[-1].endswith((".py", ".ts", ".js", ".go", ".java", ".rs")):
            domain = meaningful_parts[-2]
        else:
            domain = meaningful_parts[0]

        # Clean formatting
        clean_name = domain.replace("_", " ").replace("-", " ").capitalize()
        return f"{clean_name} Service"

    def derive_community_labels(self, G: nx.DiGraph, communities: Dict[int, List[str]]) -> Dict[int, str]:
        """
        Derives human-friendly domain labels for Leiden communities.
        Aggregates dominant domain paths within each community.
        """
        labels: Dict[int, str] = {}
        for cid, node_ids in communities.items():
            service_counts: Dict[str, int] = {}
            for nid in node_ids:
                data = G.nodes.get(nid, {})
                sf = data.get("source_file", "")
                if sf:
                    svc = self.resolve_service_name(sf)
                    service_counts[svc] = service_counts.get(svc, 0) + 1

            if service_counts:
                top_svc = sorted(service_counts.items(), key=lambda x: x[1], reverse=True)[0][0]
                labels[cid] = f"Feature: {top_svc.replace(' Service', '')}"
            else:
                labels[cid] = f"Feature Group {cid}"

        return labels

    def sanitize_node_attributes(self, attrs: Dict[str, Any]) -> Dict[str, Any]:
        """
        Redacts sensitive configuration values from node attributes.
        Preserves keys/identifiers while scrubbing plaintext secrets.
        """
        sanitized = dict(attrs)
        label = str(sanitized.get("label", ""))
        source_file = str(sanitized.get("source_file", ""))

        if SECRET_PATTERN.search(label) or SECRET_PATTERN.search(source_file):
            if "value" in sanitized:
                sanitized["value"] = "[REDACTED_SECRET]"
            if "secret" in sanitized:
                sanitized["secret"] = "[REDACTED_SECRET]"

        return sanitized

    def load_digraph(self) -> nx.DiGraph:
        """
        Loads the normalized graph from .failurelens/graph.json strictly as a directed DiGraph.
        """
        if not self.graph_json_path.exists():
            # Fallback to graphify-out/graph.json if present
            alt_path = self.workspace_root / "graphify-out" / "graph.json"
            if alt_path.exists():
                path_to_load = alt_path
            else:
                raise FileNotFoundError(f"Knowledge graph not found at {self.graph_json_path}")
        else:
            path_to_load = self.graph_json_path

        with open(path_to_load, "r", encoding="utf-8") as f:
            data = json.load(f)

        G = nx.DiGraph()

        # Add nodes with normalized metadata
        for node in data.get("nodes", []):
            nid = node["id"]
            node_attrs = self.sanitize_node_attributes(node)
            # Ensure service domain is present
            if "service_name" not in node_attrs:
                sf = node_attrs.get("source_file", "")
                node_attrs["service_name"] = self.resolve_service_name(sf)
            G.add_node(nid, **node_attrs)

        # Add directed edges with explicit provenance
        for link in data.get("links", []):
            src = link["source"]
            tgt = link["target"]
            edge_attrs = dict(link)
            if "provenance" not in edge_attrs:
                edge_attrs["provenance"] = PROVENANCE_STATIC_AST
            G.add_edge(src, tgt, **edge_attrs)

        return G

    def build_qwen_context_subgraph(
        self,
        seed_node_ids: List[str],
        max_depth: int = 2
    ) -> Dict[str, Any]:
        """
        Extracts an evidence subgraph around seed nodes formatted for LLM (Qwen) prompt grounding.
        Returns structured nodes, links, and markdown summary with citations.
        """
        G = self.load_digraph()
        subgraph_nodes: Set[str] = set()

        for seed in seed_node_ids:
            if seed not in G:
                continue
            subgraph_nodes.add(seed)
            # Follow callers (predecessors) and outgoing dependencies (successors) up to depth
            current_layer = {seed}
            for _ in range(max_depth):
                next_layer = set()
                for n in current_layer:
                    next_layer.update(G.predecessors(n))
                    next_layer.update(G.successors(n))
                subgraph_nodes.update(next_layer)
                current_layer = next_layer

        subG = G.subgraph(subgraph_nodes)

        nodes_list = []
        for n, d in subG.nodes(data=True):
            nodes_list.append({
                "id": n,
                "label": d.get("label", n),
                "file": d.get("source_file", ""),
                "location": d.get("source_location", ""),
                "service": d.get("service_name", ""),
                "is_seed": n in seed_node_ids
            })

        edges_list = []
        for u, v, d in subG.edges(data=True):
            edges_list.append({
                "from": u,
                "to": v,
                "relation": d.get("relation", "calls"),
                "provenance": d.get("provenance", PROVENANCE_STATIC_AST)
            })

        # Generate markdown citation text for LLM injection
        md_lines = [
            "### FailureLens Architectural Knowledge Citations",
            f"**Indexed Subgraph Scope**: {len(nodes_list)} nodes, {len(edges_list)} relationships.",
            ""
        ]
        for n in nodes_list:
            prefix = "[MODIFIED SEED]" if n["is_seed"] else "[DEPENDENT]"
            md_lines.append(f"- **{prefix}** `{n['label']}` (`{n['file']}:{n['location']}`) | Service: `{n['service']}`")

        md_lines.append("\n**Observed Structural Dependencies**:")
        for e in edges_list[:12]:
            md_lines.append(f"- `{e['from']}` --[{e['relation']}]--> `{e['to']}` (Provenance: `{e['provenance']}`)")

        return {
            "node_count": len(nodes_list),
            "edge_count": len(edges_list),
            "nodes": nodes_list,
            "edges": edges_list,
            "prompt_markdown": "\n".join(md_lines)
        }
