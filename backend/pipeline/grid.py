"""Wspólna siatka obszaru misji i wczytywanie produktów NASA do niej.

Siatka jest w układzie DTM HiRISE (projekcja równokątna na sferze Mars 2000, r = 3396,19 km).
Lokalny układ UI: x [m] na wschód od lewego górnego rogu, y [m] na południe.
Każdy produkt (DTM, ortoobraz, THEMIS, CTX — w różnych odwzorowaniach) trafia do tej siatki przez rasterio.warp.reproject.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import rasterio
from pyproj import CRS, Transformer
from rasterio.enums import Resampling
from rasterio.transform import Affine
from rasterio.warp import reproject


@dataclass
class Grid:
    crs: CRS
    x0: float          # współrzędna rzutu lewego górnego rogu
    y0: float
    width_m: float
    height_m: float
    res: float

    @property
    def shape(self) -> tuple[int, int]:
        return int(round(self.height_m / self.res)), int(round(self.width_m / self.res))

    @property
    def transform(self) -> Affine:
        return Affine(self.res, 0, self.x0, 0, -self.res, self.y0)

    def with_res(self, res: float) -> "Grid":
        return Grid(self.crs, self.x0, self.y0, self.width_m, self.height_m, res)

    def lonlat(self, x_local: float, y_local: float) -> tuple[float, float]:
        """Lokalne metry → (długość wschodnia, szerokość planetocentryczna) w stopniach."""
        t = Transformer.from_crs(self.crs, self.crs.geodetic_crs, always_xy=True)
        lon, lat = t.transform(self.x0 + x_local, self.y0 - y_local)
        return lon % 360.0, lat

    def corners_lonlat(self) -> dict:
        return {k: self.lonlat(x, y) for k, (x, y) in {
            "nw": (0, 0), "ne": (self.width_m, 0), "sw": (0, self.height_m), "se": (self.width_m, self.height_m)}.items()}


def grid_from_center(src_crs: CRS, center_lon: float, center_lat: float, width_m: float, height_m: float, res: float) -> Grid:
    t = Transformer.from_crs(src_crs.geodetic_crs, src_crs, always_xy=True)
    cx, cy = t.transform(center_lon, center_lat)
    return Grid(src_crs, cx - width_m / 2, cy + height_m / 2, width_m, height_m, res)


def read_into(grid: Grid, path: str, band: int = 1, resampling=Resampling.bilinear, nodata_out=np.nan) -> np.ndarray:
    """Czyta fragment produktu (lokalny plik lub /vsicurl/…) i przelicza go do siatki."""
    out = np.full(grid.shape, nodata_out, dtype=np.float32)
    with rasterio.Env(GDAL_HTTP_MAX_RETRY=5, GDAL_HTTP_RETRY_DELAY=2, CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".IMG,.img,.tif,.TIF,.JP2,.jp2",
                      GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
        with rasterio.open(path) as src:
            src_nodata = src.nodata
            reproject(
                source=rasterio.band(src, band), destination=out,
                src_transform=src.transform, src_crs=src.crs, src_nodata=src_nodata,
                dst_transform=grid.transform, dst_crs=grid.crs, dst_nodata=nodata_out,
                resampling=resampling,
            )
    if src_nodata is not None and src_nodata < -1e30:
        out[out < -1e30] = np.nan
    return out


def open_crs(path: str) -> CRS:
    with rasterio.open(path) as src:
        return CRS.from_wkt(src.crs.to_wkt())


def block_mean(a: np.ndarray, k: int) -> np.ndarray:
    """Średnia w blokach k×k (zmniejszenie rozdzielczości z pominięciem NaN)."""
    h, w = a.shape[0] // k * k, a.shape[1] // k * k
    b = a[:h, :w].reshape(h // k, k, w // k, k)
    return np.nanmean(b, axis=(1, 3))


def cache_remote_window(url: str, grid: Grid, dest: str, margin_m: float = 200.0, retries: int = 8) -> str:
    """Pobiera fragment zdalnego rastra (z zapasem) do lokalnego GeoTIFF; ponawia przy zerwanym połączeniu.
    Zwraca ścieżkę lokalną — dalsze przetwarzanie nie zależy od sieci."""
    import os
    import time as _t
    from rasterio.warp import transform_bounds
    from rasterio.windows import from_bounds
    if os.path.exists(dest):
        return dest
    last = None
    for attempt in range(retries):
        try:
            with rasterio.Env(GDAL_HTTP_MAX_RETRY=10, GDAL_HTTP_RETRY_DELAY=3, GDAL_HTTP_TIMEOUT=120,
                              GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
                with rasterio.open(url) as src:
                    b = (grid.x0 - margin_m, grid.y0 - grid.height_m - margin_m, grid.x0 + grid.width_m + margin_m, grid.y0 + margin_m)
                    sb = transform_bounds(grid.crs, src.crs, *b, densify_pts=21)
                    w = from_bounds(*sb, transform=src.transform).round_offsets().round_lengths()
                    data = src.read(1, window=w, boundless=True, fill_value=src.nodata if src.nodata is not None else 0)
                    prof = {"driver": "GTiff", "height": data.shape[0], "width": data.shape[1], "count": 1, "dtype": data.dtype,
                            "crs": src.crs, "transform": src.window_transform(w), "nodata": src.nodata, "compress": "deflate", "tiled": True}
            with rasterio.open(dest, "w", **prof) as dst:
                dst.write(data, 1)
            return dest
        except Exception as e:  # zerwane połączenie — spróbuj ponownie
            last = e
            _t.sleep(3 + attempt * 2)
    raise RuntimeError(f"Nie udało się pobrać fragmentu {url}: {last}")
