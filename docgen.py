"""PDF + Word generation for Studiora AI.

Every document gets: a title banner, an "At a glance" box, a concept-map diagram (boxes + arrows),
a grid of key-concept boxes, then the sections (paragraphs / bullet lists / tables) with
"remember" call-out boxes.
"""
import re
from datetime import date

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (Image, KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle)

import diagram as dg

INDIGO, VIOLET, INK, MUTED = "#3b3f9e", "#7c5cff", "#1b2140", "#5d6690"
BOX_FILL, BOX_LINE = "#f3f4ff", "#c9cdf5"
TIP_FILL, TIP_LINE = "#fff7e0", "#f0b429"

# ------------------------------------------------------------------ fonts
_fam = dg.find_font_family()
if _fam:
    pdfmetrics.registerFont(TTFont("SD", _fam[0]))
    pdfmetrics.registerFont(TTFont("SD-B", _fam[1]))
    pdfmetrics.registerFont(TTFont("SD-I", _fam[2]))
    pdfmetrics.registerFontFamily("SD", normal="SD", bold="SD-B", italic="SD-I", boldItalic="SD-B")
    F, FB = "SD", "SD-B"
else:  # Helvetica only knows latin-1, so unusual characters get simplified
    F, FB = "Helvetica", "Helvetica-Bold"

_SIMPLE = {"→": "->", "←": "<-", "–": "-", "—": "-", "’": "'", "‘": "'", "“": '"', "”": '"', "…": "...",
           "≥": ">=", "≤": "<=", "×": "x", "≈": "~", "✓": "v", "•": "*"}


def _t(text):
    text = str(text or "")
    if not _fam:
        for k, v in _SIMPLE.items():
            text = text.replace(k, v)
        text = text.encode("latin-1", "replace").decode("latin-1")
    return text


def _fmt(text):
    """Escape for reportlab and turn **bold** / `code` into markup."""
    t = _t(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"`(.+?)`", r"<font face='Courier'>\1</font>", t)
    return t


def _plain(text):
    return re.sub(r"[*`]", "", str(text or ""))


# ------------------------------------------------------------------ normalise the model's JSON
def _clip(s, n):
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def _first_sentence(text, n=90):
    m = re.match(r"(.+?[.!?])(\s|$)", str(text or "").strip())
    return _clip(m.group(1) if m else text, n)


def normalize_doc(data, fallback_title="Study Notes", max_sections=14):
    if not isinstance(data, dict):
        raise ValueError("document is not an object")
    sections = []
    for s in (data.get("sections") or [])[:max_sections]:
        if not isinstance(s, dict):
            continue
        heading = _clip(s.get("heading") or s.get("title"), 90)
        if not heading:
            continue
        e = {"heading": heading}
        pts, tbl = s.get("points"), s.get("table")
        if isinstance(pts, list) and any(str(p).strip() for p in pts):
            e["points"] = [str(p).strip() for p in pts if str(p).strip()]
        elif isinstance(tbl, list) and len(tbl) >= 2 and all(isinstance(r, list) for r in tbl):
            width = max(len(r) for r in tbl)
            e["table"] = [[_clip(c, 160) for c in (list(r) + [""] * width)[:width]] for r in tbl[:15]]
        else:
            content = s.get("content") or s.get("text") or ""
            if isinstance(content, list):
                content = " ".join(map(str, content))
            e["content"] = str(content).strip()
        if not (e.get("points") or e.get("table") or e.get("content")):
            continue
        body = e.get("content") or (e.get("points") or [""])[0] or ""
        e["gist"] = _clip(s.get("gist") or _first_sentence(body), 80)
        e["tip"] = _clip(s.get("tip") or s.get("remember") or "", 260)
        sections.append(e)
    if not sections:
        raise ValueError("model returned no usable sections")
    kt = [_clip(k, 200) for k in (data.get("key_takeaways") or data.get("takeaways") or []) if str(k).strip()][:8]
    if not kt:
        kt = [f"{s['heading']}: {s['gist']}" for s in sections[:6]]
    return {"title": _clip(data.get("title") or fallback_title, 90) or fallback_title,
            "summary": _clip(data.get("summary") or "", 600), "key_takeaways": kt, "sections": sections}


