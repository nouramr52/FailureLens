"""
FailureLens Knowledge Engine - Interactive Visualizer
Generates a standalone, dark-themed interactive Vis.js network graph HTML.
Pending git edits are painted onto that graph: edited symbols, callers that
could break when a critical node or one of its dependencies changes, and the
critical nodes themselves when they are at risk.
"""
from __future__ import annotations

import html as html_lib
import json
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional, Set
import networkx as nx

# Same fan-in cutoff `init` reports, and the same proximity / depth the blast
# radius walk already uses.
CRITICAL_NODE_LIMIT = 6
LINE_PROXIMITY = 20
IMPACT_DEPTH = 2

STATUS_COLORS = {
    "edited": "#f97316",
    "affected": "#eab308",
    "critical": "#ef4444",
    "safe": "#22c55e",
    "failed": "#ef4444",
}

_HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
_SOURCE_LINE_RE = re.compile(r"L(\d+)")


def generate_graph_html(
    G: nx.Graph,
    communities: Dict[int, List[str]],
    output_path: Path,
    community_labels: Optional[Dict[int, str]] = None
) -> bool:
    """
    Renders an interactive D3 / Vis.js network visualization of the repository knowledge graph.
    """
    from src.engine.core.export import to_html

    out_file = str(output_path.resolve())
    output_path.parent.mkdir(parents=True, exist_ok=True)

    success = to_html(
        G=G,
        communities=communities,
        output_path=out_file,
        community_labels=community_labels
    )

    if success and output_path.exists():
        # Inject FailureLens custom header and branding, then the git overlay.
        try:
            content = output_path.read_text(encoding="utf-8")
            if "<title>" in content:
                content = content.replace(
                    "<title>Knowledge Graph</title>",
                    "<title>FailureLens Repository Knowledge Graph</title>"
                )
            output_path.write_text(content, encoding="utf-8")
        except Exception:
            pass

        try:
            impact = classify_change_impact(G, start_dir=output_path.parent)
            inject_change_overlay(output_path, impact)
        except Exception:
            pass

    return success


def _run_git(args: List[str], cwd: Path) -> Optional[subprocess.CompletedProcess]:
    try:
        return subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return None


def _strip_ab_prefix(path: str) -> str:
    raw = path.strip().strip('"').replace("\\", "/")
    if raw.startswith("a/") or raw.startswith("b/"):
        raw = raw[2:]
    while raw.startswith("./"):
        raw = raw[2:]
    return raw


def _b_path_from_diff_git(line: str) -> Optional[str]:
    rest = line[len("diff --git "):].strip()
    if not rest:
        return None
    if rest.startswith('"'):
        parts: List[str] = []
        current: List[str] = []
        in_quotes = False
        escaped = False
        for ch in rest:
            if escaped:
                current.append(ch)
                escaped = False
                continue
            if ch == "\\":
                escaped = True
                continue
            if ch == '"':
                if in_quotes:
                    parts.append("".join(current))
                    current = []
                    in_quotes = False
                else:
                    in_quotes = True
                continue
            if in_quotes:
                current.append(ch)
        if len(parts) >= 2:
            return _strip_ab_prefix(parts[1])
        return None
    marker = " b/"
    idx = rest.rfind(marker)
    if idx == -1:
        return None
    return _strip_ab_prefix(rest[idx + 1:])


def _parse_unified_diff(diff_text: str) -> Dict[str, Optional[Set[int]]]:
    """Map each changed path to the new-file line numbers in its hunks.

    An empty set means the file showed up in the diff without hunk lines
    (binary, or a deletion point we could not place). Callers treat that as
    the whole file.
    """
    changes: Dict[str, Optional[Set[int]]] = {}
    current: Optional[str] = None

    for line in diff_text.splitlines():
        if line.startswith("diff --git "):
            current = _b_path_from_diff_git(line)
            if current:
                changes.setdefault(current, set())
            continue
        if current is None:
            continue
        if line.startswith("+++ "):
            raw = line[4:].strip()
            if raw == "/dev/null":
                continue
            renamed = _strip_ab_prefix(raw)
            if renamed and renamed != current:
                existing = changes.pop(current, set())
                if renamed not in changes or changes[renamed] is None:
                    changes[renamed] = set() if existing is None else set(existing)
                elif isinstance(existing, set) and isinstance(changes[renamed], set):
                    changes[renamed].update(existing)
                current = renamed
            continue
        match = _HUNK_RE.match(line)
        if not match:
            continue
        bucket = changes.get(current)
        if not isinstance(bucket, set):
            bucket = set()
            changes[current] = bucket
        new_start = int(match.group(3))
        new_count = int(match.group(4)) if match.group(4) is not None else 1
        if new_count <= 0:
            bucket.add(new_start if new_start > 0 else 1)
            continue
        for offset in range(new_count):
            bucket.add(new_start + offset)

    for path, lines in list(changes.items()):
        if isinstance(lines, set) and not lines:
            changes[path] = None
    return changes


