"""Generate Lumina 5-Color Extended (2468 colors, 6 optical layers) stacks.

The selection rules mirror Lumina Layers ``select_extended_1444_colors``.
Air padding in base recipes is encoded as 255 for the browser Uint8 loader.
"""

from pathlib import Path

import numpy as np


FILAMENTS = {
    0: {"rgb": [255, 255, 255], "td": 5.0},
    1: {"rgb": [220, 20, 60], "td": 4.0},
    2: {"rgb": [255, 230, 0], "td": 6.0},
    3: {"rgb": [0, 100, 240], "td": 2.0},
    4: {"rgb": [20, 20, 20], "td": 0.6},
}


def simulate(stack: tuple[int, ...]) -> np.ndarray:
    current = np.array([255, 255, 255], dtype=float)
    for filament_id in reversed(stack):
        props = FILAMENTS[filament_id]
        alpha = min(1.0, 0.08 / (props["td"] / 10.0))
        current = np.asarray(props["rgb"], dtype=float) * alpha + current * (1.0 - alpha)
    return current.astype(np.uint8)


def main() -> None:
    base = [tuple(reversed([index // 4**power % 4 for power in range(5)])) for index in range(1024)]
    candidates = []
    for stack in base:
        for outer in (1, 2, 3):
            recipe = (outer,) + stack
            candidates.append((recipe, simulate(recipe)))
    special = (4, 0, 0, 0, 0, 0)
    selected = [(special, simulate(special))]
    selected_stacks = {special}
    selected_rgb = np.asarray([selected[0][1]], dtype=int)
    for recipe, rgb in candidates:
        if len(selected) >= 1444:
            break
        if recipe in selected_stacks:
            continue
        if np.all(np.linalg.norm(selected_rgb - rgb.astype(int), axis=1) >= 8):
            selected.append((recipe, rgb))
            selected_stacks.add(recipe)
            selected_rgb = np.vstack([selected_rgb, rgb.astype(int)])
    if len(selected) < 1444:
        for recipe, rgb in candidates:
            if len(selected) >= 1444:
                break
            if recipe not in selected_stacks:
                selected.append((recipe, rgb))
                selected_stacks.add(recipe)

    base_padded = [(255,) + stack for stack in base]
    stacks = np.asarray(base_padded + [item[0] for item in selected[:1444]], dtype=np.uint8)
    output = Path(__file__).resolve().parents[1] / "public" / "lumina" / "luts" / "aliz-petg-5color-stacks.npy"
    output.parent.mkdir(parents=True, exist_ok=True)
    np.save(output, stacks)
    print(f"generated {output}: {stacks.shape}")


if __name__ == "__main__":
    main()
