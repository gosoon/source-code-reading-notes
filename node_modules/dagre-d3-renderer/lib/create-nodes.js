import _ from 'lodash'
import d3 from 'd3'

import addLabel from './label/add-label'
import util from './util'

function createNodes (selection, g, shapes) {
  const simpleNodes = g.nodes().filter(function (v) { return !util.isSubgraph(g, v) })
  const svgNodes = selection.selectAll('g.node')
    .data(simpleNodes, function (v) { return v })
    .classed('update', true)

  svgNodes.selectAll('*').remove()
  svgNodes.enter()
    .append('g')
      .attr('class', 'node')
      .style('opacity', 0)
  svgNodes.each(function (v) {
    const node = g.node(v)
    const thisGroup = d3.select(this)
    const labelGroup = thisGroup.append('g').attr('class', 'label')
    const labelDom = addLabel(labelGroup, node)
    const shape = shapes[node.shape]
    const bbox = _.pick(labelDom.node().getBBox(), 'width', 'height')

    node.elem = this

    if (node.id) { thisGroup.attr('id', node.id) }
    if (node.labelId) { labelGroup.attr('id', node.labelId) }
    util.applyClass(thisGroup, node['class'],
      (thisGroup.classed('update') ? 'update ' : '') + 'node')

    if (_.has(node, 'width')) { bbox.width = node.width }
    if (_.has(node, 'height')) { bbox.height = node.height }

    bbox.width += node.paddingLeft + node.paddingRight
    bbox.height += node.paddingTop + node.paddingBottom
    labelGroup.attr('transform', 'translate(' +
      ((node.paddingLeft - node.paddingRight) / 2) + ',' +
      ((node.paddingTop - node.paddingBottom) / 2) + ')')

    const shapeSvg = shape(d3.select(this), bbox, node)
    util.applyStyle(shapeSvg, node.style)

    const shapeBBox = shapeSvg.node().getBBox()
    node.width = shapeBBox.width
    node.height = shapeBBox.height
  })

  util.applyTransition(svgNodes.exit(), g)
    .style('opacity', 0)
    .remove()

  return svgNodes
}

export default createNodes
