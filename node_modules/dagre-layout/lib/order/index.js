import _ from 'lodash'
import { Graph } from 'graphlibrary'

import initOrder from './init-order'
import crossCount from './cross-count'
import sortSubgraph from './sort-subgraph'
import buildLayerGraph from './build-layer-graph'
import addSubgraphConstraints from './add-subgraph-constraints'
import util from '../util'

/*
 * Applies heuristics to minimize edge crossings in the graph and sets the best
 * order solution as an order attribute on each node.
 *
 * Pre-conditions:
 *
 *    1. Graph must be DAG
 *    2. Graph nodes must be objects with a "rank" attribute
 *    3. Graph edges must have the "weight" attribute
 *
 * Post-conditions:
 *
 *    1. Graph nodes will have an "order" attribute based on the results of the
 *       algorithm.
 */
function order (g) {
  const maxRank = util.maxRank(g)
  const downLayerGraphs = buildLayerGraphs(g, _.range(1, maxRank + 1), 'inEdges')
  const upLayerGraphs = buildLayerGraphs(g, _.range(maxRank - 1, -1, -1), 'outEdges')

  let layering = initOrder(g)
  assignOrder(g, layering)

  let bestCC = Number.POSITIVE_INFINITY
  let best

  for (let i = 0, lastBest = 0; lastBest < 4; ++i, ++lastBest) {
    sweepLayerGraphs(i % 2 ? downLayerGraphs : upLayerGraphs, i % 4 >= 2)

    layering = util.buildLayerMatrix(g)
    const cc = crossCount(g, layering)
    if (cc < bestCC) {
      lastBest = 0
      best = _.cloneDeep(layering)
      bestCC = cc
    }
  }

  assignOrder(g, best)
}

function buildLayerGraphs (g, ranks, relationship) {
  return _.map(ranks, function (rank) {
    return buildLayerGraph(g, rank, relationship)
  })
}

function sweepLayerGraphs (layerGraphs, biasRight) {
  const cg = new Graph()
  _.forEach(layerGraphs, function (lg) {
    const root = lg.graph().root
    const sorted = sortSubgraph(lg, root, cg, biasRight)
    _.forEach(sorted.vs, function (v, i) {
      lg.node(v).order = i
    })
    addSubgraphConstraints(lg, cg, sorted.vs)
  })
}

function assignOrder (g, layering) {
  _.forEach(layering, function (layer) {
    _.forEach(layer, function (v, i) {
      g.node(v).order = i
    })
  })
}

export default order
