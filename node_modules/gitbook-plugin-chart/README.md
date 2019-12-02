# gitbook-plugin-chart

Using [C3.js](http://c3js.org/) or [Highcharts](http://www.highcharts.com/) chart library in Gitbook.

## Config

### Chart Library

Config in `book.json`:

```json
{
  "plugins": [ "chart" ],
  "pluginsConfig": {
      "chart": {
          "type": "highcharts"
      }
  }
}
```

`type` can be `c3` or `highcharts`, default to `c3`.

## Usage

Insert block in your markdown file.

**Caution**: the content of the blocks should be written in pure JSON. That is, each property should be quoted, and you should strictly use double quotes `"`, not single quotes `'`:
```JSON
// Invalid JSON
{
    data: {
        type: 'bar'
    }
}

// Valid JSON
{
    "data": {
        "type": "bar"
    }
}
```

See the examples below.

### Example for [C3.js](http://c3js.org/)

You **SHOULD NOT** specify the `bindto` property for the chart.

```
{% chart %}
{
    "data": {
        "type": "bar",
        "columns": [
            ["data1", 30, 200, 100, 400, 150, 1500, 2500],
            ["data2", 50, 100, 300, 450, 650, 250, 1320]
        ]
    },
    "axis": {
        "y": {
            "tick": {
                "format": d3.format("$,")
            }
        }
    }
}
{% endchart %}
```

Getting Start with [C3.js](http://c3js.org/gettingstarted.html#customize).

### Example for C3.js in [YAML](http://yaml.org/)

```
{% chart format="yaml" %}
data:
    type: bar
    columns:
        - [data1, 30, 200, 100, 400, 150, 250]
        - [data2, 50, 20, 10, 40, 15, 25]
    axes:
        data2: y2
axis:
    y2:
        show: true
{% endchart %}
```

### Example for [Highcharts](http://www.highcharts.com/)

You **SHOULD NOT** specify the `renderTo` property for the chart.

```
{% chart %}
{
    "chart": {
        "type": "bar"
    },
    "title": {
        "text": "Fruit Consumption"
    },
    "xAxis": {
        "categories": ["Apples", "Bananas", "Oranges"]
    },
    "yAxis": {
        "title": {
            "text": "Fruit eaten"
        }
    },
    "series": [{
        "name": "Jane",
        "data": [1, 0, 4]
    }, {
        "name": "John",
        "data": [5, 7, 3]
    }]
}
{% endchart %}
```

Getting Start with [Highcharts](http://www.highcharts.com/docs/getting-started/your-first-chart).

## Development

Learn more about [Gitbook Plugin](https://toolchain.gitbook.com/plugins/testing.html)

### Prepare

Testing your plugin on your book before publishing it is possible using npm link.

In the plugin's folder, run:

```
npm link
```

Then in the _test_ folder:

```
npm link gitbook-plugin-chart
```

### Start

In the plugin's folder, run:

```
npm run dev
```

Then in the _test_ folder:

```
npm start
```

