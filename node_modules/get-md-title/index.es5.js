'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _commonmarkHelpers = require('commonmark-helpers');

var _trimHtmlTag = require('trim-html-tag');

var _trimHtmlTag2 = _interopRequireDefault(_trimHtmlTag);

var isTitle = function isTitle(node) {
  return (0, _commonmarkHelpers.isHeader)(node) && (0, _commonmarkHelpers.isLevel)(node, 1);
};

exports['default'] = function (input) {
  var node = (0, _commonmarkHelpers.match)(input, isTitle);
  if (!node) return;
  return {
    text: (0, _commonmarkHelpers.text)(node),
    html: (0, _trimHtmlTag2['default'])((0, _commonmarkHelpers.html)(node)),
    node: node
  };
};

module.exports = exports['default'];

