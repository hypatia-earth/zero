#!/usr/bin/env python3
"""
Test DiscoveryService algorithm for Open-Meteo S3 bucket.

Queries runs for a model, builds timestep list, verifies with HEAD requests.
"""

import urllib.request
import urllib.error
from datetime import datetime, timedelta
from xml.etree import ElementTree as ET
import sys

BASE_URL = "https://openmeteo.s3.amazonaws.com"

def list_s3_prefixes(prefix: str) -> list[str]:
    """List S3 prefixes (folders) at given path."""
    url = f"{BASE_URL}?list-type=2&prefix={prefix}&delimiter=/"
    with urllib.request.urlopen(url) as resp:
        content = resp.read()

    root = ET.fromstring(content)
    ns = {'s3': 'http://s3.amazonaws.com/doc/2006-03-01/'}

    prefixes = []
    for cp in root.findall('.//s3:CommonPrefixes/s3:Prefix', ns):
        prefixes.append(cp.text)
    return sorted(prefixes)


def discover_runs(model: str) -> list[dict]:
    """Discover all available runs for a model."""
    prefix = f"data_spatial/{model}/"

    # Get years
    years = list_s3_prefixes(prefix)

    runs = []
    for year_prefix in years:
        if not year_prefix.rstrip('/').split('/')[-1].isdigit():
            continue  # skip latest.json etc

        # Get months
        months = list_s3_prefixes(year_prefix)
        for month_prefix in months:
            # Get days
            days = list_s3_prefixes(month_prefix)
            for day_prefix in days:
                # Get runs (0000Z, 0600Z, etc)
                run_prefixes = list_s3_prefixes(day_prefix)
                for run_prefix in run_prefixes:
                    # Parse run info
                    parts = run_prefix.rstrip('/').split('/')
                    year, month, day, run_time = parts[-4], parts[-3], parts[-2], parts[-1]

                    run_dt = datetime.strptime(f"{year}-{month}-{day}T{run_time[:2]}:00:00", "%Y-%m-%dT%H:%M:%S")

                    runs.append({
                        'prefix': run_prefix,
                        'datetime': run_dt,
                        'run': run_time,
                    })

    return sorted(runs, key=lambda r: r['datetime'])


def list_run_files(run_prefix: str) -> list[str]:
    """List all .om files in a run folder."""
    url = f"{BASE_URL}?list-type=2&prefix={run_prefix}"
    with urllib.request.urlopen(url) as resp:
        content = resp.read()

    root = ET.fromstring(content)
    ns = {'s3': 'http://s3.amazonaws.com/doc/2006-03-01/'}

    files = []
    for key in root.findall('.//s3:Contents/s3:Key', ns):
        if key.text.endswith('.om'):
            files.append(key.text)
    return sorted(files)


def parse_timestep_from_filename(filename: str) -> datetime:
    """Parse timestep datetime from filename like 2025-12-13T0600.om"""
    basename = filename.split('/')[-1].replace('.om', '')
    return datetime.strptime(basename, "%Y-%m-%dT%H%M")


def generate_timesteps_ecmwf_ifs(runs: list[dict]) -> list[dict]:
    """
    Generate timesteps for ecmwf_ifs model.

    Algorithm:
    - Last run: add all available timesteps (fetched from S3)
    - Each previous run: add first 6 timesteps (fills 6h gap)
    """
    if not runs:
        return []

    timesteps = []
    seen = set()

    # Process runs from last to first
    for i, run in enumerate(reversed(runs)):
        run_dt = run['datetime']
        run_prefix = run['prefix']

        if i == 0:
            # Last run: fetch and add all available timesteps
            print(f"  [Last run] Fetching files from {run_prefix}...")
            files = list_run_files(run_prefix)
            print(f"  [Last run] Found {len(files)} files")

            for f in files:
                ts_dt = parse_timestep_from_filename(f)
                ts_str = ts_dt.strftime("%Y-%m-%dT%H%M")
                if ts_str not in seen:
                    timesteps.append({
                        'timestep': ts_str,
                        'datetime': ts_dt,
                        'run': run['run'],
                        'run_datetime': run_dt,
                        'url': f"{BASE_URL}/{f}"
                    })
                    seen.add(ts_str)
        else:
            # Previous runs: add first 6 timesteps only
            for h in range(6):
                ts_dt = run_dt + timedelta(hours=h)
                ts_str = ts_dt.strftime("%Y-%m-%dT%H%M")
                if ts_str not in seen:
                    timesteps.append({
                        'timestep': ts_str,
                        'datetime': ts_dt,
                        'run': run['run'],
                        'run_datetime': run_dt,
                        'url': f"{BASE_URL}/{run_prefix}{ts_dt.strftime('%Y-%m-%d')}T{ts_dt.strftime('%H%M')}.om"
                    })
                    seen.add(ts_str)

    return sorted(timesteps, key=lambda t: t['datetime'])