def _unpushed_base(root: Path) -> str:
    """Commit to compare against: the upstream branch, or HEAD when this branch has no upstream."""
    upstream = _run_git(["rev-parse", "--abbrev-ref", "@{upstream}"], root)
    if upstream is not None and upstream.returncode == 0:
        ref = upstream.stdout.strip()
        if ref and not ref.startswith("@"):
            return ref
    return "HEAD"


def collect_git_changes(start_dir: Path) -> Optional[Dict[str, Optional[Set[int]]]]:
    """Files changed locally and not yet on the upstream branch, plus untracked files.

    Returns None when git cannot be read. Values are changed line numbers, or
    None when the whole file should be treated as edited (untracked, binary,
    or a diff with no hunk body).
    """
    root_proc = _run_git(["rev-parse", "--show-toplevel"], start_dir)
    if root_proc is None or root_proc.returncode != 0:
        return None
    root = Path(root_proc.stdout.strip())
    if not root_proc.stdout.strip():
        return None

    diff_proc = _run_git(["diff", _unpushed_base(root), "--unified=0", "--no-color"], root)
    if diff_proc is None or diff_proc.returncode != 0:
        return None
    untracked_proc = _run_git(["ls-files", "--others", "--exclude-standard"], root)
    if untracked_proc is None or untracked_proc.returncode != 0:
        return None

    changes = _parse_unified_diff(diff_proc.stdout)
    for raw_path in untracked_proc.stdout.splitlines():
        path = _strip_ab_prefix(raw_path)
        if path:
            changes[path] = None
    return changes


def _norm_path(path: str) -> str:
    raw = path.replace("\\", "/").strip()
    while raw.startswith("./"):
        raw = raw[2:]
    return raw.casefold()


def _same_file(source_file: str, changed_path: str) -> bool:
    src = _norm_path(source_file).strip("/")
    changed = _norm_path(changed_path).strip("/")
    if not src or not changed:
        return False
    if src == changed:
        return True
    return src.endswith("/" + changed) or changed.endswith("/" + src)


def _start_line(data: Dict[str, Any]) -> int:
    loc = str(data.get("source_location") or "")
    match = _SOURCE_LINE_RE.match(loc)
    if match:
        return int(match.group(1))
    return 1


def _line_near(line: int, lines: Set[int]) -> bool:
    if line in lines:
        return True
    return any(abs(line - other) <= LINE_PROXIMITY for other in lines)


def _edge_relation(G: nx.Graph, src: str, dst: str) -> str:
    data = G.get_edge_data(src, dst, default=None)
    if not isinstance(data, dict) or not data:
        return "calls"
    if "relation" in data:
        return str(data.get("relation") or "calls")
    for value in data.values():
        if isinstance(value, dict) and "relation" in value:
            return str(value.get("relation") or "calls")
    return "calls"


def _node_label(G: nx.Graph, node_id: str) -> str:
    data = G.nodes[node_id] if node_id in G else {}
    return str(data.get("label") or node_id)


def _file_name(data: Dict[str, Any]) -> str:
    source = str(data.get("source_file") or "").replace("\\", "/")
    return source.rsplit("/", 1)[-1] if source else ""


def _could_affect_reason(prefix: str, labels: List[str]) -> str:
    if not labels:
        return prefix
    preview = ", ".join(labels[:4])
    extra = len(labels) - 4
    if extra > 0:
        preview = f"{preview} +{extra} more"
    return f"{prefix} Could affect {preview}"


