# gitbook-plugin-graph

This plugin is a very thin wrapper around [function-plot](http://maurizzzio.github.io/function-plot/).

To use this plugin within gitbook you must simply add the plugin to your `book.json`:

`"plugins": ["graph"]`

And then you can add graphs within your pages like so:
 
    {% graph %}
        {
            "title":"cos(2*PI*x/2)*(1+0.5cos(2*PI*x/100))",     
            "grid":true,
            "xAxis": {
                "label":"Sample",
                "domain": [0,300]
            },
            "yAxis": {
                "label":"Amplitude",
                "domain": [-1.5,1.5]
            },
            "data": [
                { "fn": "cos(2*PI*x/2)*(1+0.5cos(2*PI*x/100))"},         
                { "fn": "(1+0.5cos(2*PI*x/100))"}
            ]
        }
    {% endgraph %}

Inside the `{% graph %}` tags you just need to place valid JSON that can be passed in as the [function-plot options](https://github.com/maurizzzio/function-plot/#instance--functionplotoptions)


## Future Work

function-plot is a browser only library and is not compatible with being used within node.  So ebook rendering at this point won't be possible.  I'm sure there are ways around it using something like phantom, but for now I've taken the naiive approach and made it work within the browser.