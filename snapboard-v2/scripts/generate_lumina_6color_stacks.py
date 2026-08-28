"""Generate Lumina Smart-1296 stack order without importing the desktop UI.

This is a mechanical asset generator copied from Lumina Layers' public
``core.calibration.get_top_1296_colors`` selection rules.  The output uses the
same top-to-bottom convention as Lumina's image processor.
"""

from itertools import product
from pathlib import Path

import numpy as np


FILAMENTS = {
    0: {"rgb": [255, 255, 255], "td": 5.0},
    1: {"rgb": [0, 255, 255], "td": 3.5},
    2: {"rgb": [255, 0, 255], "td": 3.0},
    3: {"rgb": [0, 174, 66], "td": 2.0},
    4: {"rgb": [255, 255, 0], "td": 6.0},
    5: {"rgb": [0, 0, 0], "td": 0.6},
}


def simulated_rgb(stack: tuple[int, ...]) -> np.ndarray:
    current = np.array([255, 255, 255], dtype=float)
    for filament_id in stack:
        props = FILAMENTS[filament_id]
        alpha = min(1.0, 0.08 / (props["td"] / 10.0))
        current = np.asarray(props["rgb"], dtype=float) * alpha + current * (1.0 - alpha)
    return current.astype(np.uint8)


def main() -> None:
    candidates = [(stack, simulated_rgb(stack)) for stack in product(range(6), repeat=5)]
    selected = [next(item for item in candidates if item[0] == (index,) * 5) for index in range(6)]
    selected_stacks = {item[0] for item in selected}
    for item in candidates:
        if len(selected) >= 1296:
            break
        if item[0] in selected_stacks:
            continue
        if all(np.linalg.norm(item[1].astype(int) - chosen[1].astype(int)) >= 8 for chosen in selected):
            selected.append(item)
            selected_stacks.add(item[0])
    if len(selected) < 1296:
        for item in candidates:
            if len(selected) >= 1296:
                break
            if item[0] not in selected_stacks:
                selected.append(item)
                selected_stacks.add(item[0])
    stacks = np.asarray([tuple(reversed(item[0])) for item in selected[:1296]], dtype=np.uint8)
    output = Path(__file__).resolve().parents[1] / "public" / "lumina" / "luts" / "bambu-pla-6color-stacks.npy"
    output.parent.mkdir(parents=True, exist_ok=True)
    np.save(output, stacks)
    print(f"generated {output}: {stacks.shape}")


if __name__ == "__main__":
    main()
