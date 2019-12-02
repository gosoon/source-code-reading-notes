'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});
exports['default'] = trimHtmlTag;

var _ramda = require('ramda');

var reg = /<([\S]{1,})[^>]*>([^\3]*)(<\/\1>)/gim;

function trimHtmlTag(input) {
  if (!input) return;
  var regexpResult = new RegExp(reg).exec((0, _ramda.trim)(input));
  return regexpResult ? (0, _ramda.trim)(regexpResult[2]) : (0, _ramda.trim)(input);
}

;
module.exports = exports['default'];

