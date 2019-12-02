import d3 from 'd3'
import _ from 'lodash'

import util from './util'

function positionEdgeLabels (selection, g) {
  const created = selection.filter(function () { return !d3.select(this).classed('update') })

  function translate (e) {
    const edge = g.edge(e)
    return _.has(edge, 'x') ? 'translate(' + edge.x + ',' + edge.y + ')' : ''
  }

  created.attr('transform', translate)

  util.applyTransition(selection, g)
    .style('opacity', 1)
    .attr('transform', translate)
}

export default positionEdgeLabels
