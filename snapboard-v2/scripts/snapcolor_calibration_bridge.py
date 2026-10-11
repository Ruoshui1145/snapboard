"""Small JSON subprocess bridge to the GPLv3 Lumina calibration core.

One JSON request on stdin, one JSON response on stdout. Lumina's diagnostic
prints go to stderr. The caller owns taskDir; every input/output stays there.
"""

from __future__ import annotations

import contextlib
import json
import os
import sys
import traceback
import zipfile
from pathlib import Path


SOURCE = Path(os.environ.get("SNAPBOARD_CALIBRATION_SOURCE") or
              Path(__file__).resolve().parents[2] / "vendor" / "lumina-studio" / "source")
sys.path[:0] = [str(SOURCE), str(SOURCE / "Lumina-Layers-source")]
MODES = ["RYBW", "CMYW", "5-Color Extended (1444)"]


def task_path(task_dir: Path, name: str) -> Path:
    path = (task_dir / name).resolve()
    if not path.is_relative_to(task_dir):
        raise ValueError("File path is outside the calibration task")
    return path


def file_info(path: Path) -> dict:
    return {"name": path.name, "path": str(path)}


def handle(request: dict) -> dict:
    action = request.get("action")
    if action == "status":
        import numpy  # noqa: F401
        import cv2  # noqa: F401
        import trimesh  # noqa: F401
        import colormath  # noqa: F401
        from PIL import Image  # noqa: F401
        from core import calibration, extractor  # noqa: F401
        return {"ok": True, "available": True, "modes": MODES}

    task_dir = Path(request["taskDir"])
    if not task_dir.is_absolute() or not task_dir.is_dir():
        raise ValueError("taskDir must be an existing absolute directory")
    task_dir = task_dir.resolve()
    mode = request.get("mode", "RYBW")
    if mode not in MODES:
        raise ValueError(f"Unsupported calibration mode: {mode}")
    page = int(str(request.get("page", "1")).replace("Page ", ""))
    if page not in (1, 2) or (page == 2 and mode != MODES[2]):
        raise ValueError("Invalid page for calibration mode")

    if action == "generate":
        from core import calibration

        block = float(request.get("blockSize", 5.0))
        gap = float(request.get("gap", 0.8))
        if not (1.0 <= block <= 6.0 and 0.2 <= gap <= 2.0):
            raise ValueError("Block size or gap is outside the supported range")
        calibration.OUTPUT_DIR = str(task_dir)
        if mode == MODES[2]:
            boards = []
            for page_index in (0, 1):
                path, preview, message = calibration.generate_5color_extended_board(block, gap, page_index)
                board = task_path(task_dir, f"SnapColor_Calibration_5Color_Page{page_index + 1}.3mf")
                Path(path).replace(board)
                boards.append(board)
                if page_index == 0:
                    preview_path = task_path(task_dir, "board-preview.png")
                    preview.save(preview_path)
            board_path = task_path(task_dir, "SnapColor_Calibration_5Color_Kit.zip")
            with zipfile.ZipFile(board_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for board in boards:
                    archive.write(board, board.name)
            files = [file_info(board_path), *(file_info(board) for board in boards), file_info(preview_path)]
            return {"ok": True, "message": message, "pages": 2, "previewFile": str(preview_path), "files": files}
        path, preview, message = calibration.generate_calibration_board(
            color_mode=mode, block_size_mm=block, gap_mm=gap, backing_color=request.get("backing", "White")
        )
        board = task_path(task_dir, f"SnapColor_Calibration_{mode}.3mf")
        Path(path).replace(board)
        preview_path = task_path(task_dir, "board-preview.png")
        preview.save(preview_path)
        return {"ok": True, "message": message, "pages": 1, "previewFile": str(preview_path),
                "files": [file_info(board), file_info(preview_path)]}

    if action == "extract":
        import numpy as np
        from PIL import Image, ImageOps
        from core.extractor import run_extraction

        image_path = task_path(task_dir, request["imagePath"])
        with Image.open(image_path) as image:
            oriented = ImageOps.exif_transpose(image)
            if oriented.width * oriented.height > 20_000_000:
                raise ValueError("Calibration photo exceeds 20 megapixels")
            rgb = np.asarray(oriented.convert("RGB"))
        points = request["corners"]
        if len(points) != 4 or any(len(point) != 2 for point in points):
            raise ValueError("Exactly four corner points are required")
        lut_path = task_path(task_dir, f"page-{page}.npy")
        warp, preview, saved_path, message = run_extraction(
            rgb, points, int(request.get("offsetX", 0)), int(request.get("offsetY", 0)),
            float(request.get("zoom", 1)), float(request.get("barrel", 0)),
            bool(request.get("wb", False)), bool(request.get("bright", False)),
            color_mode=mode, page_choice=f"Page {page}", output_path=str(lut_path),
        )
        if not saved_path:
            raise ValueError(message)
        warp_path = task_path(task_dir, f"page-{page}-warp.png")
        preview_path = task_path(task_dir, f"page-{page}-preview.png")
        Image.fromarray(warp).save(warp_path)
        Image.fromarray(preview).save(preview_path)
        count = 1444 if mode == MODES[2] and page == 2 else 1024
        return {"ok": True, "message": message, "page": page, "cellCount": count, "invalidCells": [],
                "previewFile": str(preview_path), "files": [file_info(lut_path), file_info(warp_path), file_info(preview_path)]}

    if action == "fix":
        import numpy as np
        from PIL import Image
        from core.extractor import manual_fix_cell

        lut_path = task_path(task_dir, f"page-{page}.npy")
        lut = np.load(lut_path, allow_pickle=False)
        index = int(request["index"])
        if index < 0 or index >= lut.shape[0] * lut.shape[1]:
            raise ValueError("Cell index is outside the LUT")
        rgb = request["rgb"]
        if len(rgb) != 3 or any(not isinstance(value, int) or not 0 <= value <= 255 for value in rgb):
            raise ValueError("rgb must contain three integers from 0 to 255")
        reason = str(request.get("reason", "")).strip()[:200]
        if not reason:
            raise ValueError("A correction reason is required")
        before = lut.reshape(-1, 3)[index].tolist()
        preview, message = manual_fix_cell(divmod(index, lut.shape[1]),
                                           "#{:02x}{:02x}{:02x}".format(*rgb), str(lut_path))
        if preview is None:
            raise ValueError(message)
        preview_path = task_path(task_dir, f"page-{page}-preview.png")
        Image.fromarray(preview).save(preview_path)
        with task_path(task_dir, "corrections.jsonl").open("a", encoding="utf-8") as log:
            log.write(json.dumps({"page": page, "index": index, "before": before, "after": rgb,
                                  "reason": reason}, ensure_ascii=True) + "\n")
        return {"ok": True, "message": message, "page": page, "cellCount": lut.shape[0] * lut.shape[1],
                "invalidCells": [], "previewFile": str(preview_path),
                "files": [file_info(lut_path), file_info(preview_path)]}

    if action == "merge":
        from core.calibration import merge_5color_extended

        if mode != MODES[2]:
            raise ValueError("Merge requires 5-Color Extended mode")
        output_path = task_path(task_dir, "merged-5color.npz")
        rgb, stacks, _ = merge_5color_extended(
            str(task_path(task_dir, "page-1.npy")), str(task_path(task_dir, "page-2.npy")), str(output_path)
        )
        return {"ok": True, "message": "Merged 1024 + 1444 measured colors", "cellCount": len(rgb),
                "files": [file_info(output_path)]}

    raise ValueError(f"Unsupported action: {action}")


def main() -> None:
    try:
        request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        with contextlib.redirect_stdout(sys.stderr):
            response = handle(request)
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        response = {"ok": False, "error": str(error)}
    print(json.dumps(response, ensure_ascii=True))


if __name__ == "__main__":
    main()
