import intersectRect from './intersect/intersect-rect'
import intersectEllipse from './intersect/intersect-ellipse'
import intersectCircle from './intersect/intersect-circle'
import intersectPolygon from './intersect/intersect-polygon'

function rect (parent, bbox, node) {
  const shapeSvg = parent.insert('rect', ':first-child')
        .attr('rx', node.rx)
        .attr('ry', node.ry)
        .attr('x', -bbox.width / 2)
        .attr('y', -bbox.height / 2)
        .attr('width', bbox.width)
        .attr('height', bbox.height)

  node.intersect = function (point) {
    return intersectRect(node, point)
  }

  return shapeSvg
}

function ellipse (parent, bbox, node) {
  const rx = bbox.width / 2
  const ry = bbox.height / 2
  const shapeSvg = parent.insert('ellipse', ':first-child')
        .attr('x', -bbox.width / 2)
        .attr('y', -bbox.height / 2)
        .attr('rx', rx)
        .attr('ry', ry)

  node.intersect = function (point) {
    return intersectEllipse(node, rx, ry, point)
  }

  return shapeSvg
}

function circle (parent, bbox, node) {
  const r = Math.max(bbox.width, bbox.height) / 2
  const shapeSvg = parent.insert('circle', ':first-child')
        .attr('x', -bbox.width / 2)
        .attr('y', -bbox.height / 2)
        .attr('r', r)

  node.intersect = function (point) {
    return intersectCircle(node, r, point)
  }

  return shapeSvg
}

// Circumscribe an ellipse for the bounding box with a diamond shape. I derived
// the function to calculate the diamond shape from:
// http://mathforum.org/kb/message.jspa?messageID=3750236
function diamond (parent, bbox, node) {
  const w = (bbox.width * Math.SQRT2) / 2
  const h = (bbox.height * Math.SQRT2) / 2
  const points = [
        { x: 0, y: -h },
        { x: -w, y: 0 },
        { x: 0, y: h },
        { x: w, y: 0 }
  ]
  const shapeSvg = parent.insert('polygon', ':first-child')
    .attr('points', points.map(function (p) { return p.x + ',' + p.y }).join(' '))

  node.intersect = function (p) {
    return intersectPolygon(node, points, p)
  }

  return shapeSvg
}

export default {
  rect,
  ellipse,
  circle,
  diamond
}