# ------------------------------------------------------------------ PDF
def _styles():
    def ps(name, **kw):
        return ParagraphStyle(name, fontName=kw.pop("fontName", F), **kw)
    return {
        "title": ps("t", fontName=FB, fontSize=24, leading=29, textColor=colors.white),
        "sub": ps("sub", fontSize=9.5, leading=13, textColor=colors.HexColor("#dfe2ff")),
        "h1": ps("h1", fontName=FB, fontSize=14.5, leading=18, textColor=colors.HexColor(INDIGO)),
        "h2": ps("h2", fontName=FB, fontSize=11, leading=14, textColor=colors.HexColor(INK)),
        "body": ps("b", fontSize=10.5, leading=15.5, textColor=colors.HexColor("#252b4a"), spaceAfter=6, alignment=TA_LEFT),
        "bullet": ps("bl", fontSize=10.5, leading=15, textColor=colors.HexColor("#252b4a"), leftIndent=14,
                     bulletIndent=2, spaceAfter=3),
        "small": ps("s", fontSize=9, leading=12.5, textColor=colors.HexColor(MUTED)),
        "cell": ps("c", fontSize=9.2, leading=12.5, textColor=colors.HexColor("#252b4a")),
        "cellh": ps("ch", fontName=FB, fontSize=9.2, leading=12.5, textColor=colors.white),
        "tip": ps("tip", fontSize=9.8, leading=14, textColor=colors.HexColor("#5a4300")),
        "gistT": ps("gt", fontName=FB, fontSize=10, leading=13, textColor=colors.HexColor(INDIGO)),
        "gist": ps("g", fontSize=8.8, leading=12, textColor=colors.HexColor(MUTED)),
    }


def _box(flowables, width, fill=BOX_FILL, line=BOX_LINE, accent=VIOLET, pad=9):
    t = Table([[flowables]], colWidths=[width])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(fill)),
        ("BOX", (0, 0), (-1, -1), 0.8, colors.HexColor(line)),
        ("LINEBEFORE", (0, 0), (0, -1), 4, colors.HexColor(accent)),
        ("LEFTPADDING", (0, 0), (-1, -1), pad + 3), ("RIGHTPADDING", (0, 0), (-1, -1), pad),
        ("TOPPADDING", (0, 0), (-1, -1), pad), ("BOTTOMPADDING", (0, 0), (-1, -1), pad),
    ]))
    return t