def generate_timesteps_ecmwf_ifs025(runs: list[dict]) -> list[dict]:
    """
    Generate timesteps for ecmwf_ifs025 model.

    Algorithm:
    - Last run: add all available timesteps (fetched from S3)
    - Each previous run: add first 2 timesteps (fills 6h gap)
    """
    if not runs:
        return []

    timesteps = []
    seen = set()

    # Process runs from last to first
    for i, run in enumerate(reversed(runs)):
        run_dt = run['datetime']
        run_prefix = run['prefix']

        if i == 0:
            # Last run: fetch and add all available timesteps
            print(f"  [Last run] Fetching files from {run_prefix}...")
            files = list_run_files(run_prefix)
            print(f"  [Last run] Found {len(files)} files")

            for f in files:
                ts_dt = parse_timestep_from_filename(f)
                ts_str = ts_dt.strftime("%Y-%m-%dT%H%M")
                if ts_str not in seen:
                    timesteps.append({
                        'timestep': ts_str,
                        'datetime': ts_dt,
                        'run': run['run'],
                        'run_datetime': run_dt,
                        'url': f"{BASE_URL}/{f}"
                    })
                    seen.add(ts_str)
        else:
            # Previous runs: add first 2 timesteps only (0h and 3h)
            for h in [0, 3]:
                ts_dt = run_dt + timedelta(hours=h)
                ts_str = ts_dt.strftime("%Y-%m-%dT%H%M")
                if ts_str not in seen:
                    timesteps.append({
                        'timestep': ts_str,
                        'datetime': ts_dt,
                        'run': run['run'],
                        'run_datetime': run_dt,
                        'url': f"{BASE_URL}/{run_prefix}{ts_dt.strftime('%Y-%m-%d')}T{ts_dt.strftime('%H%M')}.om"
                    })
                    seen.add(ts_str)

    return sorted(timesteps, key=lambda t: t['datetime'])


def verify_timesteps(timesteps: list[dict], sample_count: int = 10) -> None:
    """Verify timesteps with HEAD requests."""
    print(f"\n[Verify] Checking {sample_count} timesteps with HEAD requests...")

    # Sample: first, last, and evenly distributed
    indices = [0, len(timesteps) - 1]
    step = len(timesteps) // (sample_count - 2) if sample_count > 2 else 1
    indices.extend(range(step, len(timesteps) - 1, step))
    indices = sorted(set(indices))[:sample_count]

    for idx in indices:
        ts = timesteps[idx]
        req = urllib.request.Request(ts['url'], method='HEAD')
        try:
            with urllib.request.urlopen(req) as resp:
                status = "OK" if resp.status == 200 else f"FAIL ({resp.status})"
        except urllib.error.HTTPError as e:
            status = f"FAIL ({e.code})"
        print(f"  [{idx:3d}] {ts['timestep']} (run {ts['run']}) -> {status}")


def main():
    model = sys.argv[1] if len(sys.argv) > 1 else 'ecmwf_ifs'
    verify = '--verify' in sys.argv

    print(f"[Discovery] Exploring model: {model}")
    print(f"[Discovery] Base URL: {BASE_URL}/data_spatial/{model}/")

    # Discover runs
    print(f"\n[Discovery] Listing runs...")
    runs = discover_runs(model)
    print(f"[Discovery] Found {len(runs)} runs")

    if runs:
        print(f"[Discovery] First run: {runs[0]['datetime']} ({runs[0]['run']})")
        print(f"[Discovery] Last run:  {runs[-1]['datetime']} ({runs[-1]['run']})")

    # Generate timesteps
    print(f"\n[Discovery] Generating timesteps...")
    if model == 'ecmwf_ifs':
        timesteps = generate_timesteps_ecmwf_ifs(runs)
    elif model == 'ecmwf_ifs025':
        timesteps = generate_timesteps_ecmwf_ifs025(runs)
    else:
        print(f"[Error] Unknown model: {model}")
        sys.exit(1)

    print(f"[Discovery] Generated {len(timesteps)} timesteps")

    if timesteps:
        first = timesteps[0]
        last = timesteps[-1]
        print(f"\n[Discovery] {model}: {len(timesteps)} timesteps, {first['timestep']} -> {last['timestep']}")

    # Show sample
    print(f"\n[Sample] First 5 timesteps:")
    for ts in timesteps[:5]:
        print(f"  {ts['timestep']} (run {ts['run']}) -> {ts['url'].split('/')[-1]}")

    print(f"\n[Sample] Last 5 timesteps:")
    for ts in timesteps[-5:]:
        print(f"  {ts['timestep']} (run {ts['run']}) -> {ts['url'].split('/')[-1]}")

    # Verify with HEAD requests
    if verify:
        verify_timesteps(timesteps, sample_count=10)


if __name__ == '__main__':
    main()
