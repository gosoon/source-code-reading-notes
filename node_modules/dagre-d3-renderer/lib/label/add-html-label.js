import util from '../util'

function addHtmlLabel (root, node) {
  const fo = root
    .append('foreignObject')
      .attr('width', '100000')

  const div = fo
    .append('xhtml:div')
  div.attr('xmlns', 'http://www.w3.org/1999/xhtml')

  const label = node.label
  switch (typeof label) {
    case 'function':
      div.insert(label)
      break
    case 'object':
      // Currently we assume this is a DOM object.
      div.insert(function () { return label })
      break
    default: div.html(label)
  }

  util.applyStyle(div, node.labelStyle)
  div.style('display', 'inline-block')
  // Fix for firefox
  div.style('white-space', 'nowrap')

  const client = div[0][0].getBoundingClientRect()
  fo
    .attr('width', client.width)
    .attr('height', client.height)

  return fo
}

export default addHtmlLabel