def build_pdf(doc, path, diagram_png=None, diagram_size=None):
    st = _styles()
    W, _ = A4
    margin = 18 * mm
    cw = W - 2 * margin
    story = []

    # title banner
    sub = f"Study notes  ·  {date.today().strftime('%d %b %Y')}  ·  made with Studiora AI"
    banner = Table([[[Paragraph(_fmt(doc["title"]), st["title"]), Spacer(1, 4), Paragraph(_t(sub), st["sub"])]]],
                   colWidths=[cw])
    banner.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(INDIGO)),
        ("LINEBELOW", (0, 0), (-1, -1), 4, colors.HexColor(VIOLET)),
        ("LEFTPADDING", (0, 0), (-1, -1), 16), ("RIGHTPADDING", (0, 0), (-1, -1), 16),
        ("TOPPADDING", (0, 0), (-1, -1), 18), ("BOTTOMPADDING", (0, 0), (-1, -1), 16),
    ]))
    story += [banner, Spacer(1, 12)]

    # at a glance
    glance = [Paragraph("AT A GLANCE", st["gistT"]), Spacer(1, 3)]
    if doc.get("summary"):
        glance.append(Paragraph(_fmt(doc["summary"]), st["body"]))
    for k in doc["key_takeaways"]:
        glance.append(Paragraph(_fmt(k), st["bullet"], bulletText="•"))
    story += [_box(glance, cw), Spacer(1, 14)]

    # concept map
    if diagram_png:
        iw = cw
        ih = iw * diagram_size[1] / diagram_size[0]
        maxh = 150 * mm
        if ih > maxh:
            ih, iw = maxh, maxh * diagram_size[0] / diagram_size[1]
        cap = Paragraph("CONCEPT MAP", st["gistT"])
        img = Image(diagram_png, width=iw, height=ih)
        img.hAlign = "CENTER"
        frame = Table([[cap], [img]], colWidths=[cw])
        frame.setStyle(TableStyle([
            ("BOX", (0, 0), (-1, -1), 0.8, colors.HexColor(BOX_LINE)),
            ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
            ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ("ALIGN", (0, 1), (-1, 1), "CENTER"),
        ]))
        story += [KeepTogether([frame]), Spacer(1, 14)]

    # key-concept boxes (2-column grid)
    cells = []
    for i, s in enumerate(doc["sections"]):
        acc = dg.ACCENTS[i % len(dg.ACCENTS)]
        cell = Table([[[Paragraph(f"{i + 1}. {_fmt(s['heading'])}", st["gistT"]),
                        Paragraph(_fmt(s["gist"]), st["gist"])]]], colWidths=[cw / 2 - 8])
        cell.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(BOX_FILL)),
            ("BOX", (0, 0), (-1, -1), 0.8, colors.HexColor(BOX_LINE)),
            ("LINEBEFORE", (0, 0), (0, -1), 4, colors.HexColor(acc)),
            ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ]))
        cells.append(cell)
    if len(cells) > 1:
        rows = [cells[i:i + 2] for i in range(0, len(cells), 2)]
        if len(rows[-1]) == 1:
            rows[-1].append("")
        grid = Table(rows, colWidths=[cw / 2, cw / 2])
        grid.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                                  ("RIGHTPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                                  ("TOPPADDING", (0, 0), (-1, -1), 0)]))
        story += [Paragraph("KEY CONCEPTS", st["gistT"]), Spacer(1, 6), grid, Spacer(1, 8)]

    # sections
    for i, s in enumerate(doc["sections"]):
        acc = dg.ACCENTS[i % len(dg.ACCENTS)]
        head = Table([[Paragraph(f"{i + 1}.  {_fmt(s['heading'])}", st["h1"])]], colWidths=[cw])
        head.setStyle(TableStyle([
            ("LINEBEFORE", (0, 0), (0, -1), 5, colors.HexColor(acc)),
            ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f7f8ff")),
            ("LEFTPADDING", (0, 0), (-1, -1), 10), ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ]))
        body = []
        if s.get("content"):
            for para in re.split(r"\n\s*\n|\n", s["content"]):
                if para.strip():
                    body.append(Paragraph(_fmt(para.strip()), st["body"]))
        if s.get("points"):
            body += [Paragraph(_fmt(p), st["bullet"], bulletText="•") for p in s["points"]]
        if s.get("table"):
            rows = s["table"]
            data = [[Paragraph(_fmt(c), st["cellh"]) for c in rows[0]]] + \
                   [[Paragraph(_fmt(c), st["cell"]) for c in r] for r in rows[1:]]
            t = Table(data, colWidths=[cw / len(rows[0])] * len(rows[0]), repeatRows=1)
            t.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(INDIGO)),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor(BOX_LINE)),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f6f7ff")]),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]))
            body.append(t)
        if s.get("tip"):
            body += [Spacer(1, 6), _box([Paragraph(f"<b>Remember:</b> {_fmt(s['tip'])}", st["tip"])], cw,
                                         fill=TIP_FILL, line="#f3d98a", accent=TIP_LINE, pad=7)]
        story += [Spacer(1, 6), KeepTogether([head, Spacer(1, 6)] + body[:1])] + body[1:] + [Spacer(1, 6)]

    def footer(canvas, d):
        canvas.saveState()
        canvas.setFont(F, 8)
        canvas.setFillColor(colors.HexColor(MUTED))
        canvas.drawString(margin, 10 * mm, _t(doc["title"])[:70])
        canvas.drawRightString(W - margin, 10 * mm, f"Page {d.page}")
        canvas.restoreState()

    SimpleDocTemplate(str(path), pagesize=A4, leftMargin=margin, rightMargin=margin, topMargin=16 * mm,
                      bottomMargin=18 * mm, title=_plain(doc["title"]), author="Studiora AI"
                      ).build(story, onFirstPage=footer, onLaterPages=footer)


