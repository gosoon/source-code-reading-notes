import path from 'path'
import nodeExternals from 'webpack-node-externals'

const config = {
  target: 'web',
  entry: {
    'dagre-d3': './index.js'
  },
  output: {
    path: path.join(__dirname, 'dist'),
    filename: '[name].js',
    library: 'dagreD3',
    libraryTarget: 'umd',
    libraryExport: 'default'
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader'
        }
      }
    ]
  },
  devtool: 'source-map'
}

const coreConfig = {
  target: 'node',
  externals: [nodeExternals()],
  entry: {
    'dagre-d3': './index.js'
  },
  output: {
    path: path.join(__dirname, 'dist'),
    filename: '[name].core.js',
    libraryTarget: 'commonjs2'
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader'
        }
      }
    ]
  },
  devtool: 'source-map'
}

export default [config, coreConfig]