def classify_change_impact(
    G: nx.Graph,
    start_dir: Optional[Path] = None,
    changes: Optional[Dict[str, Optional[Set[int]]]] = None,
    cleared_nodes: Optional[Set[str]] = None,
    cleared_files: Optional[Set[str]] = None,
    failed_nodes: Optional[Set[str]] = None,
    failed_files: Optional[Set[str]] = None,
) -> Dict[str, Any]:
    """Classify graph nodes against the pending git diff.

    Every edited symbol is recorded, and callers up to depth 2 are marked as
    what that edit could affect. A critical node on that path is marked at risk.
    Nodes whose covering test scripts have passed are cleared as safe to push.
    Nodes whose covering test scripts failed are marked as failed/regressed.
    """
    try:
        from src.engine.analyzer import identify_critical_nodes
        from src.engine.blast_radius import ALL_FAILURE_RELATIONS
    except ImportError:
        from analyzer import identify_critical_nodes
        from blast_radius import ALL_FAILURE_RELATIONS

    if cleared_nodes is None and cleared_files is None and start_dir is not None:
        cleared_path = Path(start_dir) / ".failurelens" / "cleared-nodes.json"
        if not cleared_path.exists() and (Path(start_dir) / "cleared-nodes.json").exists():
            cleared_path = Path(start_dir) / "cleared-nodes.json"
        if cleared_path.exists():
            try:
                raw_cleared = json.loads(cleared_path.read_text(encoding="utf-8"))
                cleared_nodes = set(raw_cleared.get("nodes", []))
                cleared_files = set(raw_cleared.get("files", []))
            except Exception:
                pass

    if failed_nodes is None and failed_files is None and start_dir is not None:
        failed_path = Path(start_dir) / ".failurelens" / "failed-nodes.json"
        if not failed_path.exists() and (Path(start_dir) / "failed-nodes.json").exists():
            failed_path = Path(start_dir) / "failed-nodes.json"
        if failed_path.exists():
            try:
                raw_failed = json.loads(failed_path.read_text(encoding="utf-8"))
                failed_nodes = set(raw_failed.get("nodes", []))
                failed_files = set(raw_failed.get("files", []))
            except Exception:
                pass

    cleared_nodes = set(cleared_nodes or [])
    cleared_files = {str(f).replace("\\", "/").strip().lower() for f in (cleared_files or []) if f}
    failed_nodes = set(failed_nodes or [])
    failed_files = {str(f).replace("\\", "/").strip().lower() for f in (failed_files or []) if f}

    if changes is None:
        if start_dir is None:
            return {
                "available": False,
                "nodes": {},
                "message": "Git changes could not be read.",
            }
        changes = collect_git_changes(start_dir)
        if changes is None:
            return {
                "available": False,
                "nodes": {},
                "message": "Git changes could not be read.",
            }

    if not changes:
        return {
            "available": True,
            "nodes": {},
            "message": "No unpushed changes.",
        }

    edited: Set[str] = set()
    nodes_by_file: Dict[str, List[str]] = {}
    for node_id, data in G.nodes(data=True):
        source = str(data.get("source_file") or "")
        matched = next((path for path in changes if _same_file(source, path)), None)
        if matched is None:
            continue
        nodes_by_file.setdefault(matched, []).append(node_id)

    for path, node_ids in nodes_by_file.items():
        lines = changes.get(path)
        if not isinstance(lines, set) or not lines:
            edited.update(node_ids)
            continue
        matched_nodes = [
            node_id for node_id in node_ids
            if _line_near(_start_line(G.nodes[node_id]), lines)
        ]
        edited.update(matched_nodes or node_ids)

    if not G.is_directed():
        G = G.to_directed()

    critical = identify_critical_nodes(G, top_n=CRITICAL_NODE_LIMIT)
    critical_ids = {item["nodeId"] for item in critical if item.get("nodeId") in G}

    # Every edited symbol is a seed. Callers (predecessors) are what the edit
    # can break. A critical hub that depends on an edited symbol is reached
    # the same way, because the hub is a caller of that dependency.
    reached: Dict[str, str] = {}
    affected_by_origin: Dict[str, List[str]] = {}
    seen: Set[str] = set(edited)
    queue: List[tuple] = [(seed, 0, seed) for seed in edited]
    while queue:
        current, depth, origin = queue.pop(0)
        if depth >= IMPACT_DEPTH or current not in G:
            continue
        for pred in G.predecessors(current):
            if _edge_relation(G, pred, current) not in ALL_FAILURE_RELATIONS:
                continue
            if pred in seen:
                continue
            seen.add(pred)
            if pred not in edited:
                reached[pred] = origin
                affected_by_origin.setdefault(origin, []).append(pred)
            queue.append((pred, depth + 1, origin))

    # Only nodes directly in the Git change scope (edited nodes + reached blast radius)
    # belong in the Git change impact analysis. Unrelated nodes across the codebase
    # must never be pulled in or inflate the Safe to push counter.
    candidate_nodes = set(edited) | set(reached)

    nodes: Dict[str, Dict[str, str]] = {}
    for node_id in candidate_nodes:
        if node_id not in G:
            continue
        data = G.nodes[node_id]
        origin = reached.get(node_id)
        origin_label = _node_label(G, origin) if origin else None
        is_edited = node_id in edited
        at_risk = node_id in critical_ids and (is_edited or origin is not None)
        impact_labels = sorted(
            {_node_label(G, other) for other in affected_by_origin.get(node_id, [])}
        )

        source_file_norm = str(data.get("source_file") or "").replace("\\", "/").strip().lower()
        is_cleared = (
            node_id in cleared_nodes
            or source_file_norm in cleared_files
            or any(_same_file(source_file_norm, cf) for cf in cleared_files)
        )
        is_failed = (
            node_id in failed_nodes
            or source_file_norm in failed_files
            or any(_same_file(source_file_norm, ff) for ff in failed_files)
        )

        if is_failed:
            status = "failed"
            reason = f"Test failed / regression detected: broken by recent changes (originally could be affected by {origin_label or 'changes'})."
        elif is_cleared:
            status = "safe"
            reason = f"Safe to push. Verified by passed test script(s) and cleared by FailureLens (originally could be affected by {origin_label or 'changes'})."
        elif at_risk and is_edited:
            status = "critical"
            reason = _could_affect_reason("Not pushed yet.", impact_labels)
        elif at_risk:
            status = "critical"
            reason = f"Critical node at risk. Could be affected by a change in {origin_label}"
        elif is_edited:
            status = "edited"
            reason = _could_affect_reason("Not pushed yet.", impact_labels)
        else:
            status = "affected"
            reason = f"Could be affected by a change in {origin_label}"

        nodes[node_id] = {
            "status": status,
            "reason": reason,
            "color": STATUS_COLORS[status],
            "label": _node_label(G, node_id),
            "file": _file_name(data),
            "edited": "yes" if is_edited else "no",
        }

    if not nodes:
        return {
            "available": True,
            "nodes": {},
            "message": "No graph nodes match the pending git changes.",
        }

    return {"available": True, "nodes": nodes, "message": ""}


