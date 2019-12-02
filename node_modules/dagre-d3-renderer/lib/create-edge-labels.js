import d3 from 'd3'
import _ from 'lodash'

import addLabel from './label/add-label'
import util from './util'

function createEdgeLabels (selection, g) {
  const svgEdgeLabels = selection.selectAll('g.edgeLabel')
    .data(g.edges(), function (e) { return util.edgeToId(e) })
    .classed('update', true)

  svgEdgeLabels.selectAll('*').remove()
  svgEdgeLabels.enter()
    .append('g')
      .classed('edgeLabel', true)
      .style('opacity', 0)
  svgEdgeLabels.each(function (e) {
    const edge = g.edge(e)
    const label = addLabel(d3.select(this), g.edge(e), 0, 0).classed('label', true)
    const bbox = label.node().getBBox()

    if (edge.labelId) { label.attr('id', edge.labelId) }
    if (!_.has(edge, 'width')) { edge.width = bbox.width }
    if (!_.has(edge, 'height')) { edge.height = bbox.height }
  })

  util.applyTransition(svgEdgeLabels.exit(), g)
    .style('opacity', 0)
    .remove()

  return svgEdgeLabels
}

export default createEdgeLabels
