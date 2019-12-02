'use strict';

const fs = require('fs');
const csvSync = require('csv-parse/lib/sync');
const parse = require('csv-parse/lib/sync');
const path = require('path');
const url = require('url');
const iconv = require('iconv-lite');

function buildTable(csvData, useHeader, exHeaders) {
    let html = "<table>";
    if (!useHeader && exHeaders != null) {
        let th = exHeaders.split(',');
        if (th.length !== csvData[0].length) throw new Error("invalid data in exHeaders.");
        html += "<tr>";
        html += th.map((col) => "<th>"+col+"</th>" ).join('');
        html += "</tr>";
    }
    for(let i=0; i<csvData.length; i++) {
        if (useHeader && i==0) {
            html += "<tr>";
            html += csvData[i].map((col) => "<th>"+col+"</th>" ).join('');
            html += "</tr>";
            continue;
        }
        html += "<tr>";
        html += csvData[i].map((col) => "<td>"+col+"</td>" ).join('');
        html += "</tr>";
    }
    html += "</table>";
    return html;
}

const DEF_ENCODE = "utf-8";

module.exports = {
    blocks: {
        includeCsv: {
            process: function(blk) {
                const tagBody = blk.body;
                const tagSrc = blk.kwargs.src;
                const useHeader = blk.kwargs.useHeader || false;
                const encoding = blk.kwargs.encoding || null;
                const exHeaders = blk.kwargs.exHeaders || null;
                const limit = blk.kwargs.limit || Infinity;
                let csvData = null;
                let relativeSrcPath = null;
                
                if (tagSrc) { // contents from file
                    const ctxFilePath = (this.ctx.file || {}).path || this.ctx.ctx.file.path || null;
                    const bookRootPath = this.book.root || this.output.root();
                    relativeSrcPath = url.resolve(ctxFilePath, tagSrc);
                    let filePath = decodeURI(path.resolve(bookRootPath, relativeSrcPath));
                    let data = fs.readFileSync(filePath);
                    // support various encodings
                    if (encoding) {
                        data = iconv.decode(data, encoding);
                    }
                    csvData = csvSync(data);
                } else { // contents from tag body¥
                    csvData = parse(tagBody, {skip_empty_lines: true});
                }
                if (limit != Infinity) {
                    csvData = csvData.slice(0, limit);
                }
                let table = buildTable(csvData, useHeader, exHeaders); // build table html tags
                if (tagSrc) {
                    table = "<a href=\"/" + relativeSrcPath + "\" target=\"_blank\">" + tagSrc + "</a>" + table;
                }
                return table;
            }
        }
    }
};
