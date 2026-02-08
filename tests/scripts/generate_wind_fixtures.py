#!/usr/bin/env python3
"""
Generate wind fixture files for e2e testing.

Creates Float32Array binary files for wind U/V components:
- wind-cyclone-u.bin: U component (east-west) for cyclonic pattern at 0,0
- wind-cyclone-v.bin: V component (north-south) for cyclonic pattern at 0,0

The cyclone is an inward counter-clockwise spiral centered at lat/lon 0,0.

Usage:
  python generate_wind_fixtures.py

Output: ../fixtures/wind-cyclone-u.bin, ../fixtures/wind-cyclone-v.bin
"""

import numpy as np
from pathlib import Path

# O1280 Gaussian grid parameters
N = 1280
NUM_RINGS = 2 * N  # 2560
O1280_POINTS = 6_599_680

# Output directory
FIXTURES_DIR = Path(__file__).parent.parent / "fixtures"


def generate_gaussian_grid():
    """Generate lat/lon for each point in O1280 grid."""
    lats = np.zeros(O1280_POINTS, dtype=np.float32)
    lons = np.zeros(O1280_POINTS, dtype=np.float32)

    idx = 0
    for ring in range(NUM_RINGS):
        # Latitude for this ring (90 to -90, linear approximation)
        lat_deg = 90 - (ring + 0.5) * 180 / NUM_RINGS
        lat_rad = np.radians(lat_deg)

        # Points in this ring
        ring_from_pole = ring + 1 if ring < N else NUM_RINGS - ring
        n_points = 4 * ring_from_pole + 16

        # Longitudes evenly spaced around the ring
        for i in range(n_points):
            lon_rad = (2 * np.pi * i) / n_points
            lats[idx] = lat_rad
            lons[idx] = lon_rad
            idx += 1

    return lats, lons


def generate_cyclone(lats, lons, center_lat=0.0, center_lon=0.0,
                     max_wind=25.0, core_radius=0.1, outer_radius=0.8):
    """
    Generate cyclonic wind pattern.

    Args:
        lats, lons: Grid coordinates in radians
        center_lat, center_lon: Storm center in radians
        max_wind: Maximum wind speed (m/s)
        core_radius: Eye radius in radians (~600 km)
        outer_radius: Outer influence radius in radians (~5000 km)

    Returns:
        u, v: Wind components (east-west, north-south)
    """
    # Distance from center (simple Euclidean on sphere surface)
    dlat = lats - center_lat
    dlon = lons - center_lon

    # Wrap longitude difference
    dlon = np.where(dlon > np.pi, dlon - 2*np.pi, dlon)
    dlon = np.where(dlon < -np.pi, dlon + 2*np.pi, dlon)

    # Scale longitude by cos(lat) for proper distance
    dlon_scaled = dlon * np.cos(lats)

    # Distance from center
    dist = np.sqrt(dlat**2 + dlon_scaled**2)

    # Wind speed profile: 0 at center, max at core_radius, decay beyond
    speed = np.zeros_like(dist)

    # Inside core: ramp up
    inside_core = dist < core_radius
    speed[inside_core] = max_wind * (dist[inside_core] / core_radius)

    # Between core and outer: full strength then decay
    between = (dist >= core_radius) & (dist < outer_radius)
    decay = 1 - (dist[between] - core_radius) / (outer_radius - core_radius)
    speed[between] = max_wind * decay

    # Tangent direction (counter-clockwise): perpendicular to radial
    # Radial: (dlat, dlon_scaled) -> Tangent: (-dlon_scaled, dlat)
    dist_safe = np.maximum(dist, 1e-6)
    tang_lat = -dlon_scaled / dist_safe
    tang_lon = dlat / dist_safe

    # Inward radial component (spiral)
    radial_strength = 0.3  # 30% inward pull
    rad_lat = -dlat / dist_safe
    rad_lon = -dlon_scaled / dist_safe

    # Combine tangential and radial
    u = speed * (tang_lon + radial_strength * rad_lon)  # East-west
    v = speed * (tang_lat + radial_strength * rad_lat)  # North-south

    return u.astype(np.float32), v.astype(np.float32)


def main():
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Generating wind fixtures in {FIXTURES_DIR}/\n")

    print("  Generating O1280 Gaussian grid coordinates...")
    lats, lons = generate_gaussian_grid()
    print(f"    Generated {len(lats):,} points")

    print("  Generating cyclonic wind pattern at 0,0...")
    u, v = generate_cyclone(lats, lons)

    # Stats
    print(f"    U range: {u.min():.1f} to {u.max():.1f} m/s")
    print(f"    V range: {v.min():.1f} to {v.max():.1f} m/s")

    # Write files
    u_path = FIXTURES_DIR / "wind-cyclone-u.bin"
    v_path = FIXTURES_DIR / "wind-cyclone-v.bin"

    with open(u_path, 'wb') as f:
        f.write(u.tobytes())
    print(f"    wind-cyclone-u.bin: {u.nbytes / 1024 / 1024:.1f} MB")

    with open(v_path, 'wb') as f:
        f.write(v.tobytes())
    print(f"    wind-cyclone-v.bin: {v.nbytes / 1024 / 1024:.1f} MB")

    print("\nDone!")


if __name__ == "__main__":
    main()
