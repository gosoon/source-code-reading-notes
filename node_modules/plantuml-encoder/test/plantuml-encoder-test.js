/* global describe it */
var chai = require('chai')
var plantumlEncoder = require('../lib/plantuml-encoder')

var expect = chai.expect

describe('plantuml-encoder', function () {
  describe('#encode()', function () {
    it('should encode "A -> B: Hello"', function () {
      var encoded = plantumlEncoder.encode('A -> B: Hello')
      expect(encoded).to.equal('UDfpLD2rKt2oKl18pSd91m0KGWDz')
    })
  })
})
