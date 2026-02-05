#!/usr/bin/env python3
"""
Generate .bin fixture files for e2e testing.

Creates Float32Array binary files with known values:
- uniform-55.bin: All points = 55°C
- uniform-minus20.bin: All points = -20°C

These are used directly by tests (no OM decode needed).

Usage:
  python generate_test_bins.py

Output: ../fixtures/*.bin
"""

import numpy as np
from pathlib import Path

# O1280 Gaussian grid: 6,599,680 points
O1280_POINTS = 6_599_680

# Output directory
FIXTURES_DIR = Path(__file__).parent.parent / "fixtures"

def generate_uniform(value: float, filename: str, description: str):
    """Generate uniform Float32Array .bin file."""
    data = np.full(O1280_POINTS, value, dtype=np.float32)
    filepath = FIXTURES_DIR / filename
    with open(filepath, 'wb') as f:
        f.write(data.tobytes())
    print(f"  {filename}: {O1280_POINTS:,} floats, value={value} ({description})")

def main():
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Generating fixtures in {FIXTURES_DIR}/\n")

    # Temperature fixtures (in Celsius - shader expects Celsius)
    generate_uniform(55.0, "uniform-55.bin", "55°C")
    generate_uniform(-20.0, "uniform-minus20.bin", "-20°C")

    print("\nDone!")

if __name__ == "__main__":
    main()
