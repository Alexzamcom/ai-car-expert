#!/usr/bin/env python3
"""Assemble a static Android navigation package from Valhalla, MBTiles and OSM."""
import argparse
import gzip
import json
import pathlib
import shutil
import sqlite3
import tempfile

import osmium


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def extract_addresses(pbf, bounds):
    west, south, east, north = bounds
    for obj in osmium.FileProcessor(str(pbf)).with_locations():
        tags = obj.tags
        street = tags.get("addr:street") or tags.get("addr:place")
        number = tags.get("addr:housenumber")
        locality = tags.get("addr:city") or tags.get("addr:village") or tags.get("addr:town")
        settlement = tags.get("place") in ("city", "town", "village", "hamlet")
        name = f"{street} {number}" if street and number else tags.get("name")
        if not name or not (street and number or settlement or tags.get("highway") and tags.get("name")):
            continue
        if obj.is_node():
            location = obj.location
        elif obj.is_way() and len(obj.nodes):
            location = obj.nodes[len(obj.nodes) // 2].location
        else:
            continue
        if not location.valid() or not (west <= location.lon <= east and south <= location.lat <= north):
            continue
        yield {"id": f"osm:{obj.type_str()}:{obj.id}", "name": name, "address": locality or "",
               "lat": location.lat, "lon": location.lon,
               "aliases": sorted({tags[key] for key in ("name:uk", "name:ru", "alt_name", "official_name") if key in tags})}


def assemble(args, output):
    for tile in sorted(args.graph.glob("[0-2]/*/*/*.gph")):
        write(output / "graph" / tile.relative_to(args.graph), tile.read_bytes())
    with sqlite3.connect(f"{args.mbtiles.resolve().as_uri()}?mode=ro", uri=True) as database:
        for zoom, x, y, tile in database.execute("SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles"):
            xyz_y = (1 << zoom) - 1 - y
            write(output / "t" / str(zoom) / str(x) / str(xyz_y), gzip.decompress(tile) if tile.startswith(b"\x1f\x8b") else tile)
    for glyph in sorted(args.glyphs.glob("*.pbf")):
        write(output / "g" / glyph.stem, glyph.read_bytes())
    addresses = list(extract_addresses(args.osm, args.bounds))
    if not addresses:
        raise ValueError("No address or street entries in the selected bounds")
    write(output / "addresses.json", json.dumps(addresses, ensure_ascii=False, separators=(",", ":")).encode())
    assets = [{"path": path.relative_to(output).as_posix(), "bytes": path.stat().st_size}
              for path in sorted(output.rglob("*")) if path.is_file()]
    graph = [asset for asset in assets if asset["path"].startswith("graph/")]
    if not graph or not any(asset["path"].startswith("t/") for asset in assets):
        raise ValueError("Both Valhalla graph tiles and vector tiles are required")
    if len(assets) > 75000 or sum(asset["bytes"] for asset in graph) > 160_000_000 or (
        sum(asset["bytes"] for asset in assets) > 450_000_000 or any(not 0 < a["bytes"] <= 36_000_000 for a in assets)
    ):
        raise ValueError("Package is above the Android size budget")
    manifest = {"version": 1, "engine": "valhalla-3.9", "bounds": args.bounds,
                "style": json.loads(args.style.read_text()), "assets": assets}
    write(output / "manifest.json", json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ("graph", "mbtiles", "osm", "style", "glyphs", "out"):
        parser.add_argument(f"--{arg}", type=pathlib.Path, required=True)
    parser.add_argument("--bounds", type=float, nargs=4, metavar=("WEST", "SOUTH", "EAST", "NORTH"), required=True)
    args = parser.parse_args()
    if args.out.exists():
        parser.error("Output already exists. Use a new staging directory.")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=args.out.parent) as tmp:
        staging = pathlib.Path(tmp) / "package"
        assemble(args, staging)
        shutil.move(staging, args.out)


if __name__ == "__main__":
    main()
