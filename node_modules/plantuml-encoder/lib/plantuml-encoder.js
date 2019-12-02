'use strict'

var pakoDeflate = require('pako/lib/deflate.js')
var encode64 = require('./encode64')

// 1. Encode in UTF-8
// 2. Compress using Deflate algorithm
// 3. Reencode using a transformation close to base64

module.exports.encode = function (text) {
  var utf8 = unescape(encodeURIComponent(text))
  var deflated = pakoDeflate.deflate(utf8, { level: 9, to: 'string' })
  return encode64.encode(deflated)
}

// Deprecated, might be removed in future releases
module.exports.encodeSync = function (text) {
  return module.exports.encode(text)
}