def _extract_json_array(html: str, marker: str) -> Optional[tuple]:
    idx = html.find(marker)
    if idx < 0:
        return None
    start = idx + len(marker)
    while start < len(html) and html[start].isspace():
        start += 1
    if start >= len(html) or html[start] != "[":
        return None

    depth = 0
    in_string = False
    escaped = False
    for pos in range(start, len(html)):
        ch = html[pos]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                end = pos + 1
                try:
                    return start, end, json.loads(html[start:end])
                except json.JSONDecodeError:
                    return None
    return None


def _paint_node(node: Dict[str, Any], info: Dict[str, str]) -> None:
    """Keep the community color. The unpushed marker is a flag drawn over the node."""
    previous = node.get("title") or node.get("label") or node.get("id") or ""
    if "\n" in previous:
        previous = previous.split("\n")[0]
    node["title"] = f"{previous}\n{info.get('reason', '')}"
    status = info.get("status")
    if isinstance(node.get("color"), dict):
        if status == "safe":
            node["color"]["border"] = "#22c55e"
            node["color"]["highlight"] = {"background": "#ffffff", "border": "#22c55e"}
            node["borderWidth"] = 3
        elif status == "failed":
            node["color"]["border"] = "#ef4444"
            node["color"]["highlight"] = {"background": "#ffffff", "border": "#ef4444"}
            node["borderWidth"] = 3
        elif status == "affected":
            node["color"]["border"] = "#eab308"
            node["color"]["highlight"] = {"background": "#ffffff", "border": "#eab308"}
            node["borderWidth"] = 2
        elif status == "edited":
            node["color"]["border"] = "#f97316"
            node["color"]["highlight"] = {"background": "#ffffff", "border": "#f97316"}
            node["borderWidth"] = 3


