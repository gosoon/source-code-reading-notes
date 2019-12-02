function intersectEllipse (node, rx, ry, point) {
  // Formulae from: http://mathworld.wolfram.com/Ellipse-LineIntersection.html

  const cx = node.x
  const cy = node.y

  const px = cx - point.x
  const py = cy - point.y

  const det = Math.sqrt(rx * rx * py * py + ry * ry * px * px)

  let dx = Math.abs(rx * ry * px / det)
  if (point.x < cx) {
    dx = -dx
  }
  let dy = Math.abs(rx * ry * py / det)
  if (point.y < cy) {
    dy = -dy
  }

  return {x: cx + dx, y: cy + dy}
}

export default intersectEllipse
