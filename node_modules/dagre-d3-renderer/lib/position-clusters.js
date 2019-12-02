import d3 from 'd3'
import util from './util'

function positionClusters (selection, g) {
  const created = selection.filter(function () { return !d3.select(this).classed('update') })

  function translate (v) {
    const node = g.node(v)
    return 'translate(' + node.x + ',' + node.y + ')'
  }

  created.attr('transform', translate)

  util.applyTransition(selection, g)
      .style('opacity', 1)
      .attr('transform', translate)

  util.applyTransition(created.selectAll('rect'), g)
      .attr('width', function (v) { return g.node(v).width })
      .attr('height', function (v) { return g.node(v).height })
      .attr('x', function (v) {
        const node = g.node(v)
        return -node.width / 2
      })
      .attr('y', function (v) {
        const node = g.node(v)
        return -node.height / 2
      })
}

export default positionClusters
