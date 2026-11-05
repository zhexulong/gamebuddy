/**
 * Geometry for a task purpose that is a SHAPE rather than a list of actions.
 *
 * Every other criterion in `task-purpose.mjs` asks which actions reached their own postcondition. The long-patch
 * criterion asks something else: whether the tiles a run proved form one declared rectangle. That is arithmetic over
 * a set of coordinates and nothing else, so it lives here where it can be decided without a game, a receipt or a run,
 * and the criterion above only has to say which tiles it proved and which rectangle it asked for.
 *
 * A tile is `{ x, y }`: an integer column and row on ONE map. Grouping by map is the caller's job, and this module
 * never sees two maps at once - Stardew's coordinates restart at (0, 0) in every location, so a strip assembled out
 * of two of them would be a rectangle that exists nowhere.
 */

/** The distinct tiles of `tiles`, so a log that names the same tile twice counts it once. */
function distinct(tiles) {
  const seen = new Map();
  for (const tile of tiles ?? []) {
    if (!Number.isInteger(tile?.x) || !Number.isInteger(tile?.y)) continue;
    const id = `${String(tile.x)},${String(tile.y)}`;
    if (!seen.has(id)) seen.set(id, Object.freeze({ x: tile.x, y: tile.y }));
  }
  return [...seen.values()];
}

/**
 * The tile-aligned window of the declared shape holding the most of `tiles`, or null when there are none.
 *
 * A window covers exactly `width` columns and `height` rows and starts on a whole tile. Every window worth counting
 * has one of these tiles against its left or right edge and one against its top or bottom edge, so the search is over
 * the anchors those tiles imply instead of over the whole map - a 1000-wide farm costs what its tiles cost.
 */
export function bestWindow(tiles, { width, height }) {
  const points = distinct(tiles);
  if (points.length === 0) return null;
  const present = new Set(points.map((tile) => `${String(tile.x)},${String(tile.y)}`));
  const anchorsX = [...new Set(points.flatMap((tile) => [tile.x, tile.x - (width - 1)]))];
  const anchorsY = [...new Set(points.flatMap((tile) => [tile.y, tile.y - (height - 1)]))];
  let best = null;
  for (const x of anchorsX) {
    for (const y of anchorsY) {
      let count = 0;
      for (let column = x; column < x + width; column += 1) {
        for (let row = y; row < y + height; row += 1) {
          if (present.has(`${String(column)},${String(row)}`)) count += 1;
        }
      }
      // A tie goes to the window nearest the origin, so the same receipt log always reports the same rectangle.
      if (
        best === null ||
        count > best.count ||
        (count === best.count && (x < best.x || (x === best.x && y < best.y)))
      ) {
        best = Object.freeze({ x, y, width, height, count });
      }
    }
  }
  return best;
}

/**
 * Whether ONE window of the declared shape can hold every tile.
 *
 * This is the difference between "she worked a strip and has not finished it" and "she worked something that is not
 * a strip": a set of tiles that fits inside one window is a patch in progress wherever the window sits, and a set
 * that does not fit inside any window is a different shape however many tiles it holds.
 */
export function windowHoldsAll(tiles, { width, height }) {
  const points = distinct(tiles);
  if (points.length === 0) return true;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  return maxX - minX < width && maxY - minY < height;
}

/**
 * The largest all-filled axis-aligned rectangle inside `tiles`, or null when there are none.
 *
 * The reported width is the rectangle's extent along x and its height along y, both of whole filled tiles - the
 * largest rectangle that is actually there, not the largest one the tiles' bounding box suggests. Rows are read as
 * histograms and each row's largest rectangle comes off a stack, which is the one pass that answers this for a shape
 * as well as for a full grid.
 */
export function largestFilledRectangle(tiles) {
  const points = distinct(tiles);
  if (points.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  const columns = maxX - minX + 1;
  const rows = maxY - minY + 1;
  const filled = new Uint8Array(columns * rows);
  for (const point of points) filled[(point.y - minY) * columns + (point.x - minX)] = 1;
  const heights = new Uint16Array(columns);
  let best = null;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      heights[column] = filled[row * columns + column] === 1 ? heights[column] + 1 : 0;
    }
    const stack = [];
    for (let column = 0; column <= columns; column += 1) {
      const height = column === columns ? 0 : heights[column];
      while (stack.length > 0 && heights[stack[stack.length - 1]] >= height) {
        const popped = stack.pop();
        const rectangleHeight = heights[popped];
        const left = stack.length === 0 ? 0 : stack[stack.length - 1] + 1;
        const width = column - left;
        const area = width * rectangleHeight;
        // A tie keeps the first rectangle found, which is the topmost then leftmost of that size.
        if (best === null || area > best.area) {
          best = Object.freeze({
            x: minX + left,
            y: minY + row - rectangleHeight + 1,
            width,
            height: rectangleHeight,
            area,
          });
        }
      }
      if (column < columns) stack.push(column);
    }
  }
  return best;
}
