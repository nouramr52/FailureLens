"""
FailureLens Knowledge Engine - Architectural Risk & Hypothesis Generator
Analyzes graph topology to identify true Critical Nodes (architectural bottlenecks)
and synthesizes testable failure hypotheses and preventive test recommendations.
"""
from typing import Dict, List, Any, Set
import networkx as nx
from pathlib import Path

# File or label patterns that are usually passive types or pure definitions (not runtime bottlenecks)
PASSIVE_NODE_PATTERNS = {"types/", "interface", "dto", "model", "schema", "constants"}

def identify_critical_nodes(G: nx.DiGraph, top_n: int = 8) -> List[Dict[str, Any]]:
    """
    Identifies Critical Architectural Nodes with disproportionately high fan-in (dependents)
    while filtering out passive type/interface definitions.
    """
    scores = []
    for node_id, data in G.nodes(data=True):
        src_file = data.get("source_file", "").lower()
        label = data.get("label", "").lower()

        # Skip passive type files unless they are active components
        if any(pat in src_file for pat in PASSIVE_NODE_PATTERNS) and not data.get("_callable", False):
            continue

        deg = G.degree(node_id)
        in_deg = G.in_degree(node_id) if hasattr(G, "in_degree") else deg
        out_deg = G.out_degree(node_id) if hasattr(G, "out_degree") else 0

        # Prioritize nodes that have high fan-in (many things depend on them)
        if in_deg >= 2 or deg >= 4:
            svc_name = data.get("service_name") or data.get("community_name") or "Core Service"
            scores.append({
                "nodeId": node_id,
                "label": data.get("label", node_id),
                "filePath": data.get("source_file", ""),
                "degree": deg,
                "inDegree": in_deg,
                "outDegree": out_deg,
                "community": svc_name
            })

    # Sort primarily by inDegree (fan-in), secondarily by overall degree
    scores.sort(key=lambda x: (x["inDegree"], x["degree"]), reverse=True)
    return scores[:top_n]

