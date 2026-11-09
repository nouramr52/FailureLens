"""
FailureLens Knowledge Engine - Architectural Risk & Hypothesis Generator
Analyzes graph topology to identify true Critical Nodes (architectural bottlenecks)
and synthesizes testable failure hypotheses and preventive test recommendations.
"""
import os
from typing import Dict, List, Any, Set, Optional
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

def _edge_relation(G: nx.DiGraph, source: str, target: str) -> str:
    data = G.get_edge_data(source, target)
    if not isinstance(data, dict):
        return ""
    if "relation" in data:
        return str(data.get("relation") or "")
    for payload in data.values():
        if isinstance(payload, dict) and payload.get("relation"):
            return str(payload["relation"])
    return ""


def _node_line(data: Dict[str, Any]) -> int:
    loc = str(data.get("source_location") or "L1")
    if loc.startswith("L"):
        num = loc[1:].split("-")[0].split(":")[0]
        if num.isdigit():
            return int(num)
    return 1


def _labels_by_file(affected_components: List[Dict[str, Any]]) -> Dict[str, Set[str]]:
    labels: Dict[str, Set[str]] = {}
    for comp in affected_components:
        file_path = _norm_path(comp.get("filePath") or "")
        label = comp.get("label")
        if file_path and label:
            labels.setdefault(file_path, set()).add(label)
    return labels


def _same_file(left: str, right: str) -> bool:
    return bool(left) and bool(right) and (
        left == right or left.endswith("/" + right) or right.endswith("/" + left)
    )


def _test_covers(test: Dict[str, str], target: str, labels_by_file: Dict[str, Set[str]]) -> bool:
    """Same join the extension uses when it attaches a test to a hypothesis."""
    reason = test.get("reason") or ""
    file_path = _norm_path(test.get("file") or "")
    if _same_file(file_path, target):
        return True
    base = Path(target).name
    if reason in (f"imports {target}", f"name matches {base}", f"imports {base}"):
        return True
    if reason.startswith("covers ") and reason[len("covers "):] in labels_by_file.get(target, set()):
        return True
    return False


def _tests_for(tests: List[Dict[str, str]], files: List[str], labels_by_file: Dict[str, Set[str]]) -> List[Dict[str, str]]:
    matched: List[Dict[str, str]] = []
    seen: Set[str] = set()
    for test in tests:
        file_path = _norm_path(test.get("file") or "")
        if not file_path or file_path in seen:
            continue
        if any(_test_covers(test, target, labels_by_file) for target in files if target):
            seen.add(file_path)
            matched.append(test)
    return matched


def _direct_callers(G: nx.DiGraph, node_id: str) -> List[Dict[str, Any]]:
    """Production functions that actually call this node. Tests are excluded."""
    callers: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    for pred in G.predecessors(node_id):
        relation = _edge_relation(G, pred, node_id)
        if relation not in ("calls", "inherits", "extends"):
            continue
        pdata = G.nodes[pred]
        src = _norm_path(pdata.get("source_file") or "")
        if not src or _is_test_path(src) or pred in seen:
            continue
        seen.add(pred)
        callers.append({
            "nodeId": pred,
            "label": pdata.get("label", pred),
            "filePath": src,
            "line": _node_line(pdata),
            "serviceName": pdata.get("service_name") or pdata.get("community_name") or "Core Service",
            "viaRelation": relation,
        })
    return callers


def _is_resource(file_path: str, label: str) -> bool:
    path_l = file_path.lower()
    label_l = label.lower()
    return (
        "pool" in path_l
        or "lock" in label_l
        or "queue" in path_l
        or "cache" in path_l
    )