def _legend_html(impact: Dict[str, Any], counts: Dict[str, int]) -> str:
    note = str(impact.get("message") or "").strip()
    note_html = ""
    if note:
        note_html = (
            '<div id="change-legend-note" style="margin-top:8px;font-size:11px;color:var(--muted);">'
            f"{html_lib.escape(note)}</div>"
        )
    unpushed = sum(1 for info in impact.get("nodes", {}).values() if info.get("edited") == "yes")
    rows = [
        ("⚑", "Not pushed", unpushed, ""),
        ("↯", "Could be affected", counts.get("affected", 0), ""),
        ("✓", "Safe to push", counts.get("safe", 0), "color:#22c55e;font-weight:bold;"),
    ]
    if counts.get("failed", 0) > 0:
        rows.append(("✗", "Tests failed", counts.get("failed", 0), "color:#ef4444;font-weight:bold;"))
    rows.append(("◆", "Critical node at risk", counts.get("critical", 0), ""))

    items = []
    for mark, label, count, extra_style in rows:
        style_attr = f' style="width:14px;text-align:center;{extra_style}"' if extra_style else ' style="width:14px;text-align:center;"'
        marker = f'<span class="legend-label"{style_attr}>{mark}</span>'
        items.append(
            '<div class="legend-item">'
            f"{marker}"
            f'<span class="legend-label">{html_lib.escape(label)}</span>'
            f'<span class="legend-count">{count}</span></div>'
        )

    return (
        '<div id="change-legend" style="padding:12px;border-bottom:1px solid var(--border);">'
        '<h3 style="font-size:13px;color:var(--text-2);margin-bottom:10px;'
        'text-transform:uppercase;letter-spacing:0.05em;">Git change impact</h3>'
        + "".join(items)
        + note_html
        + "</div>"
    )


