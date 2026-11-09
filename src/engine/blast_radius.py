"""
FailureLens Knowledge Engine - Directional Blast Radius & Coupling Analysis
Traverses reverse-dependency chains (incoming caller edges) in the directed knowledge
graph to calculate true change impact, affected components, and coupling scores.
"""
from typing import Dict, List, Set, Any, Optional
import networkx as nx
from pathlib import Path

# Dependency relations that indicate behavioral or contract dependency
DIRECT_FAILURE_RELATIONS = {
    "calls", "inherits", "extends", "implements", "overrides"
}

INDIRECT_FAILURE_RELATIONS = {
    "imports", "imports_from", "references", "requires", "uses", "type_dependency"
}

ALL_FAILURE_RELATIONS = DIRECT_FAILURE_RELATIONS | INDIRECT_FAILURE_RELATIONS

def calculate_blast_radius(
    G: nx.DiGraph,
    modified_files: List[str],
    max_depth: int = 2,
    modified_lines: Optional[Dict[str, List[int]]] = None
) -> List[Dict[str, Any]]:
    """
    Computes affected components and blast radius for a list of modified files/lines.
    Strictly follows reverse dependency edges (incoming edges from callers).
    Returns a list of FailureLens-compatible AffectedComponent dicts.
    """
    normalized_mod_files = {f.replace("\\", "/").lstrip("./") for f in modified_files}
    affected_components: List[Dict[str, Any]] = []
    visited_nodes: Set[str] = set()

    # Ensure G is directed
    if not G.is_directed():
        # Promote to DiGraph
        G = G.to_directed()

    # 1. Identify seed nodes residing in the modified files
    seed_nodes: List[str] = []
    for node_id, data in G.nodes(data=True):
        src_file = data.get("source_file", "").replace("\\", "/").lstrip("./")
        if not src_file:
            continue

        matches_file = (
            src_file in normalized_mod_files
            or any(src_file.endswith(mf) for mf in normalized_mod_files)
        )

        if matches_file:
            loc_str = str(data.get("source_location", "L1"))
            line = int(loc_str.replace("L", "")) if loc_str.startswith("L") and loc_str[1:].isdigit() else 1

            # Check line filter if available
            if modified_lines and src_file in modified_lines:
                lines_for_file = modified_lines[src_file]
                # If specific lines provided and node doesn't match, check proximity
                if lines_for_file and line not in lines_for_file and not any(abs(line - l) <= 20 for l in lines_for_file):
                    continue

            seed_nodes.append(node_id)
            if node_id not in visited_nodes:
                visited_nodes.add(node_id)

                in_deg = G.in_degree(node_id)
                out_deg = G.out_degree(node_id)
                coupling = min(99, max(15, int((in_deg * 15 + out_deg * 8))))
                svc_name = data.get("service_name") or data.get("community_name") or "Core Service"

                affected_components.append({
                    "id": f"comp_{len(affected_components)+1}",
                    "nodeId": node_id,
                    "label": data.get("label", node_id),
                    "filePath": src_file,
                    "line": line,
                    "level": "DIRECT",
                    "isModified": True,
                    "couplingScore": coupling,
                    "serviceName": svc_name,
                    "depth": 0,
                    "viaRelation": "modified"
                })

    # If no specific AST nodes were matched, create file-level entry fallback
    if not seed_nodes and modified_files:
        for mf in normalized_mod_files:
            affected_components.append({
                "id": f"comp_{len(affected_components)+1}",
                "nodeId": mf,
                "label": Path(mf).name,
                "filePath": mf,
                "line": 1,
                "level": "DIRECT",
                "isModified": True,
                "couplingScore": 50,
                "serviceName": Path(mf).parent.name.capitalize() or "Core Service",
                "depth": 0,
                "viaRelation": "modified"
            })

    # 2. Directional Reverse BFS: strictly traverse incoming caller/importer edges (predecessors)
    queue: List[tuple[str, int]] = [(s, 0) for s in seed_nodes]

    while queue:
        current_node, current_depth = queue.pop(0)
        if current_depth >= max_depth:
            continue

        # In DiGraph: predecessor P has edge P -> current_node (P calls/imports current_node)
        predecessors = list(G.predecessors(current_node))

        for pred in predecessors:
            edge_data = G.get_edge_data(pred, current_node, default={})
            relation = edge_data.get("relation", "calls")

            # Strictly skip containment, docstring/rationale, or unrelated edges
            if relation not in ALL_FAILURE_RELATIONS:
                continue

            if pred not in visited_nodes:
                visited_nodes.add(pred)
                p_data = G.nodes.get(pred, {})
                src_file = p_data.get("source_file", "").replace("\\", "/").lstrip("./")

                # Skip external/built-in package nodes with no local file
                if not src_file:
                    continue

                loc_str = str(p_data.get("source_location", "L1"))
                line = int(loc_str.replace("L", "")) if loc_str.startswith("L") and loc_str[1:].isdigit() else 1

                next_depth = current_depth + 1

                # Calculate blast-radius tier
                if next_depth == 1 and relation in DIRECT_FAILURE_RELATIONS:
                    level = "DIRECT"
                elif next_depth == 1:
                    level = "HIGH"
                elif next_depth == 2:
                    level = "MEDIUM"
                else:
                    level = "LOW"

                in_deg = G.in_degree(pred)
                coupling = min(95, max(20, int(in_deg * 12 + (3 - min(3, next_depth)) * 15)))
                svc_name = p_data.get("service_name") or p_data.get("community_name") or "Core Service"

                affected_components.append({
                    "id": f"comp_{len(affected_components)+1}",
                    "nodeId": pred,
                    "label": p_data.get("label", pred),
                    "filePath": src_file,
                    "line": line,
                    "level": level,
                    "isModified": False,
                    "couplingScore": coupling,
                    "serviceName": svc_name,
                    "depth": next_depth,
                    "viaRelation": relation
                })

                queue.append((pred, next_depth))

    return affected_components
