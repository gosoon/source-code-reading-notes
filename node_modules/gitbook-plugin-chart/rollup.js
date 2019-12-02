var rollup = require( 'rollup' );
var babel = require('rollup-plugin-babel');

rollup.rollup({
  // 入口文件
  input: 'src/index.js',
  plugins: [
    babel({
      exclude: 'node_modules/**',
    }),
  ]
}).then( function ( bundle ) {
  console.log('build: ' + new Date());
  // CommonJS
  bundle.write({
    format: 'cjs',
    file: 'index.js'
  });
}).catch(function (e) {
  console.log(e);
});