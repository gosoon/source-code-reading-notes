import _ from 'lodash'
import { layout } from 'dagre-layout'

import positionNodes from './position-nodes'
import positionEdgeLabels from './position-edge-labels'
import positionClusters from './position-clusters'
import createNodes from './create-nodes'
import createClusters from './create-clusters'
import createEdgeLabels from './create-edge-labels'
import createEdgePaths from './create-edge-paths'
import shapes from './shapes'
import arrows from './arrows'

// This design is based on http://bost.ocks.org/mike/chart/.
function render () {
  let _createNodes = createNodes
  let _createClusters = createClusters
  let _createEdgeLabels = createEdgeLabels
  let _createEdgePaths = createEdgePaths
  let _shapes = shapes
  let _arrows = arrows

  const fn = function (svg, g) {
    preProcessGraph(g)

    const outputGroup = createOrSelectGroup(svg, 'output')
    const clustersGroup = createOrSelectGroup(outputGroup, 'clusters')
    const edgePathsGroup = createOrSelectGroup(outputGroup, 'edgePaths')
    const edgeLabels = _createEdgeLabels(createOrSelectGroup(outputGroup, 'edgeLabels'), g)
    const nodes = _createNodes(createOrSelectGroup(outputGroup, 'nodes'), g, _shapes)

    layout(g)

    positionNodes(nodes, g)
    positionEdgeLabels(edgeLabels, g)
    _createEdgePaths(edgePathsGroup, g, _arrows)

    const clusters = _createClusters(clustersGroup, g)
    positionClusters(clusters, g)

    postProcessGraph(g)
  }

  fn.createNodes = function (value) {
    if (!arguments.length) {
      return _createNodes
    }
    _createNodes = value
    return fn
  }

  fn.createClusters = function (value) {
    if (!arguments.length) {
      return _createClusters
    }
    _createClusters = value
    return fn
  }

  fn.createEdgeLabels = function (value) {
    if (!arguments.length) {
      return _createEdgeLabels
    }
    _createEdgeLabels = value
    return fn
  }

  fn.createEdgePaths = function (value) {
    if (!arguments.length) {
      return _createEdgePaths
    }
    _createEdgePaths = value
    return fn
  }

  fn.shapes = function (value) {
    if (!arguments.length) {
      return _shapes
    }
    _shapes = value
    return fn
  }

  fn.arrows = function (value) {
    if (!arguments.length) {
      return _arrows
    }
    _arrows = value
    return fn
  }

  return fn
}

const NODE_DEFAULT_ATTRS = {
  paddingLeft: 10,
  paddingRight: 10,
  paddingTop: 10,
  paddingBottom: 10,
  rx: 0,
  ry: 0,
  shape: 'rect'
}

const EDGE_DEFAULT_ATTRS = {
  arrowhead: 'normal',
  lineInterpolate: 'linear'
}

function preProcessGraph (g) {
  g.nodes().forEach(function (v) {
    const node = g.node(v)
    if (!_.has(node, 'label') && !g.children(v).length) { node.label = v }

    if (_.has(node, 'paddingX')) {
      _.defaults(node, {
        paddingLeft: node.paddingX,
        paddingRight: node.paddingX
      })
    }

    if (_.has(node, 'paddingY')) {
      _.defaults(node, {
        paddingTop: node.paddingY,
        paddingBottom: node.paddingY
      })
    }

    if (_.has(node, 'padding')) {
      _.defaults(node, {
        paddingLeft: node.padding,
        paddingRight: node.padding,
        paddingTop: node.padding,
        paddingBottom: node.padding
      })
    }

    _.defaults(node, NODE_DEFAULT_ATTRS)

    _.each(['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'], function (k) {
      node[k] = Number(node[k])
    })

    // Save dimensions for restore during post-processing
    if (_.has(node, 'width')) { node._prevWidth = node.width }
    if (_.has(node, 'height')) { node._prevHeight = node.height }
  })

  g.edges().forEach(function (e) {
    const edge = g.edge(e)
    if (!_.has(edge, 'label')) { edge.label = '' }
    _.defaults(edge, EDGE_DEFAULT_ATTRS)
  })
}

function postProcessGraph (g) {
  _.each(g.nodes(), function (v) {
    const node = g.node(v)

    // Restore original dimensions
    if (_.has(node, '_prevWidth')) {
      node.width = node._prevWidth
    } else {
      delete node.width
    }

    if (_.has(node, '_prevHeight')) {
      node.height = node._prevHeight
    } else {
      delete node.height
    }

    delete node._prevWidth
    delete node._prevHeight
  })
}

function createOrSelectGroup (root, name) {
  let selection = root.select('g.' + name)
  if (selection.empty()) {
    selection = root.append('g').attr('class', name)
  }
  return selection
}

export default render
