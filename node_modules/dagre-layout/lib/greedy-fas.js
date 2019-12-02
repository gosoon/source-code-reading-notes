import _ from 'lodash'
import { Graph } from 'graphlibrary'

import List from './data/list'

/*
 * A greedy heuristic for finding a feedback arc set for a graph. A feedback
 * arc set is a set of edges that can be removed to make a graph acyclic.
 * The algorithm comes from: P. Eades, X. Lin, and W. F. Smyth, "A fast and
 * effective heuristic for the feedback arc set problem." This implementation
 * adjusts that from the paper to allow for weighted edges.
 */

const DEFAULT_WEIGHT_FN = _.constant(1)

function greedyFAS (g, weightFn) {
  if (g.nodeCount() <= 1) {
    return []
  }
  const state = buildState(g, weightFn || DEFAULT_WEIGHT_FN)
  const results = doGreedyFAS(state.graph, state.buckets, state.zeroIdx)

  // Expand multi-edges
  return _.flatten(_.map(results, function (e) {
    return g.outEdges(e.v, e.w)
  }), true)
}

function doGreedyFAS (g, buckets, zeroIdx) {
  let results = []
  const sources = buckets[buckets.length - 1]
  const sinks = buckets[0]

  let entry
  while (g.nodeCount()) {
    while ((entry = sinks.dequeue())) { removeNode(g, buckets, zeroIdx, entry) }
    while ((entry = sources.dequeue())) { removeNode(g, buckets, zeroIdx, entry) }
    if (g.nodeCount()) {
      for (let i = buckets.length - 2; i > 0; --i) {
        entry = buckets[i].dequeue()
        if (entry) {
          results = results.concat(removeNode(g, buckets, zeroIdx, entry, true))
          break
        }
      }
    }
  }

  return results
}

function removeNode (g, buckets, zeroIdx, entry, collectPredecessors) {
  const results = collectPredecessors ? [] : undefined

  _.forEach(g.inEdges(entry.v), function (edge) {
    const weight = g.edge(edge)
    const uEntry = g.node(edge.v)

    if (collectPredecessors) {
      results.push({ v: edge.v, w: edge.w })
    }

    uEntry.out -= weight
    assignBucket(buckets, zeroIdx, uEntry)
  })

  _.forEach(g.outEdges(entry.v), function (edge) {
    const weight = g.edge(edge)
    const w = edge.w
    const wEntry = g.node(w)
    wEntry['in'] -= weight
    assignBucket(buckets, zeroIdx, wEntry)
  })

  g.removeNode(entry.v)

  return results
}

function buildState (g, weightFn) {
  const fasGraph = new Graph()
  let maxIn = 0
  let maxOut = 0

  _.forEach(g.nodes(), function (v) {
    fasGraph.setNode(v, { v: v, 'in': 0, out: 0 })
  })

  // Aggregate weights on nodes, but also sum the weights across multi-edges
  // into a single edge for the fasGraph.
  _.forEach(g.edges(), function (e) {
    const prevWeight = fasGraph.edge(e.v, e.w) || 0
    const weight = weightFn(e)
    const edgeWeight = prevWeight + weight
    fasGraph.setEdge(e.v, e.w, edgeWeight)
    maxOut = Math.max(maxOut, fasGraph.node(e.v).out += weight)
    maxIn = Math.max(maxIn, fasGraph.node(e.w)['in'] += weight)
  })

  const buckets = _.range(maxOut + maxIn + 3).map(function () { return new List() })
  const zeroIdx = maxIn + 1

  _.forEach(fasGraph.nodes(), function (v) {
    assignBucket(buckets, zeroIdx, fasGraph.node(v))
  })

  return { graph: fasGraph, buckets: buckets, zeroIdx: zeroIdx }
}

function assignBucket (buckets, zeroIdx, entry) {
  if (!entry.out) {
    buckets[0].enqueue(entry)
  } else if (!entry['in']) {
    buckets[buckets.length - 1].enqueue(entry)
  } else {
    buckets[entry.out - entry['in'] + zeroIdx].enqueue(entry)
  }
}

export default greedyFAS