def _apply_overlay_markup(html: str, impact: Dict[str, Any]) -> str:
    counts = {"edited": 0, "affected": 0, "critical": 0, "safe": 0, "failed": 0}
    for info in impact.get("nodes", {}).values():
        status = str(info.get("status") or "")
        if status in counts:
            counts[status] += 1

    flags: Dict[str, Dict[str, str]] = {}
    extracted = _extract_json_array(html, "const RAW_NODES =")
    if extracted is None:
        extracted = _extract_json_array(html, "var RAW_NODES =")
    painted = False
    if extracted is not None:
        start, end, raw_nodes = extracted
        if isinstance(raw_nodes, list):
            for node in raw_nodes:
                if not isinstance(node, dict):
                    continue
                info = impact.get("nodes", {}).get(node.get("id"))
                if info is None:
                    info = impact.get("nodes", {}).get(str(node.get("id")))
                if not info:
                    continue
                _paint_node(node, info)
            encoded = json.dumps(raw_nodes, ensure_ascii=False).replace("<", "\\u003c")
            html = html[:start] + encoded + html[end:]
            painted = True

    if not painted:
        flags = {
            str(node_id): info
            for node_id, info in impact.get("nodes", {}).items()
        }

    if "borderWidth: n.borderWidth" not in html:
        html = re.sub(
            r"(title:\s*n\.title,)",
            r"\1 borderWidth: n.borderWidth || 1.5,",
            html,
            count=1,
        )
    for name in ("nodesDS", "network", "hiddenCommunities"):
        for keyword in ("const", "let"):
            html = html.replace(f"{keyword} {name} = ", f"var {name} = ", 1)

    legend = _legend_html(impact, counts)

    # Cleanly remove any existing change-legend and any stranded legend items before legend-wrap
    html = re.sub(r'<div id="change-legend"[^>]*>[\s\S]*?(?=<div id="legend-wrap">|</body>)', '', html, count=1)
    marker = '<div id="legend-wrap">'
    if marker in html:
        html = html.replace(marker, legend + marker, 1)
    elif "</body>" in html:
        html = html.replace("</body>", legend + "</body>", 1)
    else:
        html += legend

    # Clean up existing overlay scripts to allow clean updates
    script_pattern = re.compile(r'<style>\s*#edited-files-cb.*?<script id="failurelens-change-overlay">.*?</script>', re.DOTALL)
    html = script_pattern.sub('', html)
    script_only_pattern = re.compile(r'<script id="failurelens-change-overlay">.*?</script>', re.DOTALL)
    html = script_only_pattern.sub('', html)

    if not flags:
        flags = {
            str(node_id): info
            for node_id, info in impact.get("nodes", {}).items()
        }
    if flags and 'id="failurelens-change-overlay"' not in html:
        payload = json.dumps(flags, ensure_ascii=False).replace("<", "\\u003c")
        script = (
            "<style>"
            "#edited-files-cb{appearance:none;-webkit-appearance:none;width:14px;height:14px;"
            "border:1.5px solid var(--input-border);border-radius:3px;background:var(--bg);"
            "cursor:pointer;position:relative;flex-shrink:0;}"
            "#edited-files-cb:checked{background:#4E79A7;border-color:#4E79A7;}"
            "#edited-files-cb:checked::after{content:'';position:absolute;left:3.5px;top:1px;"
            "width:4px;height:7px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg);}"
            "</style>"
            "<script id=\"failurelens-change-overlay\">"
            "(function(){"
            f"var flags={payload};"
            "if(typeof nodesDS==='undefined')return;"
            "var legendEl=document.getElementById('legend');"
            "var editedIds={};"
            "Object.keys(flags).forEach(function(id){if(flags[id].edited==='yes')editedIds[id]=true;});"
            "var editedFiles={};"
            "nodesDS.get().forEach(function(n){if(editedIds[n.id]&&n.source_file)editedFiles[n.source_file]=true;});"
            "if(legendEl&&!document.getElementById('edited-files-item')){"
            "var shownCount=nodesDS.get().filter(function(n){return editedIds[n.id]||(n.source_file&&editedFiles[n.source_file]);}).length;"
            "var item=document.createElement('div');"
            "item.className='legend-item';"
            "item.id='edited-files-item';"
            "var cb=document.createElement('input');"
            "cb.type='checkbox';"
            "cb.className='edited-files-cb';"
            "cb.id='edited-files-cb';"
            "item.innerHTML='<span class=\"legend-label\" style=\"width:14px;text-align:center;\">⚑</span>"
            "<span class=\"legend-label\">Not pushed</span>"
            "<span class=\"legend-count\"></span>';"
            "item.querySelector('.legend-count').textContent=String(shownCount);"
            "item.prepend(cb);"
            "item.onclick=function(e){if(e.target===cb)return;cb.checked=!cb.checked;cb.dispatchEvent(new Event('change'));};"
            "legendEl.insertBefore(item, legendEl.firstChild);"
            "function inEditedFile(n){return !!(editedIds[n.id]||(n.source_file&&editedFiles[n.source_file]));}"
            "function communityHidden(n){return typeof hiddenCommunities!=='undefined'&&hiddenCommunities.has(n.community);}"
            "cb.addEventListener('change',function(e){"
            "e.stopPropagation();"
            "var ids=[];"
            "var updates=nodesDS.get().map(function(n){"
            "var show=cb.checked?inEditedFile(n):!communityHidden(n);"
            "if(show)ids.push(n.id);"
            "return {id:n.id,hidden:!show};"
            "});"
            "nodesDS.update(updates);"
            "if(typeof network!=='undefined'){"
            "if(cb.checked&&ids.length)network.fit({nodes:ids,animation:{duration:400,easingFunction:'easeInOutQuad'}});"
            "else network.fit({animation:{duration:400,easingFunction:'easeInOutQuad'}});"
            "}"
            "});"
            "}"
            "if(typeof network!=='undefined'){"
            "function ink(ctx){ctx.fillStyle='#ffffff';ctx.strokeStyle='#111827';ctx.lineWidth=1.25;ctx.fill();ctx.stroke();}"
            "function drawFlag(ctx,x,y,h){"
            "ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x,y-h);ctx.strokeStyle='#111827';ctx.lineWidth=2;ctx.stroke();"
            "ctx.beginPath();ctx.moveTo(x,y-h);ctx.lineTo(x+h*0.7,y-h*0.72);ctx.lineTo(x,y-h*0.42);ctx.closePath();ink(ctx);"
            "}"
            "function drawBolt(ctx,x,y,s){"
            "ctx.beginPath();ctx.moveTo(x,y-s);ctx.lineTo(x-s*0.45,y-s*0.05);ctx.lineTo(x-s*0.1,y-s*0.05);"
            "ctx.lineTo(x-s*0.55,y+s*0.7);ctx.lineTo(x+s*0.05,y+s*0.05);ctx.lineTo(x-s*0.28,y+s*0.05);ctx.closePath();ink(ctx);"
            "}"
            "function drawCheck(ctx,x,y,s){"
            "ctx.beginPath();ctx.arc(x,y,s*0.75,0,Math.PI*2);ctx.fillStyle='#22c55e';ctx.fill();"
            "ctx.beginPath();ctx.moveTo(x-s*0.35,y);ctx.lineTo(x-s*0.05,y+s*0.3);ctx.lineTo(x+s*0.38,y-s*0.3);"
            "ctx.strokeStyle='#ffffff';ctx.lineWidth=1.8;ctx.stroke();"
            "}"
            "function drawCross(ctx,x,y,s){"
            "ctx.beginPath();ctx.arc(x,y,s*0.75,0,Math.PI*2);ctx.fillStyle='#ef4444';ctx.fill();"
            "ctx.beginPath();"
            "ctx.moveTo(x-s*0.28,y-s*0.28);ctx.lineTo(x+s*0.28,y+s*0.28);"
            "ctx.moveTo(x+s*0.28,y-s*0.28);ctx.lineTo(x-s*0.28,y+s*0.28);"
            "ctx.strokeStyle='#ffffff';ctx.lineWidth=1.8;ctx.stroke();"
            "}"
            "function drawDiamond(ctx,x,y,s){"
            "ctx.beginPath();ctx.moveTo(x,y-s);ctx.lineTo(x+s*0.75,y);ctx.lineTo(x,y+s);ctx.lineTo(x-s*0.75,y);ctx.closePath();ink(ctx);"
            "}"
            "network.on('afterDrawing',function(ctx){"
            "var marked=nodesDS.get({filter:function(n){"
            "if(n.hidden)return false;"
            "var info=flags[n.id];"
            "var unpushed=editedIds[n.id]||(n.source_file&&editedFiles[n.source_file]);"
            "return !!(unpushed||(info&&(info.status==='affected'||info.status==='critical'||info.status==='safe'||info.status==='failed')));"
            "}});"
            "if(!marked.length)return;"
            "var pos=network.getPositions(marked.map(function(n){return n.id;}));"
            "marked.forEach(function(n){"
            "var p=pos[n.id];if(!p)return;"
            "var info=flags[n.id]||{};"
            "var r=Number(n.size)||12;var h=Math.max(14,Math.min(22,r*0.75));"
            "ctx.save();"
            "if(editedIds[n.id]||(n.source_file&&editedFiles[n.source_file]))drawFlag(ctx,p.x+r*0.72,p.y-r*0.72,h);"
            "if(info.status==='affected')drawBolt(ctx,p.x-r*0.72,p.y+r*0.15,h*0.55);"
            "if(info.status==='safe')drawCheck(ctx,p.x-r*0.72,p.y+r*0.15,h*0.55);"
            "if(info.status==='failed')drawCross(ctx,p.x-r*0.72,p.y+r*0.15,h*0.55);"
            "if(info.status==='critical')drawDiamond(ctx,p.x-r*0.72,p.y-r*0.72,h*0.42);"
            "ctx.restore();"
            "});"
            "});"
            "}"
            "})();"
            "</script>"
        )
        if "</body>" in html:
            html = html.replace("</body>", script + "</body>", 1)
    return html


def inject_change_overlay(html_path: Path, impact: Dict[str, Any]) -> bool:
    """Paint git-change rings, hover reasons, and the sidebar legend onto graph.html."""
    path = Path(html_path)
    content = path.read_text(encoding="utf-8")
    path.write_text(_apply_overlay_markup(content, impact), encoding="utf-8")
    return True