def generate_hypotheses_from_graph(
    G: nx.DiGraph,
    affected_components: List[Dict[str, Any]],
    tests: Optional[List[Dict[str, str]]] = None,
) -> List[Dict[str, Any]]:
    """
    Synthesizes failure hypotheses from real call edges of each modified symbol.

    A caller is used only when the graph has a calls/inherits/extends edge from
    that caller to that symbol. Tests are attached from the changed file and the
    caller file, and hypotheses that have a test are kept ahead of ones that do not.
    """
    recommended = tests or []
    labels_by_file = _labels_by_file(affected_components)
    candidates: List[Dict[str, Any]] = []
    seen_titles: Set[str] = set()

    modified_items = [
        c for c in affected_components
        if c.get("isModified") and c.get("nodeId") and c.get("filePath") and not _is_test_path(c.get("filePath") or "")
    ]
    edited_tests: List[str] = []
    for comp in affected_components:
        file_path = comp.get("filePath") or ""
        if comp.get("isModified") and _is_test_path(file_path) and file_path not in edited_tests:
            edited_tests.append(file_path)

    def add(hypothesis: Dict[str, Any]) -> None:
        title = hypothesis["title"]
        if title in seen_titles:
            return
        files = [hypothesis.get("affectedComponent") or "", hypothesis.get("changedComponent") or ""]
        matched = _tests_for(recommended, files, labels_by_file)
        hypothesis["testScripts"] = matched
        hypothesis["_testCount"] = len(matched)
        seen_titles.add(title)
        candidates.append(hypothesis)

    for mod in modified_items:
        node_id = mod["nodeId"]
        if node_id not in G:
            continue
        file_path = _norm_path(mod["filePath"])
        label = mod.get("label") or node_id
        svc = mod.get("serviceName") or "Core Service"
        callers = _direct_callers(G, node_id)
        if not callers:
            continue

        def caller_tests(caller: Dict[str, Any]) -> int:
            return len(_tests_for(recommended, [caller["filePath"], file_path], labels_by_file))

        callers.sort(key=caller_tests, reverse=True)
        top_caller = callers[0]
        caller_svc = top_caller.get("serviceName") or svc

        add({
            "title": f"Contract & Interface Drift in {top_caller['label']}",
            "failureCategory": "CONTRACT_DRIFT",
            "description": (
                f"Changes in {file_path}:{mod.get('line', 1)} ({label}) are directly invoked by "
                f"{top_caller['filePath']}:{top_caller['line']} ({top_caller['label']}) via {top_caller['viaRelation']}. "
                f"Signature mismatch, return type drift, or unhandled exceptions may trigger runtime 500 errors."
            ),
            "status": "UNTESTED",
            "impact": "HIGH" if caller_svc != svc else "MEDIUM",
            "affectedComponent": top_caller["filePath"],
            "changedComponent": file_path,
            "serviceName": caller_svc,
            "dockerTestCommand": f"docker run --rm failurelens-val test_{Path(top_caller['filePath']).stem}_contract",
            "_rank": 3,
            "_label": label,
        })

        if _is_resource(file_path, label):
            caller_names = ", ".join(c["label"] for c in callers[:2])
            add({
                "title": f"Resource Saturation & Lock Contention in {Path(file_path).name}",
                "failureCategory": "RESOURCE_CONTENTION",
                "description": (
                    f"Modifications in {label} ({file_path}) impact callers ({caller_names}). "
                    f"Under high concurrent traffic, lock acquisition latency or pool resource exhaustion may exceed SLA limits."
                ),
                "status": "UNTESTED",
                "impact": "HIGH",
                "affectedComponent": file_path,
                "changedComponent": file_path,
                "serviceName": svc,
                "dockerTestCommand": f"docker run --rm failurelens-val test_{Path(file_path).stem}_concurrency",
                "_rank": 2,
                "_label": label,
            })

        cross_service = [c for c in callers if c.get("serviceName") and c["serviceName"] != svc]
        if len(cross_service) >= 2:
            first = cross_service[0]
            add({
                "title": f"Cascading Service Boundary Latency Spike from {Path(file_path).name}",
                "failureCategory": "CASCADING_TIMEOUT",
                "description": (
                    f"Modifications in {label} ({svc}) are called across service boundaries by {first['serviceName']} "
                    f"({first['label']}). Without circuit breakers, downstream delays may cause thread starvation."
                ),
                "status": "UNTESTED",
                "impact": "HIGH",
                "affectedComponent": first["filePath"],
                "changedComponent": file_path,
                "serviceName": first["serviceName"],
                "dockerTestCommand": f"docker run --rm failurelens-val test_resilience_{Path(file_path).stem}",
                "_rank": 2,
                "_label": label,
            })

    # A recommended test that no caller-hypothesis covers still needs a card,
    # pointed at the changed symbol that test actually exercises.
    for test in recommended:
        reason = test.get("reason") or ""
        covered_label = reason[len("covers "):] if reason.startswith("covers ") else ""
        imported = reason[len("imports "):] if reason.startswith("imports ") else ""
        matches = []
        for mod in modified_items:
            file_path = _norm_path(mod.get("filePath") or "")
            label = mod.get("label") or ""
            if covered_label and label != covered_label:
                continue
            if imported and not (_same_file(file_path, imported) or Path(file_path).name == imported):
                continue
            if not covered_label and not imported:
                continue
            matches.append(mod)
        if not matches:
            continue
        if any(
            _test_covers(test, candidate_file, labels_by_file)
            for hypothesis in candidates
            for candidate_file in (hypothesis.get("affectedComponent"), hypothesis.get("changedComponent"))
            if candidate_file
        ):
            continue
        matches.sort(key=lambda item: (
            (item.get("label") or "") == Path(item.get("filePath") or "").name
            or str(item.get("label") or "").endswith("/" + Path(item.get("filePath") or "").name),
            not str(item.get("label") or "").endswith("()"),
        ))
        mod = matches[0]
        file_path = _norm_path(mod.get("filePath") or "")
        label = mod.get("label") or file_path
        add({
            "title": f"Behavioral regression in {label}",
            "failureCategory": "REGRESSION",
            "description": (
                f"Changes in {file_path}:{mod.get('line', 1)} ({label}) are covered by {test.get('file')}. "
                f"Run that test before deploy."
            ),
            "status": "UNTESTED",
            "impact": "MEDIUM",
            "affectedComponent": file_path,
            "changedComponent": file_path,
            "serviceName": mod.get("serviceName") or "Core Service",
            "dockerTestCommand": test.get("file") or "pytest",
            "_rank": 1,
            "_label": label,
        })

    # One card per changed file: keep the version a test can run, then the more specific caller.
    best_by_file: Dict[str, Dict[str, Any]] = {}
    for hypothesis in candidates:
        key = hypothesis.get("changedComponent") or hypothesis.get("affectedComponent") or hypothesis["title"]
        current = best_by_file.get(key)
        score = (hypothesis["_testCount"], hypothesis["_rank"])
        if current is None or score > (current["_testCount"], current["_rank"]):
            best_by_file[key] = hypothesis

    # Prefer a card that brings a test no earlier card already runs.
    pool = list(best_by_file.values())
    ranked: List[Dict[str, Any]] = []
    seen_tests: Set[str] = set()
    while pool and len(ranked) < 4:
        def score(item: Dict[str, Any]) -> tuple:
            names = {_norm_path(test.get("file") or "") for test in item["testScripts"]}
            novel = len(names - seen_tests)
            changed = _norm_path(item.get("changedComponent") or "")
            changed_labels = labels_by_file.get(changed, set())
            precise = sum(
                1 for test in item["testScripts"]
                if (test.get("reason") or "").startswith("covers ")
                and (test.get("reason") or "")[len("covers "):] in changed_labels
            )
            return (novel, precise, item["_rank"], item["_testCount"])

        pool.sort(key=score, reverse=True)
        if score(pool[0])[0] == 0:
            break
        pick = pool.pop(0)
        ranked.append(pick)
        seen_tests.update(_norm_path(test.get("file") or "") for test in pick["testScripts"])

    hypotheses = []
    for index, hypothesis in enumerate(ranked, start=1):
        hypothesis["id"] = f"h{index}"
        hypothesis.pop("_testCount", None)
        hypothesis.pop("_rank", None)
        hypothesis.pop("_label", None)
        hypotheses.append(hypothesis)

    # A changed test script is run itself. It is not covered by another test.
    if not hypotheses and edited_tests and not modified_items:
        hypotheses.append({
            "id": "h1",
            "title": "Run the edited test",
            "failureCategory": "REGRESSION",
            "description": (
                f"{edited_tests[0]} changed. Run that test file. "
                "A test script is the check, so nothing else is selected to test it."
            ),
            "status": "UNTESTED",
            "impact": "MEDIUM",
            "affectedComponent": edited_tests[0],
            "serviceName": "Tests",
            "dockerTestCommand": f"pytest {edited_tests[0]}"
        })

    # Fallback hypothesis if none generated
    if not hypotheses and modified_items:
        hypotheses.append({
            "id": "h1",
            "title": "Behavioral Regression in Dependent Callers",
            "failureCategory": "REGRESSION",
            "description": "Modified components introduce behavioral changes across dependent callers in the blast radius.",
            "status": "UNTESTED",
            "impact": "MEDIUM",
            "affectedComponent": modified_items[0]["filePath"],
            "serviceName": modified_items[0].get("serviceName", "Core Service"),
            "dockerTestCommand": "pytest"
        })

    return hypotheses[:4]

