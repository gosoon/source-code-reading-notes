import util from '../util'

/*
 * Attaches a text label to the specified root. Handles escape sequences.
 */
function addTextLabel (root, node) {
  const domNode = root.append('text')

  const lines = processEscapeSequences(node.label).split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    domNode
      .append('tspan')
        .attr('xml:space', 'preserve')
        .attr('dy', '1em')
        .attr('x', '1')
        .text(lines[i])
  }

  util.applyStyle(domNode, node.labelStyle)

  return domNode
}

function processEscapeSequences (text) {
  let newText = ''
  let escaped = false
  let ch = null
  for (let i = 0; i < text.length; i += 1) {
    ch = text[i]
    if (escaped) {
      switch (ch) {
        case 'n': newText += '\n'; break
        default: newText += ch
      }
      escaped = false
    } else if (ch === '\\') {
      escaped = true
    } else {
      newText += ch
    }
  }
  return newText
}

export default addTextLabel