# ------------------------------------------------------------------ DOCX
def build_docx(doc, path, diagram_png=None):
    from docx import Document
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Inches, Pt, RGBColor

    def rgb(h):
        h = h.lstrip("#")
        return RGBColor(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))

    def shade(cell, fill):
        tcPr = cell._tc.get_or_add_tcPr()
        shd = OxmlElement("w:shd")
        shd.set(qn("w:val"), "clear"); shd.set(qn("w:color"), "auto"); shd.set(qn("w:fill"), fill.lstrip("#"))
        tcPr.append(shd)

    def borders(cell, line, accent=None, accent_sz=36):
        tcPr = cell._tc.get_or_add_tcPr()
        b = OxmlElement("w:tcBorders")
        for side in ("top", "left", "bottom", "right"):
            el = OxmlElement(f"w:{side}")
            el.set(qn("w:val"), "single")
            el.set(qn("w:sz"), str(accent_sz if (side == "left" and accent) else 6))
            el.set(qn("w:color"), (accent if (side == "left" and accent) else line).lstrip("#"))
            b.append(el)
        tcPr.append(b)

    def margins(cell, top=90, bottom=90, left=160, right=120):
        tcPr = cell._tc.get_or_add_tcPr()
        m = OxmlElement("w:tcMar")
        for k, v in (("top", top), ("left", left), ("bottom", bottom), ("right", right)):
            el = OxmlElement(f"w:{k}")
            el.set(qn("w:w"), str(v)); el.set(qn("w:type"), "dxa")
            m.append(el)
        tcPr.append(m)

    def runs(par, text, size=None, color=None, bold=False):
        parts = re.split(r"(\*\*.+?\*\*)", str(text))
        for part in parts:
            if not part:
                continue
            b = part.startswith("**") and part.endswith("**") and len(part) > 4
            r = par.add_run(part[2:-2] if b else part)
            r.bold = bold or b
            if size: r.font.size = Pt(size)
            if color: r.font.color.rgb = rgb(color)
        return par

    def one_cell_box(fill, line, accent):
        t = d.add_table(rows=1, cols=1)
        t.alignment = WD_TABLE_ALIGNMENT.CENTER
        c = t.rows[0].cells[0]
        shade(c, fill); borders(c, line, accent); margins(c)
        c.paragraphs[0].paragraph_format.space_after = Pt(2)
        return c

    d = Document()
    sec = d.sections[0]
    sec.left_margin = sec.right_margin = Inches(0.85)
    sec.top_margin = sec.bottom_margin = Inches(0.8)
    normal = d.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(11)
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), "Calibri")

    # banner
    t = d.add_table(rows=1, cols=1)
    c = t.rows[0].cells[0]
    shade(c, INDIGO); margins(c, 220, 200, 260, 200)
    runs(c.paragraphs[0], doc["title"], 24, "#ffffff", True)
    p2 = c.add_paragraph()
    runs(p2, f"Study notes  ·  {date.today().strftime('%d %b %Y')}  ·  made with Studiora AI", 9.5, "#dfe2ff")
    d.add_paragraph()

    # at a glance
    c = one_cell_box(BOX_FILL, BOX_LINE, VIOLET)
    runs(c.paragraphs[0], "AT A GLANCE", 9.5, INDIGO, True)
    if doc.get("summary"):
        runs(c.add_paragraph(), doc["summary"], 10.5)
    for k in doc["key_takeaways"]:
        p = c.add_paragraph(style="List Bullet")
        p.paragraph_format.space_after = Pt(2)
        runs(p, k, 10.5)
    d.add_paragraph()

    # concept map
    if diagram_png:
        h = d.add_paragraph()
        runs(h, "CONCEPT MAP", 9.5, INDIGO, True)
        pic = d.add_paragraph()
        pic.alignment = 1
        pic.add_run().add_picture(str(diagram_png), width=Inches(6.4))
        d.add_paragraph()

    # key concept boxes
    secs = doc["sections"]
    if len(secs) > 1:
        runs(d.add_paragraph(), "KEY CONCEPTS", 9.5, INDIGO, True)
        rows = (len(secs) + 1) // 2
        grid = d.add_table(rows=rows, cols=2)
        grid.alignment = WD_TABLE_ALIGNMENT.CENTER
        for i, s in enumerate(secs):
            cell = grid.rows[i // 2].cells[i % 2]
            acc = dg.ACCENTS[i % len(dg.ACCENTS)]
            shade(cell, BOX_FILL); borders(cell, "#ffffff", acc, 30); margins(cell, 70, 70, 140, 100)
            runs(cell.paragraphs[0], f"{i + 1}. {s['heading']}", 10.5, INDIGO, True)
            runs(cell.add_paragraph(), s["gist"], 9, MUTED)
        d.add_paragraph()

    # sections
    for i, s in enumerate(secs):
        acc = dg.ACCENTS[i % len(dg.ACCENTS)]
        ht = d.add_table(rows=1, cols=1)
        hc = ht.rows[0].cells[0]
        shade(hc, "#f7f8ff"); borders(hc, "#f7f8ff", acc, 40); margins(hc, 80, 80, 160, 100)
        runs(hc.paragraphs[0], f"{i + 1}.  {s['heading']}", 14, INDIGO, True)
        hc.paragraphs[0].paragraph_format.keep_with_next = True
        sp = d.add_paragraph()
        sp.paragraph_format.space_after = Pt(0)
        if s.get("content"):
            for para in re.split(r"\n\s*\n|\n", s["content"]):
                if para.strip():
                    p = d.add_paragraph()
                    p.paragraph_format.space_after = Pt(6)
                    runs(p, para.strip(), 11)
        if s.get("points"):
            for pt in s["points"]:
                p = d.add_paragraph(style="List Bullet")
                p.paragraph_format.space_after = Pt(3)
                runs(p, pt, 11)
        if s.get("table"):
            rows = s["table"]
            tb = d.add_table(rows=len(rows), cols=len(rows[0]))
            tb.alignment = WD_TABLE_ALIGNMENT.CENTER
            for ri, r in enumerate(rows):
                for ci, val in enumerate(r):
                    cell = tb.rows[ri].cells[ci]
                    borders(cell, BOX_LINE); margins(cell, 60, 60, 100, 80)
                    if ri == 0:
                        shade(cell, INDIGO)
                        runs(cell.paragraphs[0], val, 10, "#ffffff", True)
                    else:
                        if ri % 2 == 0:
                            shade(cell, "#f6f7ff")
                        runs(cell.paragraphs[0], val, 10)
            d.add_paragraph()
        if s.get("tip"):
            c = one_cell_box(TIP_FILL, "#f3d98a", TIP_LINE)
            runs(c.paragraphs[0], "Remember: ", 10, "#5a4300", True)
            runs(c.paragraphs[0], s["tip"], 10, "#5a4300")
            d.add_paragraph()
    d.core_properties.title = _plain(doc["title"])
    d.core_properties.author = "Studiora AI"
    d.save(str(path))
