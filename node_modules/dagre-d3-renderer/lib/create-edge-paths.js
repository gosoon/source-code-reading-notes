import d3 from 'd3'
import _ from 'lodash'

import intersectNode from './intersect/intersect-node'
import util from './util'

function createEdgePaths (selection, g, arrows) {
  const svgPaths = selection.selectAll('g.edgePath')
    .data(g.edges(), function (e) { return util.edgeToId(e) })
    .classed('update', true)

  enter(svgPaths, g)
  exit(svgPaths, g)

  util.applyTransition(svgPaths, g)
    .style('opacity', 1)

  // Save DOM element in the path group, and set ID and class
  svgPaths.each(function (e) {
    const domEdge = d3.select(this)
    const edge = g.edge(e)
    edge.elem = this

    if (edge.id) {
      domEdge.attr('id', edge.id)
    }

    util.applyClass(domEdge, edge['class'],
      (domEdge.classed('update') ? 'update ' : '') + 'edgePath')
  })

  svgPaths.selectAll('path.path')
    .each(function (e) {
      const edge = g.edge(e)
      edge.arrowheadId = _.uniqueId('arrowhead')

      const domEdge = d3.select(this)
        .attr('marker-end', function () {
          return 'url(#' + edge.arrowheadId + ')'
        })
        .style('fill', 'none')

      util.applyTransition(domEdge, g)
        .attr('d', function (e) { return calcPoints(g, e) })

      util.applyStyle(domEdge, edge.style)
    })

  svgPaths.selectAll('defs *').remove()
  svgPaths.selectAll('defs')
    .each(function (e) {
      const edge = g.edge(e)
      const arrowhead = arrows[edge.arrowhead]
      arrowhead(d3.select(this), edge.arrowheadId, edge, 'arrowhead')
    })

  return svgPaths
}

function calcPoints (g, e) {
  const edge = g.edge(e)
  const tail = g.node(e.v)
  const head = g.node(e.w)
  const points = edge.points.slice(1, edge.points.length - 1)
  points.unshift(intersectNode(tail, points[0]))
  points.push(intersectNode(head, points[points.length - 1]))

  return createLine(edge, points)
}

function createLine (edge, points) {
  const line = d3.svg.line()
    .x(function (d) { return d.x })
    .y(function (d) { return d.y })

  if (_.has(edge, 'lineInterpolate')) {
    line.interpolate(edge.lineInterpolate)
  }

  if (_.has(edge, 'lineTension')) {
    line.tension(Number(edge.lineTension))
  }

  return line(points)
}

function getCoords (elem) {
  const bbox = elem.getBBox()
  const matrix = elem.ownerSVGElement.getScreenCTM()
    .inverse()
    .multiply(elem.getScreenCTM())
    .translate(bbox.width / 2, bbox.height / 2)
  return { x: matrix.e, y: matrix.f }
}

function enter (svgPaths, g) {
  const svgPathsEnter = svgPaths.enter()
    .append('g')
      .attr('class', 'edgePath')
      .style('opacity', 0)
  svgPathsEnter.append('path')
    .attr('class', 'path')
    .attr('d', function (e) {
      const edge = g.edge(e)
      const sourceElem = g.node(e.v).elem
      const points = _.range(edge.points.length).map(function () { return getCoords(sourceElem) })
      return createLine(edge, points)
    })
  svgPathsEnter.append('defs')
}

function exit (svgPaths, g) {
  const svgPathExit = svgPaths.exit()
  util.applyTransition(svgPathExit, g)
    .style('opacity', 0)
    .remove()

  util.applyTransition(svgPathExit.select('path.path'), g)
    .attr('d', function (e) {
      const source = g.node(e.v)

      if (source) {
        const points = _.range(this.getTotalLength()).map(function () { return source })
        return createLine({}, points)
      } else {
        return d3.select(this).attr('d')
      }
    })
}

export default createEdgePaths
