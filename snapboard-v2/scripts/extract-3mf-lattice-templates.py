"""Extract top-face through-window contours from the user-supplied 3MF models.

Reference round holes, long slots, outer frames, and connector geometry are
intentionally excluded. SnapBoard keeps its own hole locations and states.
"""

from collections import Counter, defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile
import json

ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
    "regular": (Path("D:/Downloads/镂空省料洞洞板.3mf"), 240, 120),
    "rounded": (Path("D:/Downloads/宜家洞洞板200X200-5X5结构.3mf"), 200, 250),
    "voronoi": (Path("D:/Downloads/skadis_modular_board_240x240_voronoi.3mf"), 240, 100),
}


def signed_area(points):
    return sum(points[i][0] * points[(i + 1) % len(points)][1]
               - points[(i + 1) % len(points)][0] * points[i][1]
               for i in range(len(points))) / 2


def contours(path):
    with ZipFile(path) as archive:
        model = max((entry for entry in archive.infolist()
                     if entry.filename.startswith("3D/Objects/") and entry.filename.endswith(".model")),
                    key=lambda entry: entry.file_size)
        root = ET.fromstring(archive.read(model))
    vertices = [tuple(float(vertex.attrib[axis]) for axis in "xyz")
                for vertex in root.iter() if vertex.tag.endswith("}vertex")]
    edges = Counter()
    for triangle in root.iter():
        if not triangle.tag.endswith("}triangle"):
            continue
        ids = [int(triangle.attrib[key]) for key in ("v1", "v2", "v3")]
        if any(abs(vertices[index][2] - 2.5) > 0.001 for index in ids):
            continue
        for first, second in zip(ids, ids[1:] + ids[:1]):
            a = tuple(round(v, 4) for v in vertices[first][:2])
            b = tuple(round(v, 4) for v in vertices[second][:2])
            if a != b:
                edges[tuple(sorted((a, b)))] += 1
    neighbors = defaultdict(list)
    for (a, b), count in edges.items():
        if count == 1:
            neighbors[a].append(b)
            neighbors[b].append(a)
    seen = set()
    loops = []
    for start, adjacent in neighbors.items():
        for first in adjacent:
            if tuple(sorted((start, first))) in seen:
                continue
            loop = [start]
            previous, current = start, first
            while True:
                seen.add(tuple(sorted((previous, current))))
                if current == start:
                    if len(loop) >= 3:
                        loops.append(loop)
                    break
                loop.append(current)
                next_point = next((point for point in neighbors[current]
                                   if point != previous and tuple(sorted((current, point))) not in seen), None)
                if next_point is None:
                    break  # malformed/open cap edge, never use as a template window
                previous, current = current, next_point
    return loops


def extract(name, path, size, minimum_area):
    loops = contours(path)
    outer = max(loops, key=lambda ring: abs(signed_area(ring)))
    windows, slots = [], []
    shift = size / 2
    for ring in loops:
        if ring is outer:
            continue
        xs = [point[0] for point in ring]
        ys = [point[1] for point in ring]
        width, height = max(xs) - min(xs), max(ys) - min(ys)
        area = abs(signed_area(ring))
        if min(width, height) < 10 and max(width, height) > 10:
            slots.append([round((min(xs) + max(xs)) / 2 + shift, 3),
                          round((min(ys) + max(ys)) / 2 + shift, 3)])
            continue
        if area < minimum_area or min(width, height) < 12:
            continue  # reference round holes, slot collars, or tiny edge fragments
        windows.append([[round(x + shift, 3), round(y + shift, 3)] for x, y in ring])
    if not windows or not slots:
        raise ValueError(f"No usable windows/slots in {path}")
    return {"source": path.name, "size": size, "slots": slots, "windows": windows}


if __name__ == "__main__":
    templates = {name: extract(name, *arguments) for name, arguments in SOURCES.items()}
    target = ROOT / "src/data/openLatticeTemplates.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(templates, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(target)
    for name, template in templates.items():
        print(name, len(template["windows"]), "windows,", len(template["slots"]), "slot centers")
