const d3 = window.d3
const bodyElem = d3.select('body')
const jsElem = d3.select('#js')
const jsPanel = bodyElem.append('div').attr('id', 'jsPanel')
const cssElem = d3.select('#css')
const cssPanel = bodyElem.append('div').attr('id', 'cssPanel')

function setupPanel (panel, elem, title) {
  panel.append('h2').text(title)
  return panel.append('pre').append('code').text(elem.html().trim())
}

const jsCode = setupPanel(jsPanel, jsElem, 'JavaScript')
const cssCode = setupPanel(cssPanel, cssElem, 'CSS')

const hljsRoot = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/9.12.0'

bodyElem.append('link')
  .attr('rel', 'stylesheet')
  .attr('href', hljsRoot + '/styles/xcode.min.css')
bodyElem.append('script')
  .attr('src', hljsRoot + '/highlight.min.js')
  .on('load', function () {
    window.hljs.highlightBlock(jsCode.node())
    window.hljs.highlightBlock(cssCode.node())
  })
