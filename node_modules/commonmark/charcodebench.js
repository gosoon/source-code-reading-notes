"use strict";

var Benchmark = require('benchmark').Benchmark;
var fs = require('fs');
var contents = fs.readFileSync('README.md', 'utf8');

var suite = new Benchmark.Suite();
suite.add('charAt', function() {
    var z = 0;
    for (var i = 0; i < contents.length; i++) {
        if (contents.charAt(i) === '\n') {
            z++;
        }
    }
})

.add('charCodeAt', function() {
    var z = 0;
    for (var i = 0; i < contents.length; i++) {
        if (contents.charCodeAt(i) === 10) {
            z++;
        }
    }
})

.on('cycle', function(event) {
  console.log(String(event.target));
})
.run();