def generate_hypotheses_from_graph(
    G: nx.DiGraph,
    affected_components: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """
    Synthesizes Model A failure hypotheses based on graph relationships
    between modified components and their dependent callers.
    """
    hypotheses: List[Dict[str, Any]] = []
    seen_titles: Set[str] = set()

    modified_items = [c for c in affected_components if c.get("isModified") and c.get("filePath")]
    dependent_items = [c for c in affected_components if not c.get("isModified") and c.get("filePath")]

    h_idx = 1
    for mod in modified_items:
        node_id = mod["nodeId"]
        file_path = mod["filePath"]
        label = mod["label"]
        coupling = mod.get("couplingScore", 50)
        svc = mod.get("serviceName", "Core Service")

        # Find direct callers of this modified node
        callers = [
            d for d in dependent_items
            if d.get("viaRelation") in ("calls", "inherits", "extends") and d.get("depth") == 1
        ]

        # 1. Resource Contention & Saturation Hypothesis
        is_resource_hub = (
            "pool" in file_path.lower()
            or "db" in file_path.lower()
            or "lock" in label.lower()
            or "queue" in file_path.lower()
            or "cache" in file_path.lower()
            or coupling > 70
        )
        if is_resource_hub:
            title = f"Resource Saturation & Lock Contention in {Path(file_path).name}"
            if title not in seen_titles:
                seen_titles.add(title)
                caller_names = ", ".join([c["label"] for c in callers[:2]]) or "concurrent service consumers"
                hypotheses.append({
                    "id": f"h{h_idx}",
                    "title": title,
                    "failureCategory": "RESOURCE_CONTENTION",
                    "description": (
                        f"Modifications in {label} ({file_path}) impact high-coupling dependent callers ({caller_names}). "
                        f"Under high concurrent traffic, lock acquisition latency or pool resource exhaustion may exceed SLA limits."
                    ),
                    "status": "UNTESTED",
                    "impact": "HIGH",
                    "affectedComponent": file_path,
                    "serviceName": svc,
                    "dockerTestCommand": f"docker run --rm failurelens-val test_{Path(file_path).stem}_concurrency"
                })
                h_idx += 1

        # 2. Cascading Contract Regression in Direct Callers
        if callers:
            top_caller = callers[0]
            if top_caller["filePath"]:
                caller_svc = top_caller.get("serviceName", svc)
                title = f"Contract & Interface Drift in {top_caller['label']}"
                if title not in seen_titles:
                    seen_titles.add(title)
                    hypotheses.append({
                        "id": f"h{h_idx}",
                        "title": title,
                        "failureCategory": "CONTRACT_DRIFT",
                        "description": (
                            f"Changes in {file_path}:{mod['line']} ({label}) are directly invoked by "
                            f"{top_caller['filePath']}:{top_caller['line']} ({top_caller['label']}) via {top_caller['viaRelation']}. "
                            f"Signature mismatch, return type drift, or unhandled exceptions may trigger runtime 500 errors."
                        ),
                        "status": "UNTESTED",
                        "impact": "HIGH" if caller_svc != svc else "MEDIUM",
                        "affectedComponent": top_caller["filePath"],
                        "serviceName": caller_svc,
                        "dockerTestCommand": f"docker run --rm failurelens-val test_{Path(top_caller['filePath']).stem}_contract"
                    })
                    h_idx += 1

        # 3. Cascading Timeout across Cross-Service Boundaries
        cross_service_callers = [
            d for d in dependent_items
            if d.get("serviceName") and d.get("serviceName") != svc and d.get("depth", 0) <= 2
        ]
        if cross_service_callers and len(cross_service_callers) >= 2:
            title = f"Cascading Service Boundary Latency Spike from {Path(file_path).name}"
            if title not in seen_titles:
                seen_titles.add(title)
                first_x_caller = cross_service_callers[0]
                hypotheses.append({
                    "id": f"h{h_idx}",
                    "title": title,
                    "failureCategory": "CASCADING_TIMEOUT",
                    "description": (
                        f"Modifications in {svc} propagate across service boundaries to {first_x_caller['serviceName']} "
                        f"({first_x_caller['label']}). Without circuit breakers, downstream delays may cause thread starvation."
                    ),
                    "status": "UNTESTED",
                    "impact": "HIGH",
                    "affectedComponent": first_x_caller["filePath"],
                    "serviceName": first_x_caller["serviceName"],
                    "dockerTestCommand": f"docker run --rm failurelens-val test_resilience_{Path(file_path).stem}"
                })
                h_idx += 1

    # Fallback hypothesis if none generated
    if not hypotheses:
        hypotheses.append({
            "id": "h1",
            "title": "Behavioral Regression in Dependent Callers",
            "failureCategory": "REGRESSION",
            "description": "Modified components introduce behavioral changes across dependent callers in the blast radius.",
            "status": "UNTESTED",
            "impact": "MEDIUM",
            "affectedComponent": affected_components[0]["filePath"] if affected_components else "src/",
            "serviceName": affected_components[0].get("serviceName", "Core Service") if affected_components else "Core Service",
            "dockerTestCommand": "docker run --rm failurelens-val test_suite"
        })

    return hypotheses[:4]

def find_relevant_tests(G: nx.DiGraph, affected_components: List[Dict[str, Any]]) -> List[str]:
    """
    Finds automated test suites in the repository that test or import affected components.
    """
    tests: List[str] = []
    affected_files = {c["filePath"].replace("\\", "/").lower() for c in affected_components}

    for node_id, data in G.nodes(data=True):
        src_file = data.get("source_file", "").replace("\\", "/").lower()
        if "test" in src_file or "spec" in src_file:
            # Check outgoing dependencies of the test file
            for succ in G.successors(node_id):
                succ_file = G.nodes[succ].get("source_file", "").replace("\\", "/").lower()
                if succ_file in affected_files:
                    test_label = f"{data.get('label', src_file)} in {data.get('source_file')}"
                    if test_label not in tests:
                        tests.append(test_label)

    if not tests:
        tests = [
            "npm test (Automated unit tests)",
            "pytest tests/ (Integration test suite)"
        ]

    return tests[:4]
