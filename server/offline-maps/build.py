#!/usr/bin/env python3
"""Build reusable city packages from an official Geofabrik extract."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import osmium

ROOT = Path(__file__).resolve().parents[2]
PROFILE = ROOT / "server/offline-maps"
BOOTSTRAP = [
    dict(name="Павлоград", aliases=["Pavlohrad", "Pavlograd"], local="Павлоград", lat=48.533, lon=35.870,
         region="Дніпропетровська область", country="Україна", countryCode="UA"),
    dict(name="Дніпро", aliases=["Днепр", "Dnipro", "Dnepr"], local="Дніпро", lat=48.466, lon=35.047,
         region="Дніпропетровська область", country="Україна", countryCode="UA"),
]


def bounds(lat, lon, radius):
    dy = radius / 111.2
    dx = dy / max(0.12, math.cos(math.radians(lat)))
    return [lon - dx, lat - dy, lon + dx, lat + dy]


def run(*args, **kwargs):
    subprocess.run([str(a) for a in args], check=True, **kwargs)


def pack(directory, place, radius, date):
    path = directory / "manifest.json"
    manifest = json.loads(path.read_text())
    chunks = []
    payload = bytearray()
    for asset in manifest["assets"]:
        file = directory / asset["path"]
        data = file.read_bytes()
        if payload and len(payload) + len(data) > 4_000_000:
            write_chunk(directory, chunks, payload)
            payload.clear()
        asset.update(chunk=len(chunks), offset=len(payload), sha256=hashlib.sha256(data).hexdigest())
        payload.extend(data)
        file.unlink()
    if payload:
        write_chunk(directory, chunks, payload)
    manifest.update(chunks=chunks, settlementId=place["id"], center={"lat": place["lat"], "lon": place["lon"]},
                    radiusKm=radius, dataDate=date)
    path.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")))


def write_chunk(directory, chunks, payload):
    name = f"data-{len(chunks)}.bin"
    (directory / name).write_bytes(payload)
    chunks.append({"path": name, "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()})


def identify(candidates, source, work):
    bbox = [min(p["lon"] for p in candidates) - .4, min(p["lat"] for p in candidates) - .4,
            max(p["lon"] for p in candidates) + .4, max(p["lat"] for p in candidates) + .4]
    nearby = work / "identities.osm.pbf"
    run("osmium", "extract", "-b", ",".join(map(str, bbox)), "-o", nearby, source)
    found = []
    for place in candidates:
        choices = []
        for node in osmium.FileProcessor(str(nearby), osmium.osm.NODE):
            if node.tags.get("place") in {"city", "town", "village", "hamlet"} and place["local"] in (
                node.tags.get("name"), node.tags.get("name:uk"), node.tags.get("name:en")
            ) and node.location.valid():
                distance = math.hypot(node.location.lat - place["lat"], node.location.lon - place["lon"])
                if distance < .1:
                    choices.append((distance, node.id, node.location.lat, node.location.lon))
        if not choices:
            raise ValueError(f"Missing matching OSM settlement node: {place['name']}")
        _, node, lat, lon = min(choices)
        found.append(dict(place, id=f"osm-N-{node}", lat=lat, lon=lon))
    return found


def build(place, radius, source, out, work, glyphs, date):
    local = work / f'{place["id"]}-{radius}'
    local.mkdir()
    area = bounds(place["lat"], place["lon"], radius)
    extent = bounds(place["lat"], place["lon"], radius + 4)
    cut = local / "region.osm.pbf"
    run("osmium", "extract", "-b", ",".join(map(str, extent)), "-s", "smart", "-o", cut, source)
    mount = ["docker", "run", "--rm", "-u", f"{os.getuid()}:{os.getgid()}", "-v", f"{local}:/data"]
    run(*mount, "--entrypoint", "sh", "ghcr.io/valhalla/valhalla-scripted:3.9.0", "-c",
        'valhalla_build_config --mjolnir-tile-dir /data/graph --mjolnir-tile-extract "" '
        '--mjolnir-traffic-extract "" --mjolnir-admin "" --mjolnir-timezone "" '
        '--additional-data-elevation "" >/data/valhalla.json && '
        'valhalla_build_tiles -c /data/valhalla.json /data/region.osm.pbf')
    run(*mount, "-v", f"{PROFILE}:/profile:ro", os.environ.get("TILEMAKER_IMAGE", "ghcr.io/systemed/tilemaker:master"),
        "/data/region.osm.pbf", "--output", "/data/region.mbtiles", "--config", "/profile/config.json", "--process", "/profile/process.lua")
    directory = out / "regions" / place["id"] / str(radius)
    run(sys.executable, ROOT / "scripts/prepare-offline-region.py", "--osm", cut,
        "--graph", local / "graph", "--mbtiles", local / "region.mbtiles", "--style", PROFILE / "style.json",
        "--glyphs", glyphs, "--bounds", *area, "--out", directory)
    pack(directory, place, radius, date)
    place["packages"][str(radius)] = (directory / "manifest.json").relative_to(out).as_posix()
    import shutil
    shutil.rmtree(local)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--glyphs", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--date", required=True)
    parser.add_argument("--settlements", type=Path, help="JSON input with canonical search names and approximate centres")
    parser.add_argument("--radii", type=int, nargs="+", choices=(10, 25, 50, 100), default=[25])
    args = parser.parse_args()
    places = json.loads(args.settlements.read_text()) if args.settlements else BOOTSTRAP
    args.out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=args.out.parent) as tmp:
        work = Path(tmp).resolve()
        found = identify(places, args.source.resolve(), work)
        for place in found:
            place["address"] = f'{place["region"]} · {place["country"]}'
            place["packages"] = {}
            for radius in args.radii:
                build(place, radius, args.source.resolve(), args.out, work, args.glyphs.resolve(), args.date)
        (args.out / "catalog.json").write_text(json.dumps({"settlements": found}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
