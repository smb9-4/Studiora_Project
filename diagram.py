"""Diagram engine for Studiora AI.

normalize(data)  -> clean {title, groups:[{id,label,nodes:[{id,label,note}]}], edges:[{from,to,label}]}
layout(diagram)  -> same data + x/y/w/h for every group/node and a bezier path for every edge
render_png(lay)  -> Pillow image (dark theme for the app, light theme for PDF / Word)

The browser draws the very same layout as SVG (with zoom / pan), so what you see in the
chat is what ends up in the downloaded document.
"""
import math
import os
import re

from PIL import Image, ImageDraw, ImageFont

NODE_W, NODE_H = 190, 64
PAD, TITLE_H = 18, 34
GAP_X, GAP_Y, MARGIN = 46, 88, 44
NODE_GAP = 14

ACCENTS = ["#6aa8ff", "#a78bfa", "#34d399", "#fbbf24", "#f472b6", "#22d3ee", "#fb923c"]

# ---------------------------------------------------------------- fonts
_FONT_DIRS = [
    "/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/dejavu", "/usr/share/fonts/TTF",
    "C:/Windows/Fonts", "/Library/Fonts", "/System/Library/Fonts/Supplemental",
    "/System/Library/Fonts", os.path.expanduser("~/.fonts"),
]
FONT_FAMILIES = [  # (regular, bold, italic)
    ("DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "DejaVuSans-Oblique.ttf"),
    ("segoeui.ttf", "segoeuib.ttf", "segoeuii.ttf"),
    ("arial.ttf", "arialbd.ttf", "ariali.ttf"),
    ("Arial.ttf", "Arial Bold.ttf", "Arial Italic.ttf"),
]


def find_font_family():
    """(regular, bold, italic) absolute paths of the first complete family found, else None."""
    for fam in FONT_FAMILIES:
        found = []
        for name in fam:
            for d in _FONT_DIRS:
                p = os.path.join(d, name)
                if os.path.exists(p):
                    found.append(p)
                    break
        if len(found) == 3:
            return tuple(found)
    return None


_FAM = find_font_family()


def _font(size, bold=False):
    if _FAM:
        try:
            return ImageFont.truetype(_FAM[1 if bold else 0], size)
        except OSError:
            pass
    try:
        return ImageFont.load_default(size)
    except TypeError:  # very old Pillow
        return ImageFont.load_default()


# ---------------------------------------------------------------- normalise
def _clip(s, n):
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def _wrap(label, width=22, max_lines=2):
    words, lines, cur = label.split(), [], ""
    for w in words:
        if len(cur) + len(w) + (1 if cur else 0) <= width:
            cur = f"{cur} {w}".strip()
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = _clip(lines[-1] + "…", width)
    return lines or [label]


def normalize(data):
    """Accepts whatever the model produced (or an already laid-out diagram) and returns clean data."""
    if not isinstance(data, dict):
        raise ValueError("diagram is not an object")
    raw_groups = data.get("groups") or data.get("layers") or []
    if not raw_groups and isinstance(data.get("nodes"), list):  # flat list of nodes
        raw_groups = [{"label": "", "nodes": [n], "frame": False} for n in data["nodes"]]

    groups, lookup, used, total = [], {}, set(), 0
    for gi, g in enumerate(raw_groups[:7]):
        if not isinstance(g, dict):
            continue
        glabel = _clip(g.get("label") or g.get("name") or g.get("title") or "", 40)
        gid = re.sub(r"\W+", "_", str(g.get("id") or f"g{gi + 1}")) or f"g{gi + 1}"
        nodes = []
        for ni, n in enumerate((g.get("nodes") or g.get("items") or [])[:6]):
            if isinstance(n, str):
                n = {"label": n}
            if not isinstance(n, dict) or total >= 24:
                continue
            label = _clip(n.get("label") or n.get("name") or n.get("title"), 48)
            if not label:
                continue
            nid = re.sub(r"\W+", "_", str(n.get("id") or f"{gid}_n{ni + 1}")) or f"{gid}_n{ni + 1}"
            while nid in used:
                nid += "_"
            used.add(nid)
            nodes.append({"id": nid, "label": label, "note": _clip(n.get("note") or n.get("sub") or "", 34)})
            lookup[nid.lower()] = nid
            lookup.setdefault(label.lower(), nid)
            total += 1
        if nodes:
            frame = g.get("frame", True) is not False and bool(glabel or len(nodes) > 1)
            groups.append({"id": gid, "label": glabel, "nodes": nodes, "frame": frame})
            lookup.setdefault(gid.lower(), nodes[0]["id"])
            if glabel:
                lookup.setdefault(glabel.lower(), nodes[0]["id"])
    if total < 2:
        raise ValueError("diagram needs at least two boxes")

    edges, seen = [], set()
    for e in (data.get("edges") or data.get("links") or data.get("connections") or [])[:30]:
        if not isinstance(e, dict):
            continue
        a = lookup.get(str(e.get("from", e.get("source", ""))).strip().lower())
        b = lookup.get(str(e.get("to", e.get("target", ""))).strip().lower())
        if a and b and a != b and (a, b) not in seen:
            seen.add((a, b))
            edges.append({"from": a, "to": b, "label": _clip(e.get("label") or "", 22)})
    if not edges and len(groups) > 1:  # no usable arrows: chain the layers so it still reads as a flow
        for g1, g2 in zip(groups, groups[1:]):
            edges.append({"from": g1["nodes"][0]["id"], "to": g2["nodes"][0]["id"], "label": ""})
    return {"title": _clip(data.get("title") or "Diagram", 70), "groups": groups, "edges": edges}


def from_sections(title, root_note, items):
    """Deterministic fallback: a root box with one box per main idea. items = [(heading, gist)]."""
    nodes = [{"id": f"s{i}", "label": h, "note": _clip(g, 34)} for i, (h, g) in enumerate(items[:9])]
    d = {
        "title": title,
        "groups": [
            {"id": "root", "label": "", "frame": False, "nodes": [{"id": "r", "label": title, "note": root_note}]},
            {"id": "main", "label": "Main ideas", "nodes": nodes},
        ],
        "edges": [{"from": "r", "to": n["id"], "label": ""} for n in nodes],
    }
    return normalize(d)


# ---------------------------------------------------------------- layout
def _group_columns(m):
    return m if m <= 4 else 3


def layout(d):
    d = normalize(d)
    groups, edges = d["groups"], d["edges"]
    n = len(groups)
    gof = {nd["id"]: gi for gi, g in enumerate(groups) for nd in g["nodes"]}

    # ---- 1. give every group a layer (row) using the arrows between groups
    adj = {i: set() for i in range(n)}
    for e in edges:
        a, b = gof[e["from"]], gof[e["to"]]
        if a != b:
            adj[a].add(b)
    state, back = {}, set()

    def dfs(u):
        state[u] = 1
        for v in sorted(adj[u]):
            if state.get(v) == 1:
                back.add((u, v))
            elif not state.get(v):
                dfs(v)
        state[u] = 2

    for i in range(n):
        if not state.get(i):
            dfs(i)
    dag = [(u, v) for u in adj for v in adj[u] if (u, v) not in back]
    layer = [0] * n
    for _ in range(n):
        for u, v in dag:
            layer[v] = max(layer[v], layer[u] + 1)
    if max(layer) == 0 and n > 3:  # no flow between groups: just tile them
        layer = [i // 3 for i in range(n)]

    rows = {}
    for gi in range(n):
        rows.setdefault(layer[gi], []).append(gi)

    # ---- 2. order each row by the average position of what feeds it (fewer crossings)
    pos = {}
    for L in sorted(rows):
        if L > 0:
            def key(gi, L=L):
                srcs = [pos[u] for u, v in dag if v == gi and u in pos]
                return (sum(srcs) / len(srcs)) if srcs else rows[L].index(gi) / max(1, len(rows[L]))
            rows[L].sort(key=key)
        for k, gi in enumerate(rows[L]):
            pos[gi] = (k + 0.5) / len(rows[L])

    # ---- 3. size groups and place them
    sizes = {}
    for gi, g in enumerate(groups):
        m = len(g["nodes"])
        if not g["frame"]:
            sizes[gi] = (NODE_W, NODE_H, 1)
            continue
        cols = _group_columns(m)
        r = math.ceil(m / cols)
        w = cols * NODE_W + (cols - 1) * NODE_GAP + 2 * PAD
        h = (TITLE_H if g["label"] else PAD) + r * NODE_H + (r - 1) * NODE_GAP + PAD
        sizes[gi] = (w, h, cols)

    row_w = {L: sum(sizes[g][0] for g in gs) + GAP_X * (len(gs) - 1) for L, gs in rows.items()}
    W = max(row_w.values())
    y = MARGIN
    out_groups = [None] * n
    for L in sorted(rows):
        gs = rows[L]
        rh = max(sizes[g][1] for g in gs)
        x = MARGIN + (W - row_w[L]) / 2
        for gi in gs:
            g = groups[gi]
            w, h, cols = sizes[gi]
            gy = y + (rh - h) / 2
            nodes = []
            for k, nd in enumerate(g["nodes"]):
                if g["frame"]:
                    cx, cy = k % cols, k // cols
                    nx = x + PAD + cx * (NODE_W + NODE_GAP)
                    ny = gy + (TITLE_H if g["label"] else PAD) + cy * (NODE_H + NODE_GAP)
                else:
                    nx, ny = x, gy
                nodes.append({**nd, "x": round(nx), "y": round(ny), "w": NODE_W, "h": NODE_H,
                              "lines": _wrap(nd["label"]), "gi": gi})
            out_groups[gi] = {"id": g["id"], "label": g["label"], "frame": g["frame"], "color": gi % len(ACCENTS),
                              "x": round(x), "y": round(gy), "w": round(w), "h": round(h), "nodes": nodes}
            x += w + GAP_X
        y += rh + GAP_Y
    height = y - GAP_Y + MARGIN
    width = W + 2 * MARGIN

    # ---- 4. route arrows (bottom -> top between rows, side -> side inside a row)
    nodes_by_id = {nd["id"]: nd for g in out_groups for nd in g["nodes"]}
    plan = []
    ports = {}
    for i, e in enumerate(edges):
        a, b = nodes_by_id[e["from"]], nodes_by_id[e["to"]]
        if b["y"] >= a["y"] + a["h"] - 1:
            kind, sa, sb = "down", "b", "t"
        elif a["y"] >= b["y"] + b["h"] - 1:
            kind, sa, sb = "up", "t", "b"
        else:
            kind = "side"
            sa, sb = ("r", "l") if b["x"] >= a["x"] else ("l", "r")
        plan.append((kind, sa, sb))
        ports.setdefault((a["id"], sa), []).append((i, "out", b["x"] + b["w"] / 2, b["y"] + b["h"] / 2))
        ports.setdefault((b["id"], sb), []).append((i, "in", a["x"] + a["w"] / 2, a["y"] + a["h"] / 2))
    anchor = {}
    for (nid, side), lst in ports.items():
        nd = nodes_by_id[nid]
        horiz = side in ("t", "b")
        lst.sort(key=lambda t: t[2] if horiz else t[3])
        for k, (i, role, _, _) in enumerate(lst):
            f = (k + 1) / (len(lst) + 1)
            if side == "t":
                pt = (nd["x"] + nd["w"] * f, nd["y"])
            elif side == "b":
                pt = (nd["x"] + nd["w"] * f, nd["y"] + nd["h"])
            elif side == "l":
                pt = (nd["x"], nd["y"] + nd["h"] * f)
            else:
                pt = (nd["x"] + nd["w"], nd["y"] + nd["h"] * f)
            anchor[(i, role)] = pt
    out_edges = []
    for i, e in enumerate(edges):
        kind = plan[i][0]
        (x0, y0), (x1, y1) = anchor[(i, "out")], anchor[(i, "in")]
        if kind == "side":
            dx = max(24, abs(x1 - x0) * 0.4) * (1 if x1 >= x0 else -1)
            c1, c2 = (x0 + dx, y0), (x1 - dx, y1)
        else:
            dy = max(30, abs(y1 - y0) * 0.5) * (1 if kind == "down" else -1)
            c1, c2 = (x0, y0 + dy), (x1, y1 - dy)
        mid = (0.125 * x0 + 0.375 * c1[0] + 0.375 * c2[0] + 0.125 * x1,
               0.125 * y0 + 0.375 * c1[1] + 0.375 * c2[1] + 0.125 * y1)
        out_edges.append({"from": e["from"], "to": e["to"], "label": e["label"],
                          "path": [round(v, 1) for v in (x0, y0, *c1, *c2, x1, y1)],
                          "mid": [round(mid[0], 1), round(mid[1], 1)]})
    return {"title": d["title"], "width": round(width), "height": round(height),
            "groups": out_groups, "edges": out_edges}


# ---------------------------------------------------------------- PNG renderer
def _rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _mix(c1, c2, t):
    return tuple(int(a + (b - a) * t) for a, b in zip(_rgb(c1), _rgb(c2)))


def _bezier(p, steps=48):
    x0, y0, x1, y1, x2, y2, x3, y3 = p
    pts = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        pts.append((u ** 3 * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3 * x3,
                    u ** 3 * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y3))
    return pts


THEMES = {
    "dark": dict(bg="#0b1022", text="#e8ecff", muted="#9aa6d6", node="#141b38", edge="#8aa0e8", label_bg="#0b1022"),
    "light": dict(bg="#ffffff", text="#1b2140", muted="#5d6690", node="#ffffff", edge="#5a6bb8", label_bg="#ffffff"),
}


def render_png(lay, theme="dark", scale=2, with_title=False):
    th = THEMES[theme]
    top = 56 if with_title else 0
    s = scale
    W, H = int(lay["width"] * s), int((lay["height"] + top) * s)
    img = Image.new("RGB", (W, H), _rgb(th["bg"]))
    dr = ImageDraw.Draw(img)
    f_title, f_b, f_s, f_g, f_e = _font(20 * s, True), _font(13 * s, True), _font(11 * s), _font(12 * s, True), _font(11 * s)

    def box(x, y, w, h, fill, outline, r=12, width=1):
        dr.rounded_rectangle([x * s, (y + top) * s, (x + w) * s, (y + h + top) * s], r * s, fill=fill,
                             outline=outline, width=int(width * s))

    if with_title:
        dr.text((MARGIN * s, 16 * s), lay["title"], font=f_title, fill=_rgb(th["text"]))
    for g in lay["groups"]:
        acc = ACCENTS[g["color"] % len(ACCENTS)]
        if g["frame"]:
            box(g["x"], g["y"], g["w"], g["h"], _mix(th["bg"], acc, 0.10 if theme == "dark" else 0.08),
                _mix(th["bg"], acc, 0.55), r=16)
    for e in lay["edges"]:
        pts = [(x * s, (y + top) * s) for x, y in _bezier(e["path"])]
        col = _rgb(th["edge"])
        dr.line(pts, fill=col, width=int(2 * s), joint="curve")
        (ax, ay), (bx, by) = pts[-4], pts[-1]
        ang = math.atan2(by - ay, bx - ax)
        L = 10 * s
        dr.polygon([(bx, by),
                    (bx - L * math.cos(ang - 0.42), by - L * math.sin(ang - 0.42)),
                    (bx - L * math.cos(ang + 0.42), by - L * math.sin(ang + 0.42))], fill=col)
    for g in lay["groups"]:
        acc = ACCENTS[g["color"] % len(ACCENTS)]
        if g["frame"] and g["label"]:
            dr.text(((g["x"] + PAD) * s, (g["y"] + 9 + top) * s), g["label"].upper(), font=f_g,
                    fill=_rgb(acc) if theme == "dark" else _mix(acc, "#000000", 0.35))
    for g in lay["groups"]:
        acc = ACCENTS[g["color"] % len(ACCENTS)]
        for n in g["nodes"]:
            box(n["x"], n["y"], n["w"], n["h"], _rgb(th["node"]), _mix(th["bg"], acc, 0.9), r=10, width=1.5)
            lines = n["lines"]
            note = n.get("note")
            total = len(lines) * 16 + (14 if note else 0)
            ty = n["y"] + (n["h"] - total) / 2 + top
            for ln in lines:
                w = dr.textlength(ln, font=f_b)
                dr.text(((n["x"] + n["w"] / 2) * s - w / 2, ty * s), ln, font=f_b, fill=_rgb(th["text"]))
                ty += 16
            if note:
                w = dr.textlength(note, font=f_s)
                dr.text(((n["x"] + n["w"] / 2) * s - w / 2, (ty + 1) * s), note, font=f_s, fill=_rgb(th["muted"]))
    for e in lay["edges"]:
        if e["label"]:
            mx, my = e["mid"][0] * s, (e["mid"][1] + top) * s
            w = dr.textlength(e["label"], font=f_e)
            dr.rounded_rectangle([mx - w / 2 - 6 * s, my - 9 * s, mx + w / 2 + 6 * s, my + 9 * s], 8 * s,
                                 fill=_rgb(th["label_bg"]), outline=_mix(th["bg"], th["edge"], 0.6), width=s)
            dr.text((mx - w / 2, my - 7 * s), e["label"], font=f_e, fill=_rgb(th["muted"]))
    return img
