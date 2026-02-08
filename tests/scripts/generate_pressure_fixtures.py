#!/usr/bin/env python3
"""
Generate pressure fixture files for e2e testing.

Creates Float32Array binary file with pressure pattern:
- Low pressure (~990 hPa) at 10°N, 10°E
- High pressure (~1030 hPa) at 10°S, 10°W
- Smooth gradient between them, base at 1013 hPa

Usage:
  python generate_pressure_fixtures.py

Output: ../fixtures/pressure-low-high.bin
"""

import numpy as np
from pathlib import Path

# O1280 Gaussian grid parameters
N = 1280
NUM_RINGS = 2 * N  # 2560
O1280_POINTS = 6_599_680

# Output directory
FIXTURES_DIR = Path(__file__).parent.parent / "fixtures"

# Pressure centers
LOW_LAT, LOW_LON = 10.0, 10.0      # 10°N, 10°E
HIGH_LAT, HIGH_LON = -10.0, -10.0  # 10°S, 10°W

# Pressure values in PASCALS (shader expects Pa, not hPa)
# Shader range: 976-1048 hPa (97600-104800 Pa)
BASE_PRESSURE = 101200.0   # 1012 hPa (reference)
LOW_PRESSURE = 97600.0     # 976 hPa (shader min)
HIGH_PRESSURE = 104800.0   # 1048 hPa (shader max)
INFLUENCE_RADIUS = 0.5  # radians (~30°)
NOISE_AMPLITUDE = 100.0  # Pa (~1 hPa noise for Chaikin effect)


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


def generate_pressure(lats, lons):
    """
    Generate pressure field with low and high centers, mirrored on opposite side.

    Args:
        lats, lons: Grid coordinates in radians

    Returns:
        pressure: Pressure values in Pa
    """
    # Convert center positions to radians
    low_lat_rad = np.radians(LOW_LAT)
    low_lon_rad = np.radians(LOW_LON)
    high_lat_rad = np.radians(HIGH_LAT)
    high_lon_rad = np.radians(HIGH_LON)

    # Mirror positions (opposite side of earth)
    low_lat_rad_mirror = -low_lat_rad
    low_lon_rad_mirror = low_lon_rad + np.pi
    high_lat_rad_mirror = -high_lat_rad
    high_lon_rad_mirror = high_lon_rad + np.pi

    # Calculate distances from centers
    def angular_distance(lat1, lon1, lat2, lon2):
        """Great circle angular distance."""
        dlat = lat1 - lat2
        dlon = lon1 - lon2
        # Wrap longitude
        dlon = np.where(dlon > np.pi, dlon - 2*np.pi, dlon)
        dlon = np.where(dlon < -np.pi, dlon + 2*np.pi, dlon)
        dlon_scaled = dlon * np.cos(lat1)
        return np.sqrt(dlat**2 + dlon_scaled**2)

    # Front side
    dist_to_low = angular_distance(lats, lons, low_lat_rad, low_lon_rad)
    dist_to_high = angular_distance(lats, lons, high_lat_rad, high_lon_rad)

    # Back side (mirrored)
    dist_to_low_mirror = angular_distance(lats, lons, low_lat_rad_mirror, low_lon_rad_mirror)
    dist_to_high_mirror = angular_distance(lats, lons, high_lat_rad_mirror, high_lon_rad_mirror)

    # Gaussian influence (smooth falloff)
    sigma = INFLUENCE_RADIUS / 2
    low_influence = np.exp(-0.5 * (dist_to_low / sigma)**2)
    high_influence = np.exp(-0.5 * (dist_to_high / sigma)**2)
    low_influence_mirror = np.exp(-0.5 * (dist_to_low_mirror / sigma)**2)
    high_influence_mirror = np.exp(-0.5 * (dist_to_high_mirror / sigma)**2)

    # Pressure anomaly from each center (front + back)
    low_anomaly = (LOW_PRESSURE - BASE_PRESSURE) * (low_influence + low_influence_mirror)
    high_anomaly = (HIGH_PRESSURE - BASE_PRESSURE) * (high_influence + high_influence_mirror)

    # Combine: base + anomalies
    pressure = BASE_PRESSURE + low_anomaly + high_anomaly

    # Add noise for Chaikin effect visibility
    np.random.seed(42)  # Deterministic noise
    noise = np.random.uniform(-NOISE_AMPLITUDE, NOISE_AMPLITUDE, len(pressure))
    pressure += noise

    # Clamp to shader range
    pressure = np.clip(pressure, 97600, 104800)

    return pressure.astype(np.float32)


def main():
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Generating pressure fixtures in {FIXTURES_DIR}/\n")

    print("  Generating O1280 Gaussian grid coordinates...")
    lats, lons = generate_gaussian_grid()
    print(f"    Generated {len(lats):,} points")

    print(f"  Generating pressure field...")
    print(f"    Low: {LOW_PRESSURE/100:.0f} hPa at {LOW_LAT}°N, {LOW_LON}°E")
    print(f"    High: {HIGH_PRESSURE/100:.0f} hPa at {-HIGH_LAT}°S, {-HIGH_LON}°W")
    pressure = generate_pressure(lats, lons)

    # Stats
    print(f"    Pressure range: {pressure.min()/100:.1f} to {pressure.max()/100:.1f} hPa ({pressure.min():.0f} to {pressure.max():.0f} Pa)")

    # Write file
    out_path = FIXTURES_DIR / "pressure-low-high.bin"
    with open(out_path, 'wb') as f:
        f.write(pressure.tobytes())
    print(f"    pressure-low-high.bin: {pressure.nbytes / 1024 / 1024:.1f} MB")

    print("\nDone!")


if __name__ == "__main__":
    main()
