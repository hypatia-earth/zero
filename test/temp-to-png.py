#!/usr/bin/env python3
"""
Convert O1280 Gaussian grid temperature to equirectangular PNG

Usage: python temp-to-png.py <input.temp.bin> [output.png]
"""

import sys
import numpy as np
from PIL import Image

WIDTH = 1024
HEIGHT = 512
N = 1280  # O1280 grid
NUM_RINGS = 2 * N  # 2560


def generate_gaussian_lats():
    """Approximate Gaussian latitudes (linear spacing)"""
    lats = np.zeros(NUM_RINGS, dtype=np.float32)
    for i in range(NUM_RINGS):
        lat_deg = 90 - (i + 0.5) * 180 / NUM_RINGS
        lats[i] = np.radians(lat_deg)
    return lats


def generate_ring_offsets():
    """Generate cumulative ring offsets"""
    offsets = np.zeros(NUM_RINGS, dtype=np.uint32)
    cumulative = 0
    for i in range(NUM_RINGS):
        offsets[i] = cumulative
        ring_from_pole = i + 1 if i < N else NUM_RINGS - i
        points_in_ring = 4 * ring_from_pole + 16
        cumulative += points_in_ring
    return offsets


def find_ring(lat, lats):
    """Binary search for ring index"""
    return np.searchsorted(-lats, -lat)


def get_temp(lat, lon, data, lats, offsets):
    """Get temperature at lat/lon from Gaussian grid"""
    ring = find_ring(lat, lats)
    ring = min(ring, NUM_RINGS - 1)

    ring_from_pole = ring + 1 if ring < N else NUM_RINGS - ring
    n_points = 4 * ring_from_pole + 16

    lon_norm = lon if lon >= 0 else lon + 2 * np.pi
    lon_idx = int(lon_norm / (2 * np.pi) * n_points) % n_points

    idx = offsets[ring] + lon_idx
    return data[idx] if idx < len(data) else 0


def temp_to_rgb(temp_c):
    """Temperature colormap: blue -> cyan -> green -> yellow -> red"""
    t = max(0, min(1, (temp_c + 50) / 100))  # -50 to +50 range

    if t < 0.25:
        r, g, b = 0, t * 4, 1
    elif t < 0.5:
        r, g, b = 0, 1, 1 - (t - 0.25) * 4
    elif t < 0.75:
        r, g, b = (t - 0.5) * 4, 1, 0
    else:
        r, g, b = 1, 1 - (t - 0.75) * 4, 0

    return int(r * 255), int(g * 255), int(b * 255)


def main():
    if len(sys.argv) < 2:
        print("Usage: python temp-to-png.py <input.temp.bin> [output.png]")
        sys.exit(1)

    input_file = sys.argv[1]
    output_file = sys.argv[2] if len(sys.argv) > 2 else input_file.replace('.bin', '.png')

    print(f"Reading: {input_file}")
    data = np.fromfile(input_file, dtype=np.float32)
    print(f"Data points: {len(data):,}")

    # Generate LUTs
    lats = generate_gaussian_lats()
    offsets = generate_ring_offsets()

    print(f"Rendering {WIDTH}x{HEIGHT}...")

    # Create image
    img = Image.new('RGB', (WIDTH, HEIGHT))
    pixels = img.load()

    min_t, max_t = float('inf'), float('-inf')

    for y in range(HEIGHT):
        lat = (0.5 - y / HEIGHT) * np.pi  # +90 to -90

        for x in range(WIDTH):
            lon = (x / WIDTH) * 2 * np.pi - np.pi  # -180 to +180

            temp = get_temp(lat, lon, data, lats, offsets)
            min_t = min(min_t, temp)
            max_t = max(max_t, temp)

            pixels[x, y] = temp_to_rgb(temp)

    print(f"Temp range: {min_t:.1f}°C to {max_t:.1f}°C")

    img.save(output_file)
    print(f"Saved: {output_file}")


if __name__ == '__main__':
    main()
