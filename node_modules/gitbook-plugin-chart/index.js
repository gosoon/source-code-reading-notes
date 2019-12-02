'use strict';

var _uuidCounter = 0;
function uuid() {
  return "plugin-chart-".concat(++_uuidCounter);
}

function c3(id, bodyString) {
  // bind to element
  // body.bindto = '#' + id;
  bodyString = bodyString.replace(/^\{/, "{\"bindto\":\"#".concat(id, "\","));
  return "c3.generate(".concat(bodyString, ");");
}
function highcharts(id, bodyString) {
  try {
    var body = JSON.parse(bodyString); // http://www.highcharts.com/docs/getting-started/your-first-chart

    body.chart = body.chart || {};
    body.chart.renderTo = id;
    return "new Highcharts.Chart(".concat(JSON.stringify(body), ");");
  } catch (e) {
    console.error(e);
  }
}

var chartFns = /*#__PURE__*/Object.freeze({
    c3: c3,
    highcharts: highcharts
});

var FORMAT_YAML = 'yaml';

var chartScriptFn = function chartScriptFn() {};

module.exports = {
  book: {
    assets: './assets'
  },
  hooks: {
    init: function init() {
      var _this$config$get = this.config.get('pluginsConfig.chart'),
          type = _this$config$get.type;

      chartScriptFn = chartFns[type];
    },
    "page:before": function pageBefore(page) {
      // Get all code texts
      var flows = page.content.match(/^```chart((.*\n)+?)?```$/igm); // Begin replace

      if (flows instanceof Array) {
        for (var i = 0, len = flows.length; i < len; i++) {
          page.content = page.content.replace(flows[i], flows[i].replace(/^```chart/, '{% chart %}').replace(/```$/, '{% endchart %}'));
        }
      }

      return page;
    }
  },
  blocks: {
    chart: {
      process: function process(blk) {
        var id = uuid();
        var body = '';

        try {
          // get string in {% chart %}
          var bodyString = blk.body.trim();

          if (blk.kwargs.format === FORMAT_YAML) {
            // load yaml into body:
            body = JSON.stringify(require('js-yaml').safeLoad(bodyString));
          } else {
            // this is pure JSON
            body = bodyString;
          }
        } catch (e) {
          console.error(e);
        }

        var scripts = chartScriptFn(id, body);
        return "<div>\n                    <div id=\"".concat(id, "\"></div>\n                    <script>").concat(scripts, "</script>\n                </div>");
      }
    }
  }
};
