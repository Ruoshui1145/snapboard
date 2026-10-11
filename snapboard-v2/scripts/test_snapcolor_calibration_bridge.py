"""Core smoke checks with actual Lumina extraction, not mocked API calls."""

import contextlib
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image

from snapcolor_calibration_bridge import handle


def synthetic_photo(grid, folder, seed):
    physical = grid + 2
    image = np.zeros((1000, 1000, 3), dtype=np.uint8)
    for row in range(grid):
        for col in range(grid):
            index = row * grid + col
            cx = int((col + 1.5) / physical * 1000)
            cy = int((row + 1.5) / physical * 1000)
            image[cy - 7:cy + 7, cx - 7:cx + 7] = [(index + seed) % 256, index // 256, seed]
    path = folder / "photo.png"
    Image.fromarray(image).save(path)
    half = 1000 / physical / 2
    corners = [[half, half], [1000 - half, half],
               [1000 - half, 1000 - half], [half, 1000 - half]]
    return path, corners


def call(request):
    with contextlib.redirect_stdout(io.StringIO()):
        return handle(request)


class CalibrationBridgeTests(unittest.TestCase):
    def test_status_reports_runtime(self):
        self.assertEqual(call({"action": "status"})["modes"],
                         ["RYBW", "CMYW", "5-Color Extended (1444)"])

    def test_generate_four_color_board(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = call({"action": "generate", "taskDir": tmp, "mode": "RYBW",
                           "blockSize": 1.0, "gap": 0.2, "backing": "White"})
            self.assertEqual(result["pages"], 1)
            board = Path(result["files"][0]["path"])
            self.assertEqual(board.name, "SnapColor_Calibration_RYBW.3mf")
            self.assertTrue(board.is_file())
            self.assertFalse(list(Path(tmp).glob("Lumina_Calibration_*")))
            with zipfile.ZipFile(board) as archive:
                self.assertIn("3D/3dmodel.model", archive.namelist())
                settings = json.loads(archive.read("Metadata/project_settings.config"))
                self.assertGreater(len(settings), 100)
            self.assertTrue(Path(result["previewFile"]).is_file())

    def test_generate_five_color_two_pages(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = call({"action": "generate", "taskDir": tmp, "mode": "5-Color Extended (1444)",
                           "blockSize": 1.0, "gap": 0.2})
            self.assertEqual(result["pages"], 2)
            self.assertEqual(Path(result["files"][0]["path"]).name,
                             "SnapColor_Calibration_5Color_Kit.zip")
            with zipfile.ZipFile(result["files"][0]["path"]) as archive:
                self.assertEqual(archive.namelist(), ["SnapColor_Calibration_5Color_Page1.3mf",
                                                       "SnapColor_Calibration_5Color_Page2.3mf"])
            self.assertFalse(list(Path(tmp).glob("Lumina_Calibration_*")))

    def test_four_color_extract_and_task_isolation(self):
        with tempfile.TemporaryDirectory() as one, tempfile.TemporaryDirectory() as two:
            paths = []
            for folder, seed in ((Path(one), 7), (Path(two), 19)):
                photo, corners = synthetic_photo(32, folder, seed)
                result = call({"action": "extract", "taskDir": str(folder), "mode": "RYBW",
                               "page": 1, "imagePath": photo.name, "corners": corners})
                self.assertTrue(result["ok"])
                self.assertEqual(result["cellCount"], 1024)
                lut_path = folder / "page-1.npy"
                self.assertEqual(Path(result["files"][0]["path"]), lut_path)
                lut = np.load(lut_path, allow_pickle=False)
                self.assertEqual(lut.shape, (32, 32, 3))
                np.testing.assert_array_equal(lut[0, 0], [seed, 0, seed])
                np.testing.assert_array_equal(lut[31, 31], [(1023 + seed) % 256, 3, seed])
                paths.append(lut_path)
            self.assertNotEqual(paths[0], paths[1])

    def test_five_color_second_page_merge_and_fix(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            for page, grid, seed in ((1, 32, 11), (2, 38, 23)):
                photo, corners = synthetic_photo(grid, folder, seed)
                result = call({"action": "extract", "taskDir": str(folder),
                               "mode": "5-Color Extended (1444)", "page": page,
                               "imagePath": photo.name, "corners": corners})
                self.assertEqual(result["cellCount"], grid * grid)
                np.testing.assert_array_equal(np.load(folder / f"page-{page}.npy")[grid - 1, grid - 1],
                                              [(grid * grid - 1 + seed) % 256, (grid * grid - 1) // 256, seed])
            fixed = call({"action": "fix", "taskDir": str(folder), "mode": "5-Color Extended (1444)",
                          "page": 2, "index": 1443, "rgb": [9, 8, 7], "reason": "visual correction"})
            correction = json.loads((folder / "corrections.jsonl").read_text(encoding="utf-8"))
            self.assertEqual(correction["after"], [9, 8, 7])
            self.assertEqual(correction["reason"], "visual correction")
            self.assertTrue(fixed["ok"])
            np.testing.assert_array_equal(np.load(folder / "page-2.npy")[37, 37], [9, 8, 7])
            merged = call({"action": "merge", "taskDir": str(folder), "mode": "5-Color Extended (1444)"})
            self.assertEqual(merged["cellCount"], 2468)
            with np.load(folder / "merged-5color.npz", allow_pickle=False) as data:
                self.assertEqual(data["rgb"].shape, (2468, 3))
                self.assertEqual(data["stacks"].shape, (2468, 6))
                np.testing.assert_array_equal(data["rgb"][-1], [9, 8, 7])
                self.assertTrue(np.all((data["stacks"] >= -1) & (data["stacks"] <= 4)))

    def test_out_of_bounds_does_not_save_black_lut(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            photo, corners = synthetic_photo(32, folder, 5)
            with self.assertRaisesRegex(ValueError, "outside the image"):
                call({"action": "extract", "taskDir": str(folder), "mode": "RYBW", "page": 1,
                      "imagePath": photo.name, "corners": corners, "offsetX": 10000})
            self.assertFalse((folder / "page-1.npy").exists())


if __name__ == "__main__":
    unittest.main()
