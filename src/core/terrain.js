// Model terenu: wysokości z DEM w metrach, próbkowanie dwuliniowe, nachylenie.
// Układ współrzędnych: x na wschód, y na południe, (0,0) = lewy górny róg obszaru.
export class Terrain {
  constructor({ heights, width, height, cellM }) {
    this.h = heights;
    this.w = width;
    this.hgt = height;
    this.cell = cellM;
    this.widthM = width * cellM;
    this.heightM = height * cellM;
    let min = Infinity, max = -Infinity;
    for (const v of heights) { if (v < min) min = v; if (v > max) max = v; }
    this.minH = min;
    this.maxH = max;
    this.slopeGrid = this.#computeSlope();
  }

  at(i, j) {
    i = i < 0 ? 0 : i >= this.w ? this.w - 1 : i;
    j = j < 0 ? 0 : j >= this.hgt ? this.hgt - 1 : j;
    return this.h[j * this.w + i];
  }

  /** Wysokość w punkcie (m), względem najniższego punktu obszaru. */
  height(x, y) {
    const fx = x / this.cell - 0.5, fy = y / this.cell - 0.5;
    const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
    const v = this.at(i, j) * (1 - tx) * (1 - ty) + this.at(i + 1, j) * tx * (1 - ty)
      + this.at(i, j + 1) * (1 - tx) * ty + this.at(i + 1, j + 1) * tx * ty;
    return v - this.minH;
  }

  /** Nachylenie w stopniach (z siatki, najbliższa komórka). */
  slope(x, y) {
    const i = Math.min(this.w - 1, Math.max(0, Math.floor(x / this.cell)));
    const j = Math.min(this.hgt - 1, Math.max(0, Math.floor(y / this.cell)));
    return this.slopeGrid[j * this.w + i];
  }

  inside(x, y, margin = 0) {
    return x >= margin && y >= margin && x <= this.widthM - margin && y <= this.heightM - margin;
  }

  #computeSlope() {
    const s = new Float32Array(this.w * this.hgt), c = this.cell;
    for (let j = 0; j < this.hgt; j++) for (let i = 0; i < this.w; i++) {
      const dx = (this.at(i + 1, j) - this.at(i - 1, j)) / (2 * c);
      const dy = (this.at(i, j + 1) - this.at(i, j - 1)) / (2 * c);
      s[j * this.w + i] = Math.atan(Math.hypot(dx, dy)) * 180 / Math.PI;
    }
    return s;
  }
}

/** Raster o wartościach 0–255 (klasy lub wartości znormalizowane) w układzie obszaru. */
export class Raster {
  constructor({ data, width, height, cellM }) {
    Object.assign(this, { data, width, height, cellM });
  }
  sample(x, y) {
    const i = Math.min(this.width - 1, Math.max(0, Math.floor(x / this.cellM)));
    const j = Math.min(this.height - 1, Math.max(0, Math.floor(y / this.cellM)));
    return this.data[j * this.width + i];
  }
}
