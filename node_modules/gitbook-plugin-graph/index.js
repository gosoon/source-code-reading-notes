"use strict";
let _uuidCounter = 0;
function uuid() {
    let id = _uuidCounter++;
    return "plugin-graph-"+id;
};

module.exports = {
    book: {
        assets: "./assets",
        js: [ ],
        css: [ ]
    },
    blocks: {
        graph: {
            process: function(blk) {
                let id = uuid();
                let bodyString = blk.body.trim();
                let options = {};                 
                try{
                    options = JSON.parse(bodyString);                    
                    options.target = `#${id}`;

                    let scripts = `functionPlot(${JSON.stringify(options)});`

                    let html = `<div>
                        <span id="${id}"></span>
                        <script>${scripts}</script>
                    </div>`;
                    return html;
                }catch(e){                    
                    return "JSON Error: <pre>"+ e+"</pre>";
                }                             
            }
        }
    }
};