_SKIP_WALK_DIRS = {
    ".git", "node_modules", "out", "dist", "__pycache__", ".vscode",
    ".failurelens", "graphify-out", "build", ".venv", "venv", "env",
    "target", ".idea", ".next", ".nuxt", "coverage", ".pytest_cache",
}

def _norm_path(path: str) -> str:
    return (path or "").replace("\\", "/").lstrip("./")

def _is_test_path(path: str) -> bool:
    name = Path(path).name.lower()
    norm = _norm_path(path).lower()
    if name.startswith("test_") and name.endswith(".py"):
        return True
    if name.endswith("_test.py"):
        return True
    for suffix in (".test.ts", ".test.tsx", ".test.js", ".test.jsx", ".spec.ts", ".spec.tsx", ".spec.js", ".spec.jsx"):
        if name.endswith(suffix):
            return True
    return any(part in ("test", "tests", "__tests__") for part in norm.split("/"))

def _runner_for(path: str) -> str:
    return "pytest" if path.lower().endswith(".py") else "npm"

def _candidate_names(stem: str) -> Set[str]:
    return {
        f"test_{stem}.py",
        f"{stem}_test.py",
        f"{stem}.test.ts",
        f"{stem}.test.tsx",
        f"{stem}.test.js",
        f"{stem}.test.jsx",
        f"{stem}.spec.ts",
        f"{stem}.spec.tsx",
        f"{stem}.spec.js",
        f"{stem}.spec.jsx",
    }

