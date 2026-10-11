"""Read-only native raster-label benchmark for clipped SVG colour regions."""
import argparse
import json
import math
import time
from pathlib import Path

import cv2
import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument("geojson")
parser.add_argument("--pitch", type=float, default=0.2, help="mm per pixel")
parser.add_argument("--raw-output", help="optional int16 bottom-up material grid under output/benchmarks")
parser.add_argument("--drop-up-to-pixels", type=int, default=0, help="benchmark only: reassign isolated components at or below this size")
parser.add_argument("--material-map", help="optional real SnapColor color-to-layer material map")
parser.add_argument("--recipe-map", help="optional real SnapColor color-to-recipe map")
parser.add_argument("--layer", type=int, default=0, help="physical layer from bottom for material map")
parser.add_argument("--bounds", help="optional minX,minY,maxX,maxY crop in millimeters")
parser.add_argument("--top-down", action="store_true", help="write raster top-down for native export")
args = parser.parse_args()
if not 0.05 <= args.pitch <= 0.5:
    parser.error("pitch must be 0.05–0.5 mm")
if not 0 <= args.drop_up_to_pixels <= 16:
    parser.error("drop-up-to-pixels must be 0–16")
material_map = None
if args.material_map:
    material_map = json.loads(Path(args.material_map).read_text(encoding="utf-8"))
    if not 0 <= args.layer < material_map["layers"]:
        parser.error("layer outside material map")
recipe_map = json.loads(Path(args.recipe_map).read_text(encoding="utf-8"))["recipes"] if args.recipe_map else None
if recipe_map and material_map:
    parser.error("choose either recipe-map or material-map")

start = time.perf_counter()
with open(args.geojson, encoding="utf-8") as source:
    features = json.load(source)["features"]
min_x = min_y = math.inf
max_x = max_y = -math.inf
for feature in features:
    for ring in feature["geometry"]["coordinates"]:
        for x, y in ring:
            min_x, max_x = min(min_x, x), max(max_x, x)
            min_y, max_y = min(min_y, y), max(max_y, y)
if args.bounds:
    crop = [float(value) for value in args.bounds.split(",")]
    if len(crop) != 4 or not crop[0] < crop[2] or not crop[1] < crop[3]:
        parser.error("bounds must be minX,minY,maxX,maxY")
    min_x, min_y, max_x, max_y = crop
width = math.ceil((max_x - min_x) / args.pitch) + 1
height = math.ceil((max_y - min_y) / args.pitch) + 1
labels = np.zeros((height, width), np.uint16)
color_ids = {}
for feature in features:
    color = feature["properties"]["color"]
    if color not in color_ids:
        color_ids[color] = (recipe_map[color] + 1 if recipe_map else
                            material_map["colors"][color][args.layer] + 1
                            if material_map else len(color_ids) + 1)
    rings = []
    for ring in feature["geometry"]["coordinates"]:
        xy = np.asarray(ring, dtype=np.float64)
        vertices = np.rint(np.column_stack(((xy[:, 0] - min_x) / args.pitch,
                                            (max_y - xy[:, 1]) / args.pitch))).astype(np.int32)
        if len(vertices) >= 3:
            rings.append(vertices)
    if rings:
        cv2.fillPoly(labels, rings, color_ids[color])
raster_seconds = time.perf_counter() - start
removed_components = removed_pixels = 0
if args.drop_up_to_pixels:
    tiny = np.zeros(labels.shape, np.uint8)
    for value in set(color_ids.values()):
        count, components, stats, _ = cv2.connectedComponentsWithStats(
            np.uint8(labels == value), connectivity=8)
        small = np.where((stats[:, cv2.CC_STAT_AREA] <= args.drop_up_to_pixels)
                         & (np.arange(count) != 0))[0]
        removed_components += len(small)
        for component in small:
            left, top, width_box, height_box, area_pixels = stats[component]
            tiny[top:top + height_box, left:left + width_box] |= np.uint8(
                components[top:top + height_box, left:left + width_box] == component)
            removed_pixels += int(area_pixels)
    if removed_pixels:
        _, nearest = cv2.distanceTransformWithLabels(
            tiny, cv2.DIST_L2, 3, labelType=cv2.DIST_LABEL_PIXEL)
        labels[tiny != 0] = labels[tiny == 0][nearest[tiny != 0] - 1]
if args.raw_output:
    target = Path(args.raw_output).resolve()
    allowed = (Path.cwd() / "output" / "benchmarks").resolve()
    if not target.is_relative_to(allowed) or target.exists():
        parser.error("raw output must be a new file under output/benchmarks")
    (labels.astype(np.int16) - 1 if args.top_down else np.flipud(labels.astype(np.int16) - 1)).tofile(target)
horizontal = np.count_nonzero(labels[:, 1:] != labels[:, :-1])
vertical = np.count_nonzero(labels[1:, :] != labels[:-1, :])
contours = components = vertices = simplified_vertices = 0
for value in set(color_ids.values()):
    mask = np.uint8(labels == value)
    paths, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    contours += len(paths)
    if hierarchy is not None:
        components += int(np.count_nonzero(hierarchy[0, :, 3] == -1))
    vertices += sum(len(path) for path in paths)
    simplified_vertices += sum(len(cv2.approxPolyDP(path, 0.5, True)) for path in paths)
print(json.dumps({
    "pitchMm": args.pitch,
    "canvas": [width, height],
    "boundsMm": [min_x, min_y, max_x, max_y],
    "pixels": width * height,
    "sourceColors": len(color_ids),
    "materials": len(set(color_ids.values())),
    "reassignedComponents": removed_components,
    "reassignedAreaMm2": round(removed_pixels * args.pitch ** 2, 4),
    "reassignedFraction": round(removed_pixels / (width * height), 6),
    "unassignedPixels": int(np.count_nonzero(labels == 0)),
    "boundaryEdges": int(horizontal + vertical),
    "boundaryLengthMm": round((horizontal + vertical) * args.pitch, 2),
    "contours": contours,
    "components": components,
    "vertices": vertices,
    "approxVerticesHalfPixel": simplified_vertices,
    "rasterSeconds": round(raster_seconds, 2),
    "totalSeconds": round(time.perf_counter() - start, 2),
}, ensure_ascii=False))
