import d3 from 'd3'

import util from './util'
import addLabel from './label/add-label'

function createClusters (selection, g) {
  const clusters = g.nodes().filter(function (v) { return util.isSubgraph(g, v) })
  const svgClusters = selection.selectAll('g.cluster')
    .data(clusters, function (v) { return v })

  svgClusters.selectAll('*').remove()
  svgClusters.enter()
    .append('g')
      .attr('class', 'cluster')
      .attr('id', function (v) {
        const node = g.node(v)
        return node.id
      })
      .style('opacity', 0)

  util.applyTransition(svgClusters, g)
    .style('opacity', 1)

  svgClusters.each(function (v) {
    const node = g.node(v)
    const thisGroup = d3.select(this)
    d3.select(this).append('rect')
    const labelGroup = thisGroup.append('g').attr('class', 'label')
    addLabel(labelGroup, node, node.clusterLabelPos)
  })

  svgClusters.selectAll('rect').each(function (c) {
    const node = g.node(c)
    const domCluster = d3.select(this)
    util.applyStyle(domCluster, node.style)
  })

  util.applyTransition(svgClusters.exit(), g)
    .style('opacity', 0)
    .remove()

  return svgClusters
}

export default createClusters