def find_relevant_tests(
    G: nx.DiGraph,
    affected_components: List[Dict[str, Any]],
    repo_root: Optional[Path] = None,
) -> List[Dict[str, str]]:
    """
    Returns test files that relate to edited production nodes, or to the callers
    those edits could affect. Tests live in a test directory or anywhere else
    the graph links them to those nodes.

    An edited test script is not a node that needs its own covering test.
    The edited file is run directly.
    """
    results: List[Dict[str, str]] = []
    seen: Set[str] = set()

    def add(path: str, reason: str) -> None:
        if len(results) >= 8:
            return
        norm = _norm_path(path)
        if not norm or norm in seen or not _is_test_path(norm):
            return
        seen.add(norm)
        results.append({
            "file": norm,
            "reason": reason,
            "runner": _runner_for(norm),
        })

    modified_files: List[str] = []
    edited_test_files: List[str] = []
    cover_ids: Set[str] = set()
    cover_files: Set[str] = set()
    for comp in affected_components:
        file_path = _norm_path(comp.get("filePath") or "")
        if not file_path:
            continue
        if _is_test_path(file_path):
            if comp.get("isModified"):
                edited_test_files.append(file_path)
            continue
        if comp.get("isModified") or comp.get("depth") == 1:
            node_id = comp.get("nodeId")
            if node_id:
                cover_ids.add(node_id)
            cover_files.add(file_path)
            if comp.get("isModified"):
                modified_files.append(file_path)

    for node_id, data in G.nodes(data=True):
        src = _norm_path(data.get("source_file") or "")
        if not _is_test_path(src):
            continue
        for succ in G.successors(node_id):
            if succ in cover_ids:
                label = G.nodes[succ].get("label", succ)
                add(src, f"covers {label}")
                break
            succ_file = _norm_path(G.nodes[succ].get("source_file") or "")
            if succ_file and succ_file in cover_files and succ_file != src:
                add(src, f"imports {succ_file}")
                break

    names_needed: Dict[str, str] = {}
    for file_path in modified_files:
        if _is_test_path(file_path):
            continue
        stem = Path(file_path).stem
        for name in _candidate_names(stem):
            names_needed.setdefault(name, file_path)

    candidates: Set[str] = set()
    for _, data in G.nodes(data=True):
        src = _norm_path(data.get("source_file") or "")
        if src:
            candidates.add(src)

    if repo_root is not None and names_needed:
        root = repo_root.resolve()
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in _SKIP_WALK_DIRS and not d.startswith(".")]
            rel_dir = os.path.relpath(dirpath, root).replace("\\", "/")
            if rel_dir.startswith("extension/out") or rel_dir.startswith("graphify-out"):
                dirnames.clear()
                continue
            for filename in filenames:
                if filename not in names_needed:
                    continue
                full = os.path.join(dirpath, filename)
                candidates.add(os.path.relpath(full, root).replace("\\", "/"))

    for src in sorted(candidates):
        name = Path(src).name
        if name in names_needed:
            add(src, f"name matches {Path(names_needed[name]).name}")

    for test_file in edited_test_files:
        add(test_file, "edited test; run this file")

    return results[:8]
